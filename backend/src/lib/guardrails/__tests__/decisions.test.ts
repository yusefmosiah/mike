import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyToolCall } from "../classifier";
import {
  DEFAULT_GATE_POLICY,
  GATE_QUESTION_IDS,
  askGateQuestions,
  canServeGate,
  decideToolCall,
  decisionModelCatalog,
  resetDecisionCatalogForTests,
  scoreGate,
  type GateAnswers,
} from "../decisions";

/** A call nobody would object to: asked for, named, no risk anywhere. */
function benign(overrides: Partial<GateAnswers> = {}): GateAnswers {
  const answers = Object.fromEntries(GATE_QUESTION_IDS.map((id) => [id, 0.02])) as GateAnswers;
  return { ...answers, user_asked_for_action: 0.97, user_named_target: 0.95, ...overrides };
}

const STATE = {
  user_request: "Delete Linear issue LEG-412, it's a duplicate.",
  tool: "mcp_linear_delete_issue_3f9a1c2e",
  arguments: { issue_id: "LEG-412" },
  tools_already_used: [],
};

function decisionsReply(answers: Record<string, number>, status = 200) {
  return new Response(
    JSON.stringify({
      answers: Object.fromEntries(Object.entries(answers).map(([id, p]) => [id, { type: "noul", noul: p }])),
      usage: { input_tokens: 1800, output_tokens: 40, cost: 0.00008 },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetDecisionCatalogForTests();
});

describe("scoreGate", () => {
  it("allows a requested call with no marked risk", () => {
    expect(scoreGate(benign()).outcome).toBe("allow");
  });

  it("does not let one jumpy answer block: many_items alone is not a risk", () => {
    // A web search "chooses its items by a query"; that matters only with deletion.
    expect(scoreGate(benign({ many_items: 0.9, leaves_workspace: 0.97 })).outcome).toBe("allow");
  });

  it("needs both halves of a leak: leaving the workspace and confidential content", () => {
    expect(scoreGate(benign({ leaves_workspace: 0.97, user_named_target: 0.2 })).outcome).toBe("allow");
    const leak = scoreGate(benign({ leaves_workspace: 0.97, confidential_content: 0.9, user_named_target: 0.2 }));
    expect(leak.outcome).toBe("deny");
    expect(leak.triggered).toContain("data_leak");
  });

  it("lets the user's named go-ahead discount a deletion, and denies the same deletion unasked", () => {
    expect(scoreGate(benign({ deletes_data: 0.98, cannot_undo: 0.6 })).outcome).toBe("allow");
    const unasked = scoreGate(benign({ deletes_data: 0.98, user_asked_for_action: 0.1, user_named_target: 0.1 }));
    expect(unasked.outcome).toBe("deny");
    expect(unasked.triggered[0]).toBe("destruction");
  });

  it("asks before a bulk deletion even when the user asked for it", () => {
    const bulk = scoreGate(benign({ deletes_data: 0.98, many_items: 0.95 }));
    expect(bulk.outcome).toBe("ask");
    expect(bulk.triggered).toContain("bulk_destruction");
  });

  it("never discounts a credential leaving the workspace, whatever the consent", () => {
    const leak = scoreGate(benign({ credential_in_args: 0.98, leaves_workspace: 0.97, user_asked_for_action: 1, user_named_target: 1 }));
    expect(leak.outcome).toBe("deny");
    expect(leak.triggered[0]).toBe("credential_leak");
  });

  it("denies instructions inside the arguments and improper conduct regardless of consent", () => {
    expect(scoreGate(benign({ instructions_in_args: 0.8 })).outcome).toBe("deny");
    expect(scoreGate(benign({ improper_conduct: 0.8 })).outcome).toBe("deny");
    expect(scoreGate(benign({ harms_others: 0.8 })).outcome).toBe("deny");
  });

  it("puts a middling soft risk in the ask band", () => {
    const middling = scoreGate(benign({ widens_access: 0.55, user_named_target: 0.3 }));
    expect(middling.outcome).toBe("ask");
  });

  it("takes its thresholds from the policy", () => {
    const answers = benign({ deletes_data: 0.6, user_asked_for_action: 0.1 });
    expect(scoreGate(answers, DEFAULT_GATE_POLICY).outcome).toBe("ask");
    expect(scoreGate(answers, { ...DEFAULT_GATE_POLICY, askAt: 0.7, denyAt: 0.9 }).outcome).toBe("allow");
  });
});

describe("decideToolCall", () => {
  it("sends every question in one request with training denied, and allows a benign answer", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => decisionsReply(benign({ deletes_data: 0.97 })));
    const result = await decideToolCall({ model: "openrouter-decisions/typesafe/jev-1.13", state: STATE, fetchImpl: fetchImpl as typeof fetch });

    expect(result).toMatchObject({ verdict: "allow", outcome: "allow", usage: { inputTokens: 1800, cost: 0.00008 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/alpha\/decisions$/);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.provider).toEqual({ data_collection: "deny" });
    expect(Object.keys(body.questions)).toEqual(GATE_QUESTION_IDS);
    expect(body.state).toEqual(STATE);
  });

  it("turns an ask into a denial that tells the agent to confirm with the user", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async () => decisionsReply(benign({ deletes_data: 0.98, many_items: 0.95 })));
    const result = await decideToolCall({ model: "typesafe/jev-1.13", state: STATE, fetchImpl: fetchImpl as typeof fetch });
    expect(result.verdict).toBe("deny");
    expect(result.outcome).toBe("ask");
    expect(result.reason).toMatch(/^confirm with the user first: /);
  });

  it("asks a one-question-per-request model each question separately", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const ids = Object.keys(JSON.parse(String(init.body)).questions);
      expect(ids).toHaveLength(1);
      return decisionsReply(Object.fromEntries(ids.map((id) => [id, benign()[id as keyof GateAnswers]])));
    });
    const asked = await askGateQuestions({ model: "togethercomputer/tev1-4b-experimental", state: STATE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(asked.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(GATE_QUESTION_IDS.length);
    if (asked.ok) expect(asked.usage.inputTokens).toBe(1800 * GATE_QUESTION_IDS.length);
  });

  it.each([
    ["a missing answer", async () => decisionsReply({ user_asked_for_action: 0.9 }), /unverifiable/],
    ["an out-of-range answer", async () => decisionsReply({ ...benign(), deletes_data: 1.4 }), /unverifiable/],
    ["a non-2xx reply", async () => decisionsReply(benign(), 502), /HTTP 502/],
    ["unreadable JSON", async () => new Response("<html>", { status: 200 }), /unreadable/],
    ["a network failure", async () => { throw new TypeError("fetch failed"); }, /unavailable/],
  ])("denies on %s", async (_name, reply, reason) => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const result = await decideToolCall({ model: "typesafe/jev-1.13", state: STATE, fetchImpl: vi.fn(reply) as unknown as typeof fetch });
    expect(result.verdict).toBe("deny");
    expect(result.reason).toMatch(reason);
  });

  it("denies on timeout", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    const result = await decideToolCall({ model: "typesafe/jev-1.13", state: STATE, timeoutMs: 20, fetchImpl: hang as unknown as typeof fetch });
    expect(result.verdict).toBe("deny");
    expect(result.reason).toMatch(/timed out after 20ms/);
  });

  it("denies without a call in strict private mode or without a key", async () => {
    const fetchImpl = vi.fn();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect((await decideToolCall({ model: "typesafe/jev-1.13", state: STATE, fetchImpl })).verdict).toBe("deny");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");
    const result = await decideToolCall({ model: "typesafe/jev-1.13", state: STATE, fetchImpl });
    expect(result).toMatchObject({ verdict: "deny", reason: "decision model unavailable here" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("classifyToolCall with a decision model", () => {
  it("judges a Tier 3 call with the decision gate instead of the completion classifier", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const fetchMock = vi.fn(async () => decisionsReply(benign({ credential_in_args: 0.98, leaves_workspace: 0.97 })));
    vi.stubGlobal("fetch", fetchMock);
    const completeFn = vi.fn();
    const result = await classifyToolCall({
      userIntent: "Why won't my login work? My password is hunter2.",
      toolName: "web_search",
      toolArgs: { query: "login invalid hunter2", keywords: ["login"] },
      decisionModel: "openrouter-decisions/typesafe/jev-1.13",
      completeFn,
    });
    expect(result).toMatchObject({ verdict: "deny", tier: 3 });
    expect(result.reason).toMatch(/password, key or token/);
    expect(completeFn).not.toHaveBeenCalled();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    // The secret in an ordinary value reaches the gate; `keywords` is not redacted.
    expect(body.state.arguments).toEqual({ query: "login invalid hunter2", keywords: ["login"] });
  });

  it("never reaches the decision model for Tier 1 reads", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await classifyToolCall({ userIntent: "x", toolName: "read_document", toolArgs: {}, decisionModel: "openrouter-decisions/typesafe/jev-1.13" });
    expect(result).toMatchObject({ verdict: "allow", tier: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decisionModelCatalog", () => {
  it("lists measured models within the latency budget, fastest first, with prices and open weights", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "perplexity/pplx-decider-v1.1-27b", name: "Decider", pricing: { prompt: "0.00000002" }, hugging_face_id: "perplexity-ai/pplx-decider-v1.1-27b" },
            { id: "typesafe/jev-1.13", name: "Jev", pricing: { prompt: "0.000000042" } },
            { id: "inception/mercury-decide:free", name: "Mercury (free)", pricing: { prompt: "0" } },
            { id: "respan/span-01", name: "Span", pricing: { prompt: "0.00000002" } },
            { id: "upstage/solar-decide-flash", name: "Solar Decide Flash", pricing: { prompt: "0.00000005" } },
            { id: "newco/decider-unbenchmarked", name: "New", pricing: { prompt: "0.00000001" } },
          ],
        }),
      ),
    );
    const options = await decisionModelCatalog(fetchImpl as unknown as typeof fetch);
    expect(options.map((o) => o.id)).toEqual(["typesafe/jev-1.13", "perplexity/pplx-decider-v1.1-27b"]);
    expect(options[1]).toMatchObject({
      value: "openrouter-decisions/perplexity/pplx-decider-v1.1-27b",
      openWeights: "perplexity-ai/pplx-decider-v1.1-27b",
      medianLatencyMs: 358,
    });
    expect(options[1].inputPricePerMillion).toBeCloseTo(0.02);
  });

  it("is empty in strict private mode", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");
    const fetchImpl = vi.fn();
    expect(await decisionModelCatalog(fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("knows which catalog entries can serve the gate", () => {
    expect(canServeGate("typesafe/jev-1.13")).toBe(true);
    expect(canServeGate("upstage/solar-decide")).toBe(false);
    expect(canServeGate("newco/decider-unbenchmarked")).toBe(false);
    expect(canServeGate("respan/span-01-lite")).toBe(false);
    expect(canServeGate("inception/mercury-decide:free")).toBe(false);
  });
});
