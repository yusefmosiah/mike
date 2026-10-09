import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { resetModelRegistryCache } from "../registry";
import { createMikeModels, tolerantMessage, useRequestKeys } from "./providers.mjs";

/** A local OpenAI-compatible endpoint: records each request and answers with the next scripted text. */
type Seen = { path: string; authorization?: string; body: Record<string, unknown> };
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let replies: string[] = [];
let verifierStatus = 503;

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/verifier/attestation") {
      res.writeHead(verifierStatus).end("{}");
      return;
    }
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body: await body(req) });
    const text = replies.shift() ?? "ok";
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

describe("tolerantMessage", () => {
  it("leaves provider tool calls alone and only strips markup", () => {
    const message = fauxAssistantMessage([fauxText("Done."), { type: "toolCall", id: "t1", name: "x", arguments: {} }], { stopReason: "toolUse" });
    expect(tolerantMessage(message).content).toEqual(message.content);
  });
});
