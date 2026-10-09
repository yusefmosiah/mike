import { randomUUID } from "node:crypto";
import { assertModelAllowed } from "../privateMode";
import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import { recordReceipt, verifyAttestation } from "./attestation";
import {
  OPENCODE_GO_BASE_URL,
  OPENROUTER_BASE_URL,
  VERCEL_GATEWAY_BASE_URL,
  ollamaAuthHeaders,
  ollamaBaseUrl,
  ollamaModelName,
  requiredKey,
  ROUTER_LABELS,
  routerKey,
  type RouterProvider,
} from "./endpoints";
export { ollamaAuthHeaders } from "./endpoints";
import { localModelToleranceMiddleware } from "./localModelMiddleware";
import {
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  normalizeReasoningLevelForModel,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
} from "./models";
import {
  apiKeyForConfiguredModel,
  getConfiguredModel,
  tolerateTextToolCalls,
} from "./registry";
import type {
  ConfiguredModel,
  Provider,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { REASONING_LEVELS } from "./types";

type CompleteProviderParams = {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
};

async function createAnthropicAdapter(args: {
  provider: Extract<Provider, "claude" | "opencode-go">;
  label: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  supportsReasoning: boolean;
}): Promise<AiSdkAdapterConfig> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    name: `${args.provider}.messages`,
    headers:
      args.provider === "opencode-go"
        ? {
            "User-Agent": "mike-legal-agent/1.0",
            "x-opencode-session": randomUUID(),
          }
        : undefined,
    fetch: aiSdkFetch,
  });
  return {
    provider: args.provider,
    label: args.label,
    model: anthropic(args.model),
    modelId: args.model,
    supportsReasoning: args.supportsReasoning,
  };
}

async function createRouterAdapter(
  provider: RouterProvider,
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  if (provider === "opencode-go" && !isOpenCodeGoChatCompletionsModel(model)) {
    throw unsupportedOpenCodeGoModel(model);
  }
  const key = routerKey(provider, apiKeys);

  if (provider === "openrouter") {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({
      apiKey: key,
      baseURL: OPENROUTER_BASE_URL,
      compatibility: "strict",
      appName: "Mike",
      appUrl: process.env.FRONTEND_URL,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: openrouter.chat(openRouterModelId(model)),
      modelId: model,
    };
  }

  if (provider === "vercel") {
    const { createGateway } = await import("ai");
    const gateway = createGateway({
      apiKey: key,
      ...(VERCEL_GATEWAY_BASE_URL ? { baseURL: VERCEL_GATEWAY_BASE_URL } : {}),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: gateway.chat(vercelModelId(model)),
      modelId: model,
    };
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const openCodeGo = createOpenAICompatible({
    name: "opencodeGo",
    apiKey: key,
    baseURL: OPENCODE_GO_BASE_URL,
    headers: {
      "User-Agent": "mike-legal-agent/1.0",
      "x-opencode-session": randomUUID(),
    },
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: ROUTER_LABELS[provider],
    model: openCodeGo(openCodeGoModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

function configuredModelOrThrow(id: string): ConfiguredModel {
  const configured = getConfiguredModel(id);
  if (!configured) {
    throw new Error(
      `Model ${id} is not declared in MIKE_MODEL_CONFIG_JSON.`,
    );
  }
  if (!configured.baseUrl?.trim()) {
    throw new Error(`Configured model ${id} is missing a baseUrl.`);
  }
  return configured;
}

async function createConfiguredAdapter(
  id: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const configured = configuredModelOrThrow(id);
  if (configured.attestation) {
    // Fail closed: an attested endpoint either verifies right now or the
    // request never reaches it. No fallback lane, no silent retry.
    const verification = await verifyAttestation({
      verifierUrl: configured.attestation.endpoint,
      expectedMeasurement: configured.attestation.expectedMeasurement,
    });
    if (!verification.ok) {
      throw new Error(
        `Attested inference unavailable: ${verification.reason}`,
      );
    }
    recordReceipt({
      endpointId: verification.endpointId,
      modelId: configured.id,
      measurement: verification.measurement,
      verifierVersion: verification.verifierVersion,
      requestId: randomUUID(),
    });
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const apiKey = apiKeyForConfiguredModel(configured, apiKeys);
  const client = createOpenAICompatible({
    name: configured.id,
    baseURL: configured.baseUrl,
    // Omit Authorization entirely for endpoints declared without auth.
    ...(apiKey ? { apiKey } : {}),
    ...(configured.maxTokensField === "max_completion_tokens"
      ? {
          transformRequestBody: (body: Record<string, unknown>) => {
            const { max_tokens: maxTokens, ...rest } = body;
            return maxTokens === undefined
              ? rest
              : { ...rest, max_completion_tokens: maxTokens };
          },
        }
      : {}),
    fetch: aiSdkFetch,
  });
  const base = client(configured.apiModel ?? configured.id);
  const { wrapLanguageModel } = await import("ai");
  return {
    provider: "openai-compatible",
    label: configured.label || configured.id,
    model: tolerateTextToolCalls(configured)
      ? wrapLanguageModel({
          model: base,
          middleware: localModelToleranceMiddleware(),
        })
      : base,
    modelId: configured.id,
    supportsReasoning: false,
  };
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed in Settings → Bring Your Own Keys → Routers.`,
  );
}

async function createProviderAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  // Strict private mode refuses hosted lanes before any transport is built.
  // The gate consults the configured-model registry itself, so this one call
  // covers hosted, router, local, and configured ids.
  assertModelAllowed(model);
  const provider = providerForModel(model);

  if (provider === "claude") {
    return createAnthropicAdapter({
      provider,
      label: "Claude",
      model,
      apiKey: requiredKey("Anthropic", "ANTHROPIC_API_KEY", apiKeys?.claude),
      supportsReasoning: true,
    });
  }

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: requiredKey("Gemini", "GEMINI_API_KEY", apiKeys?.gemini),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Gemini", model: google(model), modelId: model };
  }

  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: requiredKey("OpenAI", "OPENAI_API_KEY", apiKeys?.openai),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "OpenAI",
      model: openai.responses(model),
      modelId: model,
      courtlistenerCitationReminder: true,
    };
  }

  if (provider === "openrouter" || provider === "vercel") {
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "opencode-go") {
    if (isOpenCodeGoMessagesModel(model)) {
      return createAnthropicAdapter({
        provider,
        label: "OpenCode Go",
        model: openCodeGoModelId(model),
        apiKey: routerKey(provider, apiKeys),
        baseURL: OPENCODE_GO_BASE_URL,
        supportsReasoning: false,
      });
    }
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "openai-compatible") {
    return createConfiguredAdapter(model, apiKeys);
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: ollamaBaseUrl(),
    headers: ollamaAuthHeaders(),
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: "Ollama",
    model: ollama(ollamaModelName(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const normalizedParams = {
    ...params,
    reasoning: normalizeReasoningLevelForModel(params.model, params.reasoning),
  };
  try {
    return await streamAiSdk(
      normalizedParams,
      await createProviderAdapter(params.model, params.apiKeys),
    );
  } catch (error) {
    const retryReasoning = fallbackReasoningLevelFromProviderError(
      error,
      normalizedParams.reasoning,
    );
    if (retryReasoning) {
      return streamAiSdk(
        { ...normalizedParams, reasoning: retryReasoning },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    if (
      providerForModel(params.model) === "ollama" &&
      params.tools?.length &&
      !params.requireTools &&
      /does not support tools/i.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      return streamAiSdk(
        { ...normalizedParams, tools: undefined, runTools: undefined },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    throw error;
  }
}

/**
 * Provider model capabilities can change ahead of the SDK's shared types.
 * Retry request-validation failures at the nearest level advertised by the
 * provider, before any stream content has been emitted.
 */
export function fallbackReasoningLevelFromProviderError(
  error: unknown,
  requested: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  if (!requested) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const marker = "supported values are:";
  const markerIndex = message.toLocaleLowerCase().indexOf(marker);
  if (markerIndex < 0) return undefined;
  const supportedText = message.slice(markerIndex + marker.length).trimStart();
  if (!supportedText) return undefined;

  const supported = [...supportedText.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter(
      (level): level is ReasoningLevel =>
        !!level && (REASONING_LEVELS as readonly string[]).includes(level),
    );
  if (!supported.length || supported.includes(requested)) return undefined;

  const requestedIndex = REASONING_LEVELS.indexOf(requested);
  return supported.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(
      REASONING_LEVELS.indexOf(nearest) - requestedIndex,
    );
    const candidateDistance = Math.abs(
      REASONING_LEVELS.indexOf(candidate) - requestedIndex,
    );
    return candidateDistance <= nearestDistance ? candidate : nearest;
  });
}

export async function completeWithProvider(
  params: CompleteProviderParams,
): Promise<string> {
  return completeAiSdkText(
    params,
    await createProviderAdapter(params.model, params.apiKeys),
  );
}
