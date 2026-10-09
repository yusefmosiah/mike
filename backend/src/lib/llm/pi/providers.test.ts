import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { queryReceipts } from "../attestation";
import { resetModelRegistryCache } from "../registry";
import { providerFailureStatus } from "../providerErrors";
import { createMikeModels, providerError, tolerantMessage, useRequestKeys } from "./providers.mjs";

/** A local OpenAI-compatible endpoint: records each request and answers with the next scripted text. */
type Seen = { path: string; authorization?: string; body: Record<string, unknown> };
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let replies: string[] = [];
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
    const started = Date.now();
    const answer = await models.completeSimple(base.getModel(ref.provider, ref.modelId)!, context());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe("first chunk timeout of 150ms exceeded");
    expect(providerError("quiet-llm", answer.errorMessage!).message).toContain("stopped responding");
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
