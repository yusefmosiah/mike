// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider =
    | "claude"
    | "gemini"
    | "openai"
    | "openai-compatible"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "ollama";

export const REASONING_LEVELS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmTextPart = {
    type: "text";
    text: string;
};

export type LlmImagePart = {
    type: "image";
    /** Raw image bytes, a base64 string, or a URL. Never pre-encode Buffers. */
    image: Buffer | Uint8Array | string | URL;
    mimeType?: string;
    /**
     * What a text-only model receives in place of the image. Required so a
     * fail-closed downgrade never silently drops the image's content.
     */
    fallbackText: string;
};

export type LlmUserContent = string | Array<LlmTextPart | LlmImagePart>;

export type LlmMessage =
    | { role: "user"; content: LlmUserContent }
    | { role: "assistant"; content: string };

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
    openrouter?: string | null;
    vercel?: string | null;
    "opencode-go"?: string | null;
    courtlistener?: string | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Require the selected provider to preserve tool calling. Curator jobs set
     * this so a provider capability error is retryable instead of silently
     * degrading into a tool-less response that looks like "no change".
     */
    requireTools?: boolean;
    /**
     * AI SDK reasoning effort. Bulk extraction jobs should leave this unset;
     * the SDK adapter maps an omitted level to "none" to save tokens and
     * latency.
     */
    reasoning?: ReasoningLevel;
    abortSignal?: AbortSignal;
    /**
     * Durable id of the conversation this request belongs to. Adapters use it
     * to keep provider prefix caches warm across turns (an OpenAI
     * prompt_cache_key, an Anthropic cache breakpoint). Leave unset for
     * one-shot calls such as the memory curator.
     */
    conversationId?: string | null;
};

export type StreamChatResult = {
    fullText: string;
};

// ---------------------------------------------------------------------------
// Configured models
// ---------------------------------------------------------------------------
// The static catalog in models.ts covers the hosted providers Mike ships with.
// Deployments that also run self-hosted or third-party OpenAI-compatible
// endpoints declare them through MIKE_MODEL_CONFIG_JSON; see registry.ts.

export type ModelLocation = "cloud" | "local";

export type ConfiguredModel = {
    id: string;
    provider: "openai-compatible";
    location: ModelLocation;
    label?: string;
    /** Model name to send upstream when it differs from the Mike-facing id. */
    apiModel?: string;
    baseUrl: string;
    /**
     * Remote-attestation requirement for this endpoint. When declared, every
     * inference request first verifies the endpoint's attestation document
     * (lib/llm/attestation) and fails closed on any verification error. There
     * is deliberately no insecure bypass. The expected measurement is
     * required: without a pin the lane would accept whatever the endpoint
     * self-reports.
     */
    attestation?: {
        /** Base URL of the verifier; the request goes to `{endpoint}/attestation`. */
        endpoint: string;
        /** TEE measurement the endpoint must report; a mismatch fails closed. */
        expectedMeasurement: string;
    };
    apiKeyEnv?: string;
    apiKeyProvider?: keyof UserApiKeys;
    apiKey?: string;
    /**
     * Local models frequently emit tool calls as prose rather than as
     * structured tool-call fields. Leave unset to infer from `location`.
     */
    tolerateTextToolCalls?: boolean;
    /**
     * Whether this endpoint accepts image content parts. Omitted means false:
     * an image sent to a text-only model fails the whole request, so vision
     * must be declared explicitly (fail closed).
     */
    supportsVision?: boolean;
    /** Request field used for the output-token limit by the compatible endpoint. */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
};

/**
 * A committee answers one prompt with several models and has a chair model
 * synthesize their replies into the single response the caller sees.
 */
export type CommitteeModel = {
    id: string;
    label?: string;
    members: Array<
        | string
        | {
              id?: string;
              model: string;
              label?: string;
              systemPrompt?: string;
          }
    >;
    chair: string;
    strategy?: "synthesize";
};
