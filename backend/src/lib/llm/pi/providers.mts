// Mike's model catalog on pi-ai: every model id Mike offers resolves to a pi-ai
// model reference, and one wrapper around the catalog applies what Mike adds to
// a request — the turn's key (a user's own key over the deployment's), the
// attestation check of attested endpoints, and the tolerance shim for local
// models that write tool calls as prose.
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { recordReceipt, verifyAttestation } from "../attestation/index.js";
import { assertEgressAllowed } from "../../egress.js";
import { toProviderStreamError } from "../providerErrors.js";
import { streamChunkTimeouts } from "../../runtimeConfig.js";
import {
  OPENCODE_GO_BASE_URL,
  OPENROUTER_BASE_URL,
  ROUTER_LABELS,
  VERCEL_GATEWAY_BASE_URL,
  ollamaAuthHeaders,
  ollamaBaseUrl,
  ollamaModelName,
  providerKey,
} from "../endpoints.js";
import {
  contextWindowForOpenCodeGoModel,
  isOpenCodeGoMessagesModel,
  maxOutputTokensForOpenCodeGoModel,
  modelSupportsVision,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
} from "../models.js";
import { apiKeyForConfiguredModel, getConfiguredModel, tolerateTextToolCalls } from "../registry.js";
import {
  collapseTrademarkOwnerCalls,
  parseTextToolCalls,
  TextToolMarkupFilter,
  ThinkTagFilter,
} from "../toolCallParsing.js";
import type { ConfiguredModel, Provider, UserApiKeys } from "../types.js";

export type ModelRef = { provider: string; modelId: string };

/** How Mike reaches a pi-ai provider: which Mike provider's key it takes, and any endpoint specifics. */
type Route = {
  mikeProvider: Provider;
  configured?: ConfiguredModel;
  headers?: Record<string, string>;
};

const HOSTED: Record<string, Provider> = {
  anthropic: "claude",
  google: "gemini",
  openai: "openai",
  openrouter: "openrouter",
  "vercel-ai-gateway": "vercel",
  "opencode-go": "opencode-go",
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The user keys of turns in flight, by the conversation's provider session id. */
const requestKeys = new Map<string, UserApiKeys>();

/** Make `keys` the keys of requests sent with this provider session id until the returned release runs. */
export function useRequestKeys(sessionId: string, keys: UserApiKeys | undefined): () => void {
  if (!keys) return () => undefined;
  requestKeys.set(sessionId, keys);
  return () => {
    if (requestKeys.get(sessionId) === keys) requestKeys.delete(sessionId);
  };
}

export type MikeModels = {
  /** The catalog the Harness uses: pi-ai's providers behind Mike's request wrapper. */
  models: Models;
  /** Resolve a Mike model id, registering an endpoint model on first use. */
  resolve(mikeModel: string): ModelRef;
};

export function createMikeModels(
  base: MutableModels = createModels(),
  options: { chunkTimeouts?: { firstChunkMs: number; chunkMs: number } } = {},
): MikeModels {
  const timeouts = options.chunkTimeouts ?? streamChunkTimeouts();
  for (const provider of [
    anthropicProvider(),
    googleProvider(),
    openaiProvider(),
    openrouterProvider(),
    vercelAIGatewayProvider(),
    opencodeGoProvider(),
  ]) {
    // A provider already in the catalog (a test's scripted model) stays.
    if (!base.getProvider(provider.id)) base.setProvider(provider);
  }

  const routes = new Map<string, Route>(Object.entries(HOSTED).map(([id, mikeProvider]) => [id, { mikeProvider }]));
  const endpointRefs = new Map<string, ModelRef>();

  /**
   * Register a one-model provider for an OpenAI-compatible endpoint. Each Mike id
   * gets its own provider, so endpoints that share a model name never collide.
   */
  const endpoint = (
    mikeModel: string,
    spec: {
      apiModel: string;
      baseUrl: string;
      route: Route;
      vision: boolean;
      api?: "openai-completions" | "anthropic-messages";
      reasoning?: boolean;
      contextWindow?: number;
      maxTokens?: number;
      maxTokensField?: "max_tokens" | "max_completion_tokens";
    },
  ): ModelRef => {
    const existing = endpointRefs.get(mikeModel);
    if (existing) return existing;
    const id = `mike:${mikeModel}`;
    const api = spec.api ?? "openai-completions";
    const model: Model<Api> = {
      id: spec.apiModel,
      name: mikeModel,
      api,
      provider: id,
      baseUrl: spec.baseUrl,
      input: spec.vision ? ["text", "image"] : ["text"],
      cost: ZERO_COST,
      reasoning: spec.reasoning ?? false,
      contextWindow: spec.contextWindow ?? 128_000,
      maxTokens: spec.maxTokens ?? 16_384,
      ...(spec.maxTokensField ? { compat: { maxTokensField: spec.maxTokensField } } : {}),
    };
    base.setProvider(
      createProvider<Api>({
        id,
        name: mikeModel,
        // The key is applied per request by the wrapper below; keyless endpoints stay keyless.
        auth: { apiKey: { name: `${mikeModel} key`, resolve: async () => ({ auth: {} }) } },
        models: [model],
        api: api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
      }),
    );
    routes.set(id, spec.route);
    const ref = { provider: id, modelId: spec.apiModel };
    endpointRefs.set(mikeModel, ref);
    return ref;
  };

  const resolve = (mikeModel: string): ModelRef => {
    const configured = getConfiguredModel(mikeModel);
    if (configured) {
      return endpoint(mikeModel, {
        apiModel: configured.apiModel ?? configured.id,
        baseUrl: configured.baseUrl.replace(/\/+$/, ""),
        route: { mikeProvider: "openai-compatible", configured },
        vision: configured.supportsVision === true,
        // Mike's contract: max_tokens unless the endpoint declares otherwise
        // (pi-ai's own default is max_completion_tokens).
        maxTokensField: configured.maxTokensField ?? "max_tokens",
      });
    }
    const provider = providerForModel(mikeModel);
    switch (provider) {
      case "claude":
        return { provider: "anthropic", modelId: mikeModel };
      case "gemini":
        return { provider: "google", modelId: mikeModel };
      case "openai":
        return { provider: "openai", modelId: mikeModel };
      case "opencode-go": {
        const id = openCodeGoModelId(mikeModel);
        if (base.getModel("opencode-go", id)) return { provider: "opencode-go", modelId: id };
        // Not in pi's catalog yet: speak the protocol Mike's catalog lists for it.
        const messages = isOpenCodeGoMessagesModel(mikeModel);
        return endpoint(mikeModel, {
          apiModel: id,
          api: messages ? "anthropic-messages" : "openai-completions",
          baseUrl: messages ? OPENCODE_GO_BASE_URL.replace(/\/v1$/, "") : OPENCODE_GO_BASE_URL,
          route: { mikeProvider: "opencode-go" },
          vision: modelSupportsVision(mikeModel),
          reasoning: true,
          contextWindow: contextWindowForOpenCodeGoModel(id),
          maxTokens: maxOutputTokensForOpenCodeGoModel(id),
          maxTokensField: messages ? undefined : "max_tokens",
        });
      }
      case "openrouter": {
        const id = openRouterModelId(mikeModel);
        if (base.getModel("openrouter", id)) return { provider: "openrouter", modelId: id };
        return endpoint(mikeModel, {
          apiModel: id,
          baseUrl: OPENROUTER_BASE_URL,
          route: { mikeProvider: "openrouter" },
          vision: modelSupportsVision(mikeModel),
        });
      }
      case "vercel": {
        const id = vercelModelId(mikeModel);
        if (base.getModel("vercel-ai-gateway", id)) return { provider: "vercel-ai-gateway", modelId: id };
        return endpoint(mikeModel, {
          apiModel: id,
          baseUrl: VERCEL_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1",
          route: { mikeProvider: "vercel" },
          vision: modelSupportsVision(mikeModel),
        });
      }
      case "ollama":
        return endpoint(mikeModel, {
          apiModel: ollamaModelName(mikeModel),
          baseUrl: ollamaBaseUrl(),
          route: { mikeProvider: "ollama", headers: ollamaAuthHeaders() },
          vision: false,
        });
      case "openai-compatible":
        throw new Error(`Model ${mikeModel} is not declared in MIKE_MODEL_CONFIG_JSON.`);
    }
  };

  /** The request options Mike adds: the turn's key and endpoint headers. */
  const withRequest = (model: Model<Api>, options: SimpleStreamOptions | undefined): SimpleStreamOptions => {
    const route = routes.get(model.provider);
    if (!route) return options ?? {};
    const keys = options?.sessionId ? requestKeys.get(options.sessionId) : undefined;
    // Mike's key resolution (a user's key, then the deployment's, with Mike's env
    // aliases); without one, a hosted provider falls back to its own env lookup.
    const apiKey = route.configured
      ? (apiKeyForConfiguredModel(route.configured, keys) ?? undefined)
      : providerKey(route.mikeProvider, keys);
    // pi's OpenAI client insists on a key; an endpoint declared without auth gets
    // a placeholder that never leaves the process, and no Authorization header.
    const keyless = !apiKey && !HOSTED[model.provider];
    return {
      ...options,
      ...(apiKey ? { apiKey } : keyless ? { apiKey: KEYLESS, fetch: withoutPlaceholderAuth(options?.fetch) } : {}),
      ...(route.headers ? { headers: { ...route.headers, ...options?.headers } } : {}),
    };
  };

  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const route = routes.get(model.provider);
    const request = withRequest(model, options);
    const configured = route?.configured;
    // Every request first passes the egress gate, and attested and tolerant
    // endpoints do more work before (or instead of) streaming, so events are
    // relayed through a stream of our own.
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        // Under STRICT_PRIVATE_MODE a model host outside the segmented network
        // is refused here, before any bytes or credentials leave.
        await assertEgressAllowed(model.baseUrl, "llm");
        if (configured?.attestation) await attest(configured);
        if (configured && tolerateTextToolCalls(configured) && (context.tools?.length ?? 0) > 0) {
          const message = await base.completeSimple(model, context, request);
          replay(out, tolerantMessage(message));
          return;
        }
        await relayWatched(out, model, (signal) => base.streamSimple(model, context, { ...request, signal }), request.signal, timeouts);
      } catch (error) {
        const failed = failure(model, error);
        out.push({ type: "error", reason: "error", error: failed });
        out.end(failed);
      }
    })();
    return out;
  };

  const models: Models = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "streamSimple") return streamSimple;
      if (key === "completeSimple") {
        return (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
          (await streamSimple(model, context, options)).result()) as Models["completeSimple"];
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models, resolve };
}

/** How Mike names a model's provider to the user. */
function providerLabel(mikeModel: string): string {
  const configured = getConfiguredModel(mikeModel);
  if (configured) return configured.label || configured.id;
  const provider = providerForModel(mikeModel);
  switch (provider) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama";
    case "openrouter":
    case "vercel":
    case "opencode-go":
      return ROUTER_LABELS[provider];
    default:
      return String(provider);
  }
}

/**
 * The HTTP status a provider answered with, read from pi-ai's error text: the
 * OpenAI and Anthropic SDKs lead with it ("401 Incorrect API key"), pi-ai's
 * formatter writes "400: <body>", and Google's body carries `"code": 400`.
 */
function statusIn(text: string): number | undefined {
  const lead = /^\s*(?:[^:(\n]*\()?([1-5]\d\d)\)?(?::|\s)/.exec(text);
  const body = /"(?:code|status)"\s*:\s*([1-5]\d\d)\b/.exec(text);
  const value = Number(lead?.[1] ?? body?.[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A failed model request as the error Mike's callers classify: a rejected key
 * or an access, credit or rate-limit failure becomes a user-facing message,
 * and the provider's status rides along for logging (`providerFailureStatus`).
 */
export function providerError(mikeModel: string, text: string): Error {
  const statusCode = statusIn(text);
  const failure = statusCode !== undefined
    ? Object.assign(new Error(text), { statusCode, responseBody: text })
    : new Error(text);
  return toProviderStreamError(failure, { label: providerLabel(mikeModel), modelId: mikeModel });
}

const KEYLESS = "mike-keyless-endpoint";

function withoutPlaceholderAuth(inner: typeof fetch | undefined): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get("authorization") === `Bearer ${KEYLESS}`) headers.delete("authorization");
    if (headers.get("x-api-key") === KEYLESS) headers.delete("x-api-key");
    return (inner ?? fetch)(input, { ...init, headers });
  };
}

/** Fail closed: an attested endpoint verifies before each request or the request never reaches it. */
async function attest(configured: ConfiguredModel): Promise<void> {
  const verification = await verifyAttestation({
    verifierUrl: configured.attestation!.endpoint,
    expectedMeasurement: configured.attestation!.expectedMeasurement,
  });
  if (!verification.ok) throw new Error(`Attested inference unavailable: ${verification.reason}`);
  recordReceipt({
    endpointId: verification.endpointId,
    modelId: configured.id,
    measurement: verification.measurement,
    verifierVersion: verification.verifierVersion,
    requestId: crypto.randomUUID(),
  });
}

/**
 * Relay a provider stream, ending it when the provider goes quiet: no output
 * within `firstChunkMs` of the request (a reasoning model may think silently
 * for a while, so it is generous), or a gap over `chunkMs` once output flows.
 * The failure names the limit, which Mike reports as the provider having
 * stopped responding; the caller's own abort passes through unchanged.
 */
async function relayWatched(
  out: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<Api>,
  open: (signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>,
  callerSignal: AbortSignal | undefined,
  limits: { firstChunkMs: number; chunkMs: number },
): Promise<void> {
  const controller = new AbortController();
  const forward = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forward();
  else callerSignal?.addEventListener("abort", forward, { once: true });
  let stalled: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, limit: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new Error(`${limit} timeout of ${ms}ms exceeded`);
      controller.abort(stalled);
    }, ms);
  };
  arm(limits.firstChunkMs, "first chunk");
  try {
    for await (const event of open(controller.signal)) {
      if (stalled) break;
      if (event.type === "done" || event.type === "error") {
        clearTimeout(timer);
        out.push(event);
        continue;
      }
      if (event.type !== "start") arm(limits.chunkMs, "chunk");
      out.push(event);
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forward);
  }
  if (stalled) {
    const failed = failure(model, stalled);
    out.push({ type: "error", reason: "error", error: failed });
    out.end(failed);
    return;
  }
  out.end();
}

function failure(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

/**
 * A local model's answer with its prose cleaned up: `<think>` text becomes
 * reasoning, tool calls written as text become real tool calls (only when the
 * endpoint reported none), and the tool markup is removed from what is shown.
 */
export function tolerantMessage(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "error" || message.stopReason === "aborted") return message;
  const providerCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
  const providerThinking = message.content
    .filter((part): part is ThinkingContent => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
  const raw = message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
  const think = new ThinkTagFilter();
  const fed = think.feed(raw);
  const flushed = think.flush();
  const reasoning = providerThinking + [...fed.reasoning, ...flushed.reasoning].join("");
  const visibleRaw = [...fed.content, ...flushed.content].join("");
  const recovered = providerCalls.length
    ? []
    : collapseTrademarkOwnerCalls(parseTextToolCalls(visibleRaw, 0)).map(
        // The parser numbers calls per request; a transcript needs ids unique across rounds.
        (call): ToolCall => ({
          type: "toolCall",
          id: call.id.startsWith("call_text_") ? `call_text_${crypto.randomUUID()}` : call.id,
          name: call.name,
          arguments: call.input as ToolCall["arguments"],
        }),
      );
  const markup = new TextToolMarkupFilter();
  const visible = markup.feed(visibleRaw) + markup.flush();
  const calls = [...providerCalls, ...recovered];
  return {
    ...message,
    content: [
      ...(reasoning ? [{ type: "thinking" as const, thinking: reasoning }] : []),
      ...(visible ? [{ type: "text" as const, text: visible }] : []),
      ...calls,
    ],
    stopReason: calls.length ? "toolUse" : message.stopReason,
  };
}

/** Emit a finished message as a stream: one start, a block at a time, then done. */
function replay(out: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [] };
  const push = (event: AssistantMessageEvent) => out.push(event);
  push({ type: "start", partial: { ...partial } });
  message.content.forEach((block, contentIndex) => {
    partial.content = [...partial.content, block];
    const snapshot = { ...partial };
    if (block.type === "thinking") {
      push({ type: "thinking_start", contentIndex, partial: snapshot });
      push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: snapshot });
      push({ type: "thinking_end", contentIndex, content: block.thinking, partial: snapshot });
    } else if (block.type === "text") {
      push({ type: "text_start", contentIndex, partial: snapshot });
      push({ type: "text_delta", contentIndex, delta: block.text, partial: snapshot });
      push({ type: "text_end", contentIndex, content: block.text, partial: snapshot });
    } else {
      push({ type: "toolcall_start", contentIndex, partial: snapshot });
      push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: snapshot });
      push({ type: "toolcall_end", contentIndex, toolCall: block, partial: snapshot });
    }
  });
  const reason = message.stopReason === "toolUse" || message.stopReason === "length" ? message.stopReason : "stop";
  push({ type: "done", reason, message });
  out.end(message);
}
