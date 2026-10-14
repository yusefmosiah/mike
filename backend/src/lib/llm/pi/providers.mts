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
  ModelCost,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ThinkingLevelMap,
  ToolCall,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { recordReceipt, verifyAttestation } from "../attestation/index.js";
import { ACI_VERIFIER_VERSION, aciFetch, establishAci } from "../attestation/aci.js";
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
import { apiKeyForConfiguredModel, getConfiguredModel, loadModelRegistry, tolerateTextToolCalls } from "../registry.js";
import {
  collapseTrademarkOwnerCalls,
  parseTextToolCalls,
  TextToolMarkupFilter,
  ThinkTagFilter,
} from "../toolCallParsing.js";
import type { ConfiguredModel, ConfiguredReasoning, Provider, UserApiKeys } from "../types.js";

export type ModelRef = { provider: string; modelId: string };

/** How Mike reaches a pi-ai provider: which Mike provider's key it takes, and any endpoint specifics. */
type Route = {
  mikeProvider: Provider;
  configured?: ConfiguredModel;
  headers?: Record<string, string>;
  /** The gap limit once output flows, when this endpoint's differs from the default. */
  chunkMs?: number;
};

/** What Mike assumes of a configured model that declares no limits (kept for older configs). */
const CONFIGURED_DEFAULT_CONTEXT_WINDOW = 128_000;
const CONFIGURED_DEFAULT_MAX_OUTPUT = 16_384;

/**
 * A `length` stop with at most this many output tokens and no tool call is not
 * an answer: pi-ai shrinks the output budget to what the context window leaves
 * (down to one token), so a request that overflowed comes back cut off at once.
 */
export const OVERFLOW_OUTPUT_TOKENS = 16;

/** pi-ai's thinking levels, lightest first. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * A configured model's reasoning as pi-ai model fields. Each declared effort
 * maps to itself and every other level is unsupported, so pi-ai clamps a
 * request to the nearest declared effort; "off" is unsupported too unless the
 * model can turn reasoning off.
 */
function reasoningFields(reasoning: ConfiguredReasoning): {
  thinkingLevelMap: ThinkingLevelMap;
  compat: OpenAICompletionsCompat;
} {
  const thinkingLevelMap: ThinkingLevelMap = {
    off: reasoning.canDisable ? (reasoning.offValue ?? "none") : null,
  };
  for (const level of THINKING_LEVELS) {
    thinkingLevelMap[level] = (reasoning.efforts as readonly string[]).includes(level) ? level : null;
  }
  const compat: OpenAICompletionsCompat =
    reasoning.param === "reasoning.effort"
      ? { thinkingFormat: "openrouter" }
      : { thinkingFormat: "openai", supportsReasoningEffort: reasoning.param === "reasoning_effort" };
  return { thinkingLevelMap, compat };
}

/**
 * The lightest effort a reasoning model runs at, or undefined when it can turn
 * reasoning off (or does not reason). Reasoning models are not built to answer
 * without reasoning, so a request for none goes out at this effort instead.
 */
export function lightestThinkingLevel(model: Model<Api>): ThinkingLevel | undefined {
  const levels = getSupportedThinkingLevels(model);
  if (!model.reasoning || levels.includes("off")) return undefined;
  return levels.find((level): level is ThinkingLevel => level !== "off");
}

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
  /**
   * Register every model declared in MIKE_MODEL_CONFIG_JSON now, so work a
   * restart resumes finds its model before anything resolves it again.
   */
  registerConfigured(): void;
};

/** Configured models already warned about for declaring no context window. */
const warnedNoContextWindow = new Set<string>();

export function createMikeModels(
  base: MutableModels = createModels(),
  options: { chunkTimeouts?: { firstChunkMs: number; chunkMs: number; configuredChunkMs?: number } } = {},
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
      thinkingLevelMap?: ThinkingLevelMap;
      contextWindow?: number;
      maxTokens?: number;
      maxTokensField?: "max_tokens" | "max_completion_tokens";
      compat?: OpenAICompletionsCompat;
      cost?: ModelCost;
    },
  ): ModelRef => {
    const existing = endpointRefs.get(mikeModel);
    if (existing) return existing;
    const id = `mike:${mikeModel}`;
    const api = spec.api ?? "openai-completions";
    const compat = {
      ...spec.compat,
      ...(spec.maxTokensField ? { maxTokensField: spec.maxTokensField } : {}),
    };
    const model: Model<Api> = {
      id: spec.apiModel,
      name: mikeModel,
      api,
      provider: id,
      baseUrl: spec.baseUrl,
      input: spec.vision ? ["text", "image"] : ["text"],
      cost: spec.cost ?? ZERO_COST,
      reasoning: spec.reasoning ?? false,
      ...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
      contextWindow: spec.contextWindow ?? 128_000,
      maxTokens: spec.maxTokens ?? 16_384,
      ...(Object.keys(compat).length ? { compat } : {}),
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
      const contextWindow = configured.contextWindow ?? CONFIGURED_DEFAULT_CONTEXT_WINDOW;
      const reasoning = configured.reasoning ? reasoningFields(configured.reasoning) : undefined;
      return endpoint(mikeModel, {
        apiModel: configured.apiModel ?? configured.id,
        baseUrl: configured.baseUrl.replace(/\/+$/, ""),
        route: {
          mikeProvider: "openai-compatible",
          configured,
          chunkMs: configured.streamIdleTimeoutMs ?? timeouts.configuredChunkMs ?? timeouts.chunkMs,
        },
        vision: configured.supportsVision === true,
        reasoning: reasoning !== undefined,
        ...(reasoning ? { thinkingLevelMap: reasoning.thinkingLevelMap } : {}),
        contextWindow,
        // Without a declared limit, leave at least half the window for input.
        maxTokens: configured.maxOutputTokens ?? Math.min(CONFIGURED_DEFAULT_MAX_OUTPUT, Math.floor(contextWindow / 2)),
        // Mike's contract: max_tokens unless the endpoint declares otherwise
        // (pi-ai's own default is max_completion_tokens).
        maxTokensField: configured.maxTokensField ?? "max_tokens",
        compat: {
          // Not every compatible server knows OpenAI's `developer` role, which
          // pi-ai would otherwise use for a reasoning model's instructions.
          supportsDeveloperRole: false,
          ...reasoning?.compat,
        },
        ...(configured.cost ? { cost: configured.cost } : {}),
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

  const registerConfigured = () => {
    for (const configured of loadModelRegistry().models) {
      if (configured.contextWindow === undefined && !warnedNoContextWindow.has(configured.id)) {
        warnedNoContextWindow.add(configured.id);
        console.warn(
          `[models] ${configured.id} declares no contextWindow in MIKE_MODEL_CONFIG_JSON; assuming ${CONFIGURED_DEFAULT_CONTEXT_WINDOW} tokens. Declare its real limits (see docs/configured-models.md).`,
        );
      }
      resolve(configured.id);
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
      // An ACI endpoint is only ever reached over TLS pinned to its attested keys.
      ...(route.configured ? aciOptions(route.configured) : {}),
    };
  };

  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const route = routes.get(model.provider);
    // A model that cannot turn reasoning off is never asked to: no reasoning
    // requested (Pi Durable sends none for "off") becomes its lightest effort.
    const lightest = options?.reasoning ? undefined : lightestThinkingLevel(model);
    const request = withRequest(model, lightest ? { ...options, reasoning: lightest } : options);
    const configured = route?.configured;
    const budget = request.maxTokens ?? model.maxTokens;
    const limits = { firstChunkMs: timeouts.firstChunkMs, chunkMs: route?.chunkMs ?? timeouts.chunkMs };
    // Every request first passes the egress gate, and attested and tolerant
    // endpoints do more work before (or instead of) streaming, so events are
    // relayed through a stream of our own.
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        // Under STRICT_PRIVATE_MODE a model host outside the segmented network
        // is refused here, before any bytes or credentials leave.
        await assertEgressAllowed(model.baseUrl, "llm");
        if (configured?.attestation) await attest(configured, request.apiKey);
        if (configured && tolerateTextToolCalls(configured) && (context.tools?.length ?? 0) > 0) {
          const message = tolerantMessage(await base.completeSimple(model, context, request));
          const overflowed = asOverflow(message, budget);
          if (overflowed) {
            out.push({ type: "error", reason: "error", error: overflowed });
            out.end(overflowed);
            return;
          }
          replay(out, message);
          return;
        }
        await relayWatched(
          out,
          model,
          // Every byte the endpoint sends counts as life, even when it adds up
          // to no event yet (a long tool call some servers send in one piece).
          (signal, alive) =>
            base.streamSimple(model, context, {
              ...request,
              signal,
              ...(TAPPABLE_APIS.has(model.api) ? { fetch: tapBytes(request.fetch, alive) } : {}),
            }),
          request.signal,
          limits,
          budget,
        );
      } catch (error) {
        const failed = failure(model, error);
        out.push({ type: "error", reason: "error", error: failed });
        out.end(failed);
      }
    })();
    return out;
  };

  /**
   * A lookup of an endpoint model not registered yet in this process (work a
   * restart resumes, for a model nothing has resolved since) registers it from
   * the Mike id its provider id carries.
   */
  const getModel: Models["getModel"] = ((provider: string, modelId: string) => {
    const found = base.getModel(provider, modelId);
    if (found || !provider.startsWith("mike:")) return found;
    try {
      resolve(provider.slice("mike:".length));
    } catch {
      return undefined;
    }
    return base.getModel(provider, modelId);
  }) as Models["getModel"];

  const models: Models = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "streamSimple") return streamSimple;
      if (key === "getModel") return getModel;
      if (key === "completeSimple") {
        return (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
          (await streamSimple(model, context, options)).result()) as Models["completeSimple"];
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models, resolve, registerConfigured };
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

/** One pinned fetch per ACI model, so its connections are pooled. */
const aciFetches = new Map<string, typeof fetch>();

function aciOptions(configured: ConfiguredModel): { fetch?: typeof fetch } {
  const attestation = configured.attestation;
  if (!attestation || !("scheme" in attestation)) return {};
  let pinned = aciFetches.get(configured.id);
  if (!pinned) {
    pinned = aciFetch(configured.baseUrl, attestation);
    aciFetches.set(configured.id, pinned);
  }
  return { fetch: pinned };
}

/** Fail closed: an attested endpoint verifies before each request or the request never reaches it. */
async function attest(configured: ConfiguredModel, apiKey: string | undefined): Promise<void> {
  const attestation = configured.attestation!;
  if ("scheme" in attestation) {
    const identity = await establishAci(configured.baseUrl, apiKey === KEYLESS ? undefined : apiKey, attestation);
    if (!identity.ok) throw new Error(`Attested inference unavailable: ${identity.reason}`);
    recordReceipt({
      endpointId: identity.keysetDigest,
      modelId: configured.id,
      measurement: `mrtd:${identity.mrTd} compose:${identity.composeHash}`,
      verifierVersion: ACI_VERIFIER_VERSION,
      requestId: crypto.randomUUID(),
    });
    return;
  }
  const verification = await verifyAttestation({
    verifierUrl: attestation.endpoint,
    expectedMeasurement: attestation.expectedMeasurement,
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
 * Bytes received with no event yet (`alive`) re-arm whichever limit applies.
 * The failure names the limit, which Mike reports as the provider having
 * stopped responding; the caller's own abort passes through unchanged. A
 * finished response that is really an overflow (`asOverflow`) is relayed as one.
 */
async function relayWatched(
  out: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<Api>,
  open: (signal: AbortSignal, alive: () => void) => AsyncIterable<AssistantMessageEvent>,
  callerSignal: AbortSignal | undefined,
  limits: { firstChunkMs: number; chunkMs: number },
  budget: number,
): Promise<void> {
  const controller = new AbortController();
  const forward = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forward();
  else callerSignal?.addEventListener("abort", forward, { once: true });
  let stalled: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let current: [number, string] = [limits.firstChunkMs, "first chunk"];
  const arm = (ms: number, limit: string) => {
    current = [ms, limit];
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new Error(`${limit} timeout of ${ms}ms exceeded`);
      controller.abort(stalled);
    }, ms);
  };
  const alive = () => {
    if (!finished && !stalled) arm(...current);
  };
  arm(limits.firstChunkMs, "first chunk");
  try {
    for await (const event of open(controller.signal, alive)) {
      if (stalled) break;
      if (event.type === "done" || event.type === "error") {
        finished = true;
        clearTimeout(timer);
        const overflowed = event.type === "done" ? asOverflow(event.message, budget) : undefined;
        out.push(overflowed ? { type: "error", reason: "error", error: overflowed } : event);
        continue;
      }
      if (event.type !== "start") arm(limits.chunkMs, "chunk");
      out.push(event);
    }
  } finally {
    finished = true;
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

/** pi-ai APIs whose clients take a custom fetch (Google's refuse one). */
const TAPPABLE_APIS = new Set<string>(["openai-completions", "openai-responses", "anthropic-messages"]);

/** A fetch that reports every chunk of a response body as it arrives. */
function tapBytes(inner: typeof fetch | undefined, alive: () => void): typeof fetch {
  return async (input, init) => {
    const response = await (inner ?? fetch)(input, init);
    if (!response.body) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          alive();
          controller.enqueue(chunk);
        },
      }),
    );
    const tapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(tapped, "url", { value: response.url });
    return tapped;
  };
}

/** The error text of an overflow Mike detects itself; pi-ai and Pi Durable read it as a context overflow. */
export const OVERFLOW_ERROR_PREFIX = "context_length_exceeded";

/**
 * A response that "finished" by running out of output budget almost at once
 * (stop `length`, at most OVERFLOW_OUTPUT_TOKENS tokens, no tool call) when it
 * had a real budget: pi-ai cut the budget to what the context window left, so
 * the request overflowed. Returned as the overflow error it is, so Pi Durable
 * compacts and asks again, or the turn fails clearly instead of with an empty
 * answer. Undefined for any other response.
 */
export function asOverflow(message: AssistantMessage, budget: number): AssistantMessage | undefined {
  if (message.stopReason !== "length" || budget <= OVERFLOW_OUTPUT_TOKENS) return undefined;
  if (message.usage.output > OVERFLOW_OUTPUT_TOKENS) return undefined;
  if (message.content.some((part) => part.type === "toolCall")) return undefined;
  // Usage some endpoints never report must not turn a long cut-off answer into an overflow.
  const written = message.content.reduce(
    (sum, part) => sum + (part.type === "text" ? part.text.length : part.type === "thinking" ? part.thinking.length : 0),
    0,
  );
  if (written > OVERFLOW_OUTPUT_TOKENS * 16) return undefined;
  return {
    ...message,
    stopReason: "error",
    errorMessage: `${OVERFLOW_ERROR_PREFIX}: the conversation no longer fits the model's context window (the response stopped after ${message.usage.output} output tokens)`,
  };
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
