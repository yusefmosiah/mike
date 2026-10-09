import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskInputsEvent } from "@mike/contracts";

// Auto Mode is the unattended contract of the tool loop: nothing may pause for
// a user who is not there, and no call may reach a connector, the workspace or
// a document without passing the guardrails first. These tests pin the wiring
// in streaming.ts — which tier runs, which is refused as a tool RESULT the
// model can read (never a throw), and what a model-emitted ask_inputs call
// becomes when nobody can answer it.
//
// lib/guardrails is mocked: its policy and classifier have their own suite;
// this one is about how the loop USES them.

const { streamChatWithTools, runToolCalls, classifyToolCall, EMPTY_DISPATCH } =
  vi.hoisted(() => ({
    streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
      fullText: "",
    })),
    runToolCalls: vi.fn(async (_calls: { function: { name: string } }[]) =>
      EMPTY_DISPATCH(),
    ),
    classifyToolCall: vi.fn(
      async (
        _args: ClassifierArgs,
      ): Promise<{ verdict: "allow" | "deny"; reason: string }> => ({
        verdict: "allow",
        reason: "allowed",
      }),
    ),
    // The dispatcher's empty answer, as a factory so no test can hand the
    // loop a batch another test already consumed.
    EMPTY_DISPATCH: () => ({
      toolResults: [] as unknown[],
      docsRead: [] as unknown[],
      docsFound: [] as unknown[],
      docsCreated: [] as unknown[],
      docsReplicated: [] as unknown[],
      workflowsApplied: [] as unknown[],
      docsEdited: [] as unknown[],
      askInputsEvents: [] as unknown[],
      courtlistenerEvents: [] as unknown[],
      caseCitationEvents: [] as unknown[],
      mcpEvents: [] as unknown[],
    }),
  }));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

// Stand-in policy, matching the shipped tiers for the names these tests use:
// read_document is a read, edit_document is a document write, and everything
// else (connector writes, ask_inputs, unknown names) needs the classifier.
vi.mock("../../../../lib/guardrails", async () => ({
  // The prompt-injection flags are real; only the tier policy is stood in.
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/guardrails/injection")),
  tierForTool: (name: string | null | undefined) =>
    name === "read_document" ? 1 : name === "edit_document" ? 2 : 3,
  inScopeForContainer: (
    args: Record<string, unknown> | null | undefined,
    containerProjectId?: string | null,
  ) => {
    const target = args?.project_id;
    if (target === undefined || target === null || target === "") return true;
    return target === containerProjectId;
  },
  AUTO_MODE_SAFE_DEFAULTS: {
    choice: "first_option",
    multi_choice: "first_option",
    text: "",
    documents: "skip",
    approval: "deny",
  },
  classifyToolCall: (args: ClassifierArgs) => classifyToolCall(args),
}));

vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (calls: { function: { name: string } }[]) =>
    runToolCalls(calls),
}));

import { AssistantStreamError, runLLMStream } from "../streaming";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string }[]>;

// The mock stands in for llm.streamChatWithTools; declaring its parameter
// (rather than leaving the stub zero-arity) is what lets tsc check the
// `mock.calls[0][0]` lookups and the mockImplementation overrides below.
type StreamChatCall = {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools: { function: { name: string } }[];
  runTools?: RunToolsFn;
  [key: string]: unknown;
};

type ClassifierArgs = {
  userIntent: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  history: string[];
  model?: string;
};

type ToolCallInput = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

function baseParams() {
  return {
    // Validated inside runLLMStream, like every other caller's model.
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "Draft the NDA and email it" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    autoMode: true,
  };
}

function advertisedToolNames(): string[] {
  const params = streamChatWithTools.mock.calls[0]?.[0];
  return (params?.tools ?? []).map((tool) => tool.function.name);
}

function dispatchedToolNames(): string[] {
  const first = runToolCalls.mock.calls[0]?.[0];
  if (!first) return [];
  return (first as { function: { name: string } }[]).map(
    (call) => call.function.name,
  );
}

/**
 * Runs one tool batch through the stream and records what the loop handed
 * back to the model — plus whether the batch threw instead, which is the
 * failure mode Auto Mode must never produce for a refusal.
 */
function captureBatch(calls: ToolCallInput[]) {
  const capture: {
    threw: boolean;
    results?: { tool_use_id: string; content: string }[];
  } = { threw: false };
  streamChatWithTools.mockImplementationOnce(async (params: StreamChatCall) => {
    try {
      capture.results = await params.runTools?.(calls);
    } catch {
      capture.threw = true;
    }
    return { fullText: "" };
  });
  return capture;
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockReset();
  runToolCalls.mockReset();
  classifyToolCall.mockReset();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
  runToolCalls.mockResolvedValue(EMPTY_DISPATCH());
  classifyToolCall.mockResolvedValue({
    verdict: "allow",
    reason: "allowed",
  });
});

afterEach(() => {
  // Strict private mode is read from process.env per call; a leaked stub
  // would silently deny the model every later test in this file.
  vi.unstubAllEnvs();
});

describe("runLLMStream Auto Mode", () => {
  it("withholds ask_inputs from the advertised tools", async () => {
    await runLLMStream(baseParams());
    const names = advertisedToolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("ask_inputs");
  });

  it("keeps ask_inputs advertised when auto mode is off", async () => {
    await runLLMStream({ ...baseParams(), autoMode: false });
    expect(advertisedToolNames()).toContain("ask_inputs");
  });

  it("defaults off: a tier-3 call runs without consulting the classifier", async () => {
    const capture = captureBatch([
      { id: "call-a", name: "mcp_send_email", input: { to: "a@b.c" } },
    ]);

    await runLLMStream({ ...baseParams(), autoMode: false });

    expect(capture.threw).toBe(false);
    expect(classifyToolCall).not.toHaveBeenCalled();
    expect(dispatchedToolNames()).toEqual(["mcp_send_email"]);
  });

  it("runs a tier-1 read without consulting the classifier", async () => {
    const capture = captureBatch([
      { id: "call-a", name: "read_document", input: { doc_id: "doc-0" } },
    ]);

    await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    expect(classifyToolCall).not.toHaveBeenCalled();
    expect(dispatchedToolNames()).toEqual(["read_document"]);
  });

  it("runs a tier-2 write that stays inside the turn's container", async () => {
    const capture = captureBatch([
      {
        id: "call-a",
        name: "edit_document",
        input: { doc_id: "doc-0", project_id: "p1" },
      },
    ]);

    await runLLMStream({ ...baseParams(), projectId: "p1" });

    expect(capture.threw).toBe(false);
    expect(classifyToolCall).not.toHaveBeenCalled();
    expect(dispatchedToolNames()).toEqual(["edit_document"]);
  });

  it("returns a tier-2 denial as a tool result when document mutation is not allowed", async () => {
    const capture = captureBatch([
      { id: "call-a", name: "edit_document", input: { doc_id: "doc-0" } },
      { id: "call-b", name: "read_document", input: { doc_id: "doc-0" } },
    ]);

    const result = await runLLMStream({
      ...baseParams(),
      allowDocumentMutation: false,
    });

    // Deny-and-continue: the writer never reaches the dispatcher, the reader
    // still does, and the model is told why in-band.
    expect(capture.threw).toBe(false);
    expect(classifyToolCall).not.toHaveBeenCalled();
    expect(dispatchedToolNames()).toEqual(["read_document"]);
    expect(JSON.parse(capture.results![0]!.content)).toEqual({
      error:
        "Auto Mode guardrail denied edit_document: this conversation does not allow changing documents",
    });
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("refuses a tier-2 write that targets a container outside the turn", async () => {
    const capture = captureBatch([
      {
        id: "call-a",
        name: "edit_document",
        input: { doc_id: "doc-0", project_id: "other-project" },
      },
    ]);

    await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    expect(dispatchedToolNames()).toEqual([]);
    expect(JSON.parse(capture.results![0]!.content)).toEqual({
      error:
        "Auto Mode guardrail denied edit_document: the call targets a container outside this conversation",
    });
  });

  it("classifies a tier-3 call against the user's own words and runs it on allow", async () => {
    const capture = captureBatch([
      { id: "call-a", name: "mcp_send_email", input: { to: "a@b.c" } },
    ]);

    await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    expect(classifyToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        userIntent: "Draft the NDA and email it",
        toolName: "mcp_send_email",
        toolArgs: { to: "a@b.c" },
        history: [],
        model: "gemini-3-flash-preview",
      }),
    );
    expect(dispatchedToolNames()).toEqual(["mcp_send_email"]);
  });

  it("reads the intent from the last user message, joining its text parts", async () => {
    captureBatch([
      { id: "call-a", name: "mcp_send_email", input: { to: "a@b.c" } },
    ]);

    await runLLMStream({
      ...baseParams(),
      apiMessages: [
        { role: "user", content: "an older question" },
        { role: "assistant", content: "an older answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "first line" },
            { type: "image", image: "http://example.test/i.png" },
            { type: "text", text: "second line" },
          ],
        },
      ],
    });

    expect(classifyToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ userIntent: "first line\nsecond line" }),
    );
  });

  it("turns a tier-3 deny into an in-band result and keeps the turn alive", async () => {
    classifyToolCall.mockResolvedValueOnce({
      verdict: "deny",
      reason: "the user never asked to email anyone",
    });
    const capture = captureBatch([
      { id: "call-a", name: "mcp_send_email", input: { to: "a@b.c" } },
    ]);

    const result = await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    expect(dispatchedToolNames()).toEqual([]);
    expect(JSON.parse(capture.results![0]!.content)).toEqual({
      error:
        "Auto Mode guardrail denied mcp_send_email: the user never asked to email anyone",
    });
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ type: "mcp_tool_call" }),
    );
  });

  it("denies instead of throwing when the classifier itself fails", async () => {
    classifyToolCall.mockRejectedValueOnce(new Error("classifier exploded"));
    const capture = captureBatch([
      { id: "call-a", name: "mcp_send_email", input: {} },
    ]);

    const result = await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    expect(dispatchedToolNames()).toEqual([]);
    expect(JSON.parse(capture.results![0]!.content)).toEqual({
      error:
        "Auto Mode guardrail denied mcp_send_email: classifier unavailable",
    });
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("shows the classifier the tools already attempted this turn", async () => {
    const seenHistory: string[][] = [];
    classifyToolCall.mockImplementation(async (args: ClassifierArgs) => {
      seenHistory.push(args.history);
      return { verdict: "deny", reason: "not asked for" };
    });
    streamChatWithTools.mockImplementationOnce(
      async (params: StreamChatCall) => {
        await params.runTools?.([
          { id: "call-a", name: "mcp_send_email", input: {} },
        ]);
        await params.runTools?.([
          { id: "call-b", name: "mcp_post_slack", input: {} },
        ]);
        return { fullText: "" };
      },
    );

    await runLLMStream(baseParams());

    // A denied call still counts as attempted: the second call is judged
    // knowing the first was already refused.
    expect(seenHistory).toEqual([[], ["mcp_send_email"]]);
  });

  it("judges a round's calls at once, each seeing the calls before it", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = new Map<string, string[]>();
    classifyToolCall.mockImplementation(async (args: ClassifierArgs) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      seen.set(String(args.toolArgs.query), args.history);
      return args.toolArgs.query === "b"
        ? { verdict: "deny", reason: "it would send a password, key or token outside the workspace" }
        : { verdict: "allow", reason: "allowed" };
    });
    const capture = captureBatch([
      { id: "call-a", name: "web_search", input: { query: "a" } },
      { id: "call-b", name: "web_search", input: { query: "b" } },
      { id: "call-c", name: "fetch_web_page", input: { query: "c" } },
    ]);

    await runLLMStream(baseParams());

    expect(peak).toBe(3);
    expect(seen.get("a")).toEqual([]);
    expect(seen.get("b")).toEqual(["web_search"]);
    expect(seen.get("c")).toEqual(["web_search", "web_search"]);
    expect(dispatchedToolNames()).toEqual(["web_search", "fetch_web_page"]);
    const refused = capture.results?.find((result) => result.tool_use_id === "call-b");
    expect(refused?.content).toContain("Auto Mode guardrail denied web_search");
  });

  it("auto-answers a model-emitted ask_inputs call and records the exchange", async () => {
    const params = baseParams();
    const capture = captureBatch([
      {
        id: "call-a",
        name: "ask_inputs",
        input: {
          items: [
            {
              id: "q1",
              kind: "choice",
              question: "Governing law?",
              options: [{ value: "Singapore" }, { value: "England" }],
            },
            {
              id: "q2",
              kind: "multi_choice",
              question: "Which clauses?",
              options: [{ value: "Indemnity" }, { value: "Term" }],
            },
            { id: "q3", kind: "text", question: "Anything else?" },
            { id: "q4", kind: "documents", document_types: ["pdf"] },
          ],
        },
      },
    ]);

    const result = await runLLMStream(params);

    // The call is answered here: it is neither dispatched nor classified.
    expect(capture.threw).toBe(false);
    expect(dispatchedToolNames()).toEqual([]);
    expect(classifyToolCall).not.toHaveBeenCalled();

    const payload = JSON.parse(capture.results![0]!.content) as {
      auto_answered: boolean;
      responses: unknown[];
    };
    expect(payload.auto_answered).toBe(true);
    expect(payload.responses).toEqual([
      {
        id: "q1",
        kind: "choice",
        question: "Governing law?",
        answer: "Singapore",
      },
      {
        id: "q2",
        kind: "multi_choice",
        question: "Which clauses?",
        answers: ["Indemnity"],
      },
      { id: "q3", kind: "text", question: "Anything else?", answer: "" },
      { id: "q4", kind: "documents", filenames: [], skipped: true },
    ]);

    // The transcript shows the question and the answer it got, in order and
    // keyed by the same event id.
    const askIndex = result.events.findIndex(
      (event) => event.type === "ask_inputs",
    );
    expect(askIndex).toBeGreaterThanOrEqual(0);
    const askEvent = result.events[askIndex];
    const answerEvent = result.events[askIndex + 1];
    if (
      askEvent?.type !== "ask_inputs" ||
      answerEvent?.type !== "ask_inputs_response"
    ) {
      throw new Error("expected an ask_inputs event followed by its answer");
    }
    expect(answerEvent.ask_event_id).toBe(askEvent.event_id);
    expect(answerEvent.responses).toEqual(payload.responses);
    expect(askEvent.items.map((item) => item.kind)).toEqual([
      "choice",
      "multi_choice",
      "text",
      "documents",
    ]);
    const frames = params.write.mock.calls.map((call) => String(call[0]));
    expect(frames.some((frame) => frame.includes('"type":"ask_inputs"'))).toBe(
      true,
    );
    expect(
      frames.some((frame) => frame.includes('"type":"ask_inputs_response"')),
    ).toBe(true);
  });

  it("rejects an approval item a model-emitted ask_inputs call smuggled in", async () => {
    const capture = captureBatch([
      {
        id: "call-a",
        name: "ask_inputs",
        input: {
          items: [
            {
              id: "a1",
              kind: "approval",
              question: "Send the email?",
            },
            { id: "q1", kind: "text", question: "Anything else?" },
          ],
        },
      },
    ]);

    const result = await runLLMStream(baseParams());

    expect(capture.threw).toBe(false);
    const payload = JSON.parse(capture.results![0]!.content) as {
      message: string;
      responses: { kind: string; decision?: string }[];
    };
    expect(payload.responses).toEqual([
      { id: "a1", kind: "approval", decision: "reject" },
      { id: "q1", kind: "text", question: "Anything else?", answer: "" },
    ]);
    expect(payload.message).toContain("rejected the approval items");
    expect(dispatchedToolNames()).toEqual([]);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({ type: "mcp_tool_call" }),
    );
  });

  it("records a dispatcher ask_inputs event without pausing the turn", async () => {
    // A connector write that the user's own connector settings gate comes
    // back from the dispatcher as an approval item. Auto Mode streams and
    // records it — the user can still approve it from the transcript — but
    // must not park the run waiting for an answer.
    const approvalEvent = {
      type: "ask_inputs" as const,
      event_id: "ask-approval",
      items: [
        {
          id: "approval-1",
          kind: "approval" as const,
          connector_name: "Gmail",
          tool_name: "mcp_send_email",
          title: "Send email",
          arguments: { to: "a@b.c" },
          binding: { type: "mcp" as const, connector_id: "c1", tool_id: "t1" },
        },
      ],
    };
    runToolCalls.mockResolvedValueOnce({
      ...EMPTY_DISPATCH(),
      askInputsEvents: [approvalEvent],
    });
    const params = baseParams();
    const capture = captureBatch([
      { id: "call-a", name: "mcp_send_email", input: { to: "a@b.c" } },
    ]);

    const result = await runLLMStream(params);

    expect(capture.threw).toBe(false);
    expect(result.events).toContainEqual(approvalEvent);
    const frames = params.write.mock.calls.map((call) => String(call[0]));
    expect(
      frames.some((frame) => frame.includes('"event_id":"ask-approval"')),
    ).toBe(true);
  });

  it("still pauses on a dispatcher ask_inputs event when auto mode is off", async () => {
    const askEvent: AskInputsEvent = {
      type: "ask_inputs",
      event_id: "ask-1",
      items: [
        {
          id: "choice-1",
          kind: "choice",
          question: "Continue?",
          options: [{ value: "Yes" }],
          allow_other: false,
          other_label: "Other",
        },
      ],
    };
    runToolCalls.mockResolvedValueOnce({
      ...EMPTY_DISPATCH(),
      askInputsEvents: [askEvent],
    });
    const capture = captureBatch([
      { id: "call-a", name: "ask_inputs", input: {} },
    ]);

    const result = await runLLMStream({ ...baseParams(), autoMode: false });

    // The pause is the pre-existing contract of every attended surface.
    expect(capture.threw).toBe(true);
    expect(result.events).toContainEqual(askEvent);
  });
});

describe("runLLMStream strict private mode", () => {
  it("refuses a hosted lane before any provider call", async () => {
    // lib/privateMode's gate sits right after model resolution, so a hosted
    // lane must not reach the adapter at all — no key is spent on it.
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    await expect(runLLMStream(baseParams())).rejects.toBeInstanceOf(
      AssistantStreamError,
    );
    expect(streamChatWithTools).not.toHaveBeenCalled();
  });

  it("still runs a permitted lane", async () => {
    vi.stubEnv("STRICT_PRIVATE_MODE", "true");

    await runLLMStream({ ...baseParams(), model: "ollama/qwen3" });

    expect(streamChatWithTools).toHaveBeenCalledTimes(1);
  });
});
