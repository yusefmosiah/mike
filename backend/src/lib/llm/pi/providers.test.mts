import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { queryReceipts } from "../attestation/index.js";
import { resetModelRegistryCache } from "../registry.js";
import { providerFailureStatus } from "../providerErrors.js";
import {
  asOverflow,
  createMikeModels,
  providerError,
  providerSessionId,
  SIDE_SESSION_MARK,
  tolerantMessage,
  useRequestKeys,
} from "./providers.mjs";

/** A local OpenAI-compatible endpoint: records each request and answers with the next scripted text. */
type Seen = { path: string; authorization?: string; body: Record<string, unknown> };
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
/** A scripted answer: its text, or a function that writes the whole response. */
type Reply = string | ((res: ServerResponse, req: IncomingMessage) => void | Promise<void>);
let replies: Reply[] = [];

/** One streamed chat-completion chunk. */
const sse = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let verifierStatus = 503;
let verifierBody: Record<string, unknown> = {};

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/verifier/attestation") {
      res.writeHead(verifierStatus, { "content-type": "application/json" }).end(JSON.stringify(verifierBody));
      return;
    }
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body: await body(req) });
    const text = replies.shift() ?? "ok";
    if (typeof text === "function") {
      await text(res, req);
      return;
    }
    // A provider that accepts the request and then says nothing.
    if (text === "<silent>") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      req.on("close", () => res.end());
      return;
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: text }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  seen = [];
  replies = [];
  verifierStatus = 503;
  verifierBody = {};
  delete process.env.MIKE_MODEL_CONFIG_JSON;
  delete process.env.LOCAL_TEST_KEY;
  resetModelRegistryCache();
});

function declare(models: Record<string, unknown>[]) {
  process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({ models });
  resetModelRegistryCache();
}

const context = (tools = false): Context => ({
  systemPrompt: "You are Mike.",
  messages: [{ role: "user", content: "Read the NDA", timestamp: Date.now() }],
  ...(tools
    ? { tools: [{ name: "read_document", description: "Read", parameters: { type: "object", properties: { doc_id: { type: "string" } } } as never }] }
    : {}),
});

describe("Mike's catalog on pi-ai", () => {
  it("maps Mike ids onto pi-ai's catalogs", () => {
    const base = createModels();
    const { resolve } = createMikeModels(base);
    expect(resolve("claude-sonnet-4-6")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(resolve("gemini-3-flash-preview")).toEqual({ provider: "google", modelId: "gemini-3-flash-preview" });
    expect(resolve("gpt-5.4")).toEqual({ provider: "openai", modelId: "gpt-5.4" });
    expect(resolve("opencode-go/glm-5.3")).toEqual({ provider: "opencode-go", modelId: "glm-5.3" });
    expect(resolve("openrouter/anthropic/claude-sonnet-4.6").provider).toBe("openrouter");
    expect(resolve("vercel/anthropic/claude-sonnet-4.6").provider).toBe("vercel-ai-gateway");
    // Ids pi-ai does not know become one-model endpoint providers, speaking Mike's listed protocol.
    const ollama = resolve("ollama/qwen3:8b");
    expect(ollama).toEqual({ provider: "mike:ollama/qwen3:8b", modelId: "qwen3:8b" });
    expect(base.getModel(ollama.provider, ollama.modelId)?.api).toBe("openai-completions");
    const messages = resolve("opencode-go/qwen3.7-max");
    expect(base.getModel(messages.provider, messages.modelId)?.api).toBe("anthropic-messages");
  });

  it("sends a turn's user key to a hosted provider, and the deployment key otherwise", async () => {
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-4-6" }] });
    const keys: (string | undefined)[] = [];
    faux.setResponses(Array.from({ length: 2 }, () => (_ctx: unknown, options: { apiKey?: string } | undefined) => {
      keys.push(options?.apiKey);
      return fauxAssistantMessage([fauxText("hi")]);
    }));
    const base = createModels();
    base.setProvider(faux.provider);
    const { models } = createMikeModels(base);
    const model = base.getModel("anthropic", "claude-sonnet-4-6")!;
    process.env.ANTHROPIC_API_KEY = "deployment-key";
    const release = useRequestKeys("session-1", { claude: "user-key" });
    await models.completeSimple(model, context(), { sessionId: "session-1" });
    release();
    await models.completeSimple(model, context(), { sessionId: "session-1" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(keys).toEqual(["user-key", "deployment-key"]);
  });

  it("keeps a side session's own keys but asks the provider for the parent's session, and so its cache", async () => {
    expect(providerSessionId("parent")).toBe("parent");
    expect(providerSessionId(`parent${SIDE_SESSION_MARK}review-1`)).toBe("parent");
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-4-6" }] });
    const seenOptions: { apiKey?: string; sessionId?: string }[] = [];
    faux.setResponses([
      (_ctx: unknown, options: { apiKey?: string; sessionId?: string } | undefined) => {
        seenOptions.push({ apiKey: options?.apiKey, sessionId: options?.sessionId });
        return fauxAssistantMessage([fauxText("hi")]);
      },
    ]);
    const base = createModels();
    base.setProvider(faux.provider);
    const { models } = createMikeModels(base);
    const model = base.getModel("anthropic", "claude-sonnet-4-6")!;
    const side = `parent${SIDE_SESSION_MARK}review-1`;
    const release = useRequestKeys(side, { claude: "review-key" });
    await models.completeSimple(model, context(), { sessionId: side });
    release();
    expect(seenOptions).toEqual([{ apiKey: "review-key", sessionId: "parent" }]);
  });

  it("reaches a configured endpoint with its declared key and upstream model name", async () => {
    declare([{ id: "firm-llm", provider: "openai-compatible", location: "cloud", baseUrl, apiModel: "llama-4", apiKeyEnv: "LOCAL_TEST_KEY", tolerateTextToolCalls: false }]);
    process.env.LOCAL_TEST_KEY = "endpoint-key";
    replies = ["Hello from the firm."];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("firm-llm");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.content).toEqual([{ type: "text", text: "Hello from the firm." }]);
    expect(seen[0].authorization).toBe("Bearer endpoint-key");
    expect(seen[0].body.model).toBe("llama-4");
  });

  it("turns a local model's prose tool call and <think> text into a real call and reasoning", async () => {
    declare([{ id: "local-qwen", provider: "openai-compatible", location: "local", baseUrl }]);
    replies = ['<think>I should read it.</think>Let me check.<tool_call>{"name":"read_document","arguments":{"doc_id":"nda"}}</tool_call>'];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("local-qwen");
    const events: string[] = [];
    const stream = models.streamSimple(base.getModel(ref.provider, ref.modelId)!, context(true));
    for await (const event of stream) events.push(event.type);
    const answer = await stream.result();
    expect(answer.errorMessage).toBeUndefined();
    expect(answer.stopReason).toBe("toolUse");
    expect(answer.content).toEqual([
      { type: "thinking", thinking: "I should read it." },
      { type: "text", text: "Let me check." },
      expect.objectContaining({ type: "toolCall", name: "read_document", arguments: { doc_id: "nda" } }),
    ]);
    expect(events).toContain("toolcall_end");
    // Declared without auth: no Authorization header at all.
    expect(seen[0].authorization).toBeUndefined();
    expect(events.at(-1)).toBe("done");
  });

  it("fails closed when an attested endpoint does not verify, without reaching it", async () => {
    declare([
      {
        id: "tee-llm",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl,
        attestation: { endpoint: `${baseUrl}/verifier`, expectedMeasurement: "abc" },
      },
    ]);
    verifierStatus = 503;
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("tee-llm");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toContain("Attested inference unavailable");
    expect(seen).toHaveLength(0);
  });
});

describe("configured endpoints on pi-ai", () => {
  it("verifies an attested endpoint, records a receipt, and reaches the model once", async () => {
    declare([
      {
        id: "tee-ok",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl,
        attestation: { endpoint: `${baseUrl}/verifier`, expectedMeasurement: "measurement-1" },
      },
    ]);
    verifierStatus = 200;
    verifierBody = { measurement: "measurement-1", instance_id: "endpoint-1", verifier_version: "v3" };
    replies = ["attested answer"];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("tee-ok");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.content).toEqual([{ type: "text", text: "attested answer" }]);
    expect(seen).toHaveLength(1);
    const receipts = queryReceipts({ modelId: "tee-ok" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ endpointId: "endpoint-1", measurement: "measurement-1", verifierVersion: "v3" });
  });

  it("sends the output cap as max_tokens unless the endpoint declares max_completion_tokens", async () => {
    for (const [maxTokensField, expected] of [
      [undefined, "max_tokens"],
      ["max_completion_tokens", "max_completion_tokens"],
    ] as const) {
      seen = [];
      declare([
        { id: "capped", provider: "openai-compatible", location: "cloud", baseUrl, ...(maxTokensField ? { maxTokensField } : {}) },
      ]);
      const base = createModels();
      const { models, resolve } = createMikeModels(base);
      const ref = resolve("capped");
      await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context(), { maxTokens: 321 });
      expect(seen[0].body[expected]).toBe(321);
      expect(Object.keys(seen[0].body).filter((key) => /^max_(completion_)?tokens$/.test(key))).toEqual([expected]);
    }
  });
});

describe("egress", () => {
  afterEach(() => {
    delete process.env.STRICT_PRIVATE_MODE;
  });

  it("refuses a model host outside the private network in strict private mode, before any request", async () => {
    process.env.STRICT_PRIVATE_MODE = "true";
    declare([{ id: "public-llm", provider: "openai-compatible", location: "cloud", baseUrl: "http://8.8.8.8/v1" }]);
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("public-llm");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toMatch(/strict private mode|egress|not allowed/i);
  });

  it("lets a loopback endpoint through in strict private mode", async () => {
    process.env.STRICT_PRIVATE_MODE = "true";
    declare([{ id: "lan-llm", provider: "openai-compatible", location: "local", baseUrl }]);
    replies = ["from the LAN"];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("lan-llm");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.content).toEqual([{ type: "text", text: "from the LAN" }]);
  });
});

describe("a provider that stops responding", () => {
  it("ends the request after the first-chunk limit with an error Mike reports as a stall", async () => {
    declare([{ id: "quiet-llm", provider: "openai-compatible", location: "local", baseUrl }]);
    replies = ["<silent>"];
    const base = createModels();
    const { models, resolve } = createMikeModels(base, { chunkTimeouts: { firstChunkMs: 150, chunkMs: 150 } });
    const ref = resolve("quiet-llm");
    // The provider never answers: only the 150 ms limit ends the request.
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe("first chunk timeout of 150ms exceeded");
    expect(providerError("quiet-llm", answer.errorMessage!).message).toContain("stopped responding");
  });
});

/** River's GLM as docs/configured-models.md declares it. */
const riverGlm = () => ({
  id: "river/glm-5.3-flash",
  provider: "openai-compatible",
  location: "cloud",
  baseUrl,
  apiModel: "zai-org/GLM-5.3-Flash",
  contextWindow: 1_048_576,
  maxOutputTokens: 131_072,
  reasoning: { efforts: ["low", "high", "max"], default: "high", canDisable: false },
  cost: { input: 0.5, output: 2, cacheRead: 0.1 },
});

describe("configured model limits and reasoning", () => {
  it("registers the declared window, output limit, reasoning efforts and prices", () => {
    declare([riverGlm()]);
    const base = createModels();
    const ref = createMikeModels(base).resolve("river/glm-5.3-flash");
    const model = base.getModel(ref.provider, ref.modelId)!;
    expect(model).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    });
  });

  it("keeps the old assumptions for a model that declares no limits, leaving half the window for input", () => {
    declare([{ id: "plain", provider: "openai-compatible", location: "cloud", baseUrl }]);
    const base = createModels();
    const ref = createMikeModels(base).resolve("plain");
    expect(base.getModel(ref.provider, ref.modelId)).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384, reasoning: false });
    declare([{ id: "small", provider: "openai-compatible", location: "cloud", baseUrl, contextWindow: 8_192 }]);
    const small = createMikeModels(base).resolve("small");
    expect(base.getModel(small.provider, small.modelId)?.maxTokens).toBe(4_096);
  });

  it("never asks a model that cannot stop reasoning to stop: no effort becomes its lightest", async () => {
    declare([riverGlm()]);
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("river/glm-5.3-flash");
    const model = base.getModel(ref.provider, ref.modelId)!;
    await models.completeSimple(model, context());
    await models.completeSimple(model, context(), { reasoning: "medium" });
    await models.completeSimple(model, context(), { reasoning: "max" });
    expect(seen.map((request) => request.body.reasoning_effort)).toEqual(["low", "high", "max"]);
    // Instructions stay a system message, which every compatible server accepts.
    expect((seen[0].body.messages as { role: string }[])[0].role).toBe("system");
  });

  it("turns reasoning off only for a model that declares it can, with its off value", async () => {
    declare([
      {
        id: "river/deepseek-v4.1-flash-1017",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl,
        apiModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        contextWindow: 1_048_576,
        maxOutputTokens: 384_000,
        reasoning: { efforts: ["high", "max"], default: "high", canDisable: true, offValue: "none" },
      },
    ]);
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("river/deepseek-v4.1-flash-1017");
    const model = base.getModel(ref.provider, ref.modelId)!;
    await models.completeSimple(model, context());
    await models.completeSimple(model, context(), { reasoning: "low" });
    expect(seen.map((request) => request.body.reasoning_effort)).toEqual(["none", "high"]);
    expect(seen.map((request) => request.body.model)).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    ]);
  });

  it("sends no effort field to a model that reasons without one, such as River's Nemotron", async () => {
    declare([
      {
        id: "river/nemotron-3.5-super",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl,
        apiModel: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
        supportsVision: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        reasoning: { efforts: ["high"], param: "none" },
      },
    ]);
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("river/nemotron-3.5-super");
    const model = base.getModel(ref.provider, ref.modelId)!;
    expect(model).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072, reasoning: true });
    await models.completeSimple(model, context());
    await models.completeSimple(model, context(), { reasoning: "max" });
    expect(seen.map((request) => request.body.model)).toEqual([
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
    ]);
    expect(seen.every((request) => !("reasoning_effort" in request.body) && !("reasoning" in request.body))).toBe(true);
  });

  it("registers every declared model at once, warning once about each that declares no window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      declare([riverGlm(), { id: "no-window-model", provider: "openai-compatible", location: "cloud", baseUrl }]);
      const base = createModels();
      const catalog = createMikeModels(base);
      catalog.registerConfigured();
      catalog.registerConfigured();
      expect(base.getModel("mike:river/glm-5.3-flash", "zai-org/GLM-5.3-Flash")).toBeDefined();
      expect(base.getModel("mike:no-window-model", "no-window-model")).toBeDefined();
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings.filter((text) => text.includes("no-window-model"))).toHaveLength(1);
      expect(warnings.some((text) => text.includes("river/glm-5.3-flash"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("finds an endpoint model nothing has resolved yet in this process", () => {
    declare([riverGlm()]);
    const base = createModels();
    const { models } = createMikeModels(base);
    expect(base.getModel("mike:river/glm-5.3-flash", "zai-org/GLM-5.3-Flash")).toBeUndefined();
    expect(models.getModel("mike:river/glm-5.3-flash", "zai-org/GLM-5.3-Flash")?.contextWindow).toBe(1_048_576);
    expect(models.getModel("mike:not-declared", "x")).toBeUndefined();
  });
});

describe("a request that overflows the context window", () => {
  /** A response cut off by its output limit after `output` tokens. */
  const cutOff = (text: string, output: number): Reply => (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ role: "assistant", content: text }));
    res.write(sse({}, "length", { prompt_tokens: 150_000, completion_tokens: output, total_tokens: 150_000 + output }));
    res.end("data: [DONE]\n\n");
  };

  it("is reported as an overflow, not as a one-token answer", async () => {
    declare([{ id: "cramped", provider: "openai-compatible", location: "cloud", baseUrl }]);
    replies = [cutOff("I", 1)];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("cramped");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.stopReason).toBe("error");
    // What Pi Durable reads to compact and ask again.
    expect(isContextOverflow(answer)).toBe(true);
    expect(providerError("cramped", answer.errorMessage!).message).toContain("too long");
  });

  it("leaves a long answer that reached its output limit alone", async () => {
    declare([{ id: "verbose", provider: "openai-compatible", location: "cloud", baseUrl }]);
    replies = [cutOff("clause. ".repeat(200), 4_000)];
    const base = createModels();
    const { models, resolve } = createMikeModels(base);
    const ref = resolve("verbose");
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(answer.stopReason).toBe("length");
  });

  it("leaves a short answer alone when the caller asked for a short one", () => {
    const message = fauxAssistantMessage([fauxText("Yes")], { stopReason: "length" });
    message.usage.output = 3;
    expect(asOverflow(message, 8)).toBeUndefined();
    expect(asOverflow(message, 4_096)?.stopReason).toBe("error");
  });
});

describe("a stream that goes quiet between chunks", () => {
  /** Starts an answer, then sends only SSE comments (or nothing) for `gapMs` before finishing. */
  const gap = (gapMs: number, keepAlive: boolean): Reply => async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ role: "assistant", content: "Drafting" }));
    const until = Date.now() + gapMs;
    while (Date.now() < until) {
      await pause(40);
      if (keepAlive) res.write(": still generating\n\n");
    }
    res.write(sse({ content: " the clause." }));
    res.write(sse({}, "stop"));
    res.end("data: [DONE]\n\n");
  };
  const ask = async (id: string, extra: Record<string, unknown>, timeouts: { firstChunkMs: number; chunkMs: number; configuredChunkMs?: number }) => {
    declare([{ id, provider: "openai-compatible", location: "cloud", baseUrl, ...extra }]);
    const base = createModels();
    const { models, resolve } = createMikeModels(base, { chunkTimeouts: timeouts });
    const ref = resolve(id);
    return models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
  };

  it("ends the request when nothing at all arrives within the gap limit", async () => {
    replies = [gap(500, false)];
    const answer = await ask("quiet", {}, { firstChunkMs: 150, chunkMs: 150 });
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe("chunk timeout of 150ms exceeded");
  });

  it("keeps waiting while the endpoint sends bytes, even ones that are no event yet", async () => {
    replies = [gap(500, true)];
    const answer = await ask("busy", {}, { firstChunkMs: 150, chunkMs: 150 });
    expect(answer.errorMessage).toBeUndefined();
    expect(answer.content).toEqual([{ type: "text", text: "Drafting the clause." }]);
  });

  it("gives configured models their own, longer gap limit, and a model its declared one", async () => {
    replies = [gap(400, false)];
    const configured = await ask("patient", {}, { firstChunkMs: 150, chunkMs: 150, configuredChunkMs: 5_000 });
    expect(configured.stopReason).toBe("stop");
    replies = [gap(400, false)];
    const declared = await ask("declared", { streamIdleTimeoutMs: 5_000 }, { firstChunkMs: 150, chunkMs: 150, configuredChunkMs: 150 });
    expect(declared.stopReason).toBe("stop");
  });
});

describe("providerError", () => {
  it("reads the status each SDK reports and maps key, access and rate failures to Mike's messages", () => {
    const anthropic = providerError("claude-sonnet-4-6", '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    expect(anthropic.name).toBe("InvalidApiKeyError");
    expect(anthropic.message).toContain("Claude API key was rejected");
    expect(providerFailureStatus(anthropic.cause)).toBe(401);

    const gemini = providerError("gemini-3-flash-preview", '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
    expect(gemini.message).toContain("Gemini API key was rejected");
    expect(providerFailureStatus(gemini.cause)).toBe(400);

    const limited = providerError("openrouter/anthropic/claude-haiku-4.5", "429: Rate limit exceeded");
    expect(limited.message).toContain("OpenRouter rate limit");

    const plain = providerError("gpt-5.4", "socket hang up");
    expect(plain.message).toBe("socket hang up");
    expect(providerFailureStatus(plain)).toBeNull();
  });
});

describe("tolerantMessage", () => {
  it("leaves provider tool calls alone and only strips markup", () => {
    const message = fauxAssistantMessage([fauxText("Done."), { type: "toolCall", id: "t1", name: "x", arguments: {} }], { stopReason: "toolUse" });
    expect(tolerantMessage(message).content).toEqual(message.content);
  });
});
