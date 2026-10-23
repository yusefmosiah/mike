// Shared types for the LLM provider adapter.
import type { TurnContextSection } from "./turnContext";

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
    /**
     * Start a subagent from this call and wait for its report: set on a
     * parent turn's calls when it may delegate (the code a `run_python` call
     * runs calls it as `tools.delegate`).
     */
    delegate?: (input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
    /**
     * The conversation's whole history, compacted messages included, as
     * `tools.history_search` and `tools.history_read` (lib/llm/pi/history.mts).
     */
    history?: {
        search: (input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
        read: (input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
    };
    /**
     * The chat's background subagents, as `tools.list_agents`,
     * `tools.message_agent`, `tools.agent_inbox` and `tools.stop_agent`: set
     * on a parent turn's calls when it may start background subagents, and
     * on a background subagent's own calls (which may list and message only).
     */
    agents?: AgentOps;
};

/** A reply the model reads, or a refusal it can act on. */
export type ToolReply = { content: string; isError: boolean };

/** What code can do with a chat's background subagents (lib/llm/pi/runtime.mts). */
export type AgentOps = {
    list: () => Promise<ToolReply>;
    send: (input: Record<string, unknown>) => Promise<ToolReply>;
    /** The parent's unread reports and messages; absent for a subagent. */
    inbox?: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolReply>;
    /** Stop a background subagent; absent for a subagent. */
    stop?: (input: Record<string, unknown>) => Promise<ToolReply>;
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

export type TurnIdentity = {
    userMessageId: string | null;
    parentMessageId: string | null;
    assistantMessageId: string;
    /**
     * Set when the parent is an assistant answer the person interrupted while
     * it was read aloud: what the model should see in that answer's place
     * (the spoken prefix and a marker). Runtimes with their own transcript
     * continue from a copy of the parent whose answer is this text instead.
     */
    parentHeard?: string;
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
     * Reasoning effort. Bulk extraction jobs should leave this unset; the
     * runtime maps an omitted level to "off" to save tokens and latency, except
     * for a configured reasoning model, which runs at its declared default.
     * A model that cannot turn reasoning off gets its lightest effort for
     * "none" (see lib/llm/pi/providers.mts).
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
    /**
     * The read-only memory turn, when `messages` starts with one. Runtimes that
     * keep their own transcript (the Pi spike) take it out of the history and
     * render it with the system prompt instead.
     */
    memoryMessage?: LlmMessage;
    /**
     * This turn's context (./turnContext.ts): the facts that vary from turn
     * to turn, kept out of `systemPrompt` so it stays byte-identical for the
     * life of a chat. Runtimes with their own transcript send only the
     * sections the model has not already seen, in the user's message.
     */
    turnContext?: TurnContextSection[];
    /**
     * The stored identity of this turn, when the caller keeps a message tree:
     * the user message, its tree parent, and the assistant row reserved for
     * the answer. Runtimes with their own transcript map these to it.
     */
    turn?: TurnIdentity;
    /**
     * The stored answer this request continues: the assistant row a turn
     * paused on to ask, which the person's answers resume. Set instead of
     * `turn`, which a continuation does not have.
     */
    continuesAnswer?: string;
    /**
     * Make this turn survive the process. `context` is the caller's own record
     * of how to drive the turn again (opaque here, JSON only); after a restart
     * the caller re-drives it with `resume: true`, which attaches to the run
     * already in flight instead of sending the input again. Needs `turn`.
     */
    durableTurn?: { context: Record<string, unknown>; resume?: boolean };
    /**
     * Let the turn delegate to subagents: its tool calls carry `delegate`,
     * whose children this host checks and reports on. Omitted, there is no
     * delegation (a child turn never has it: depth 1).
     */
    subagents?: SubagentHost;
    /**
     * The person's auto-compact threshold for this model, in tokens: compact
     * the transcript once its context passes it. Unset, the runtime uses its
     * default for the model's window.
     */
    autocompactTokens?: number;
    /**
     * The conversation's memory as it is now, fenced as `memoryMessage` is:
     * a compaction replaces the thread's first message, which carried the
     * memory the thread started with, so each summary carries a fresh copy.
     * Null when no memory is enabled.
     */
    memoryAtCompaction?: () => Promise<string | null>;
};

/** The first line of the delegate tool's description; the host appends the model memo. */
export const DELEGATE_TOOL_SUMMARY =
    "Hand a self-contained task to a subagent and get its report back. The subagent sees nothing of this conversation except the task and the documents you name, works with the tools its type allows, and cannot talk to the user. Delegate calls run at the same time when you gather them (`await tools.gather(tools.delegate(...), tools.delegate(...))`), so split independent work into separate calls.";

/**
 * A child the `delegate` tool may start: what the parent turn's host decided
 * from the call (type, model, instructions, tools, budgets) and the child's
 * own tool runner, which only reaches those tools.
 */
export type SubagentSpec = {
    type: string;
    /** Mike model id. */
    model: string;
    reasoning?: ReasoningLevel;
    /** The child's system instructions. */
    instructions: string;
    /** Mike tools the child may call, all already offered to the parent. */
    tools: string[];
    /** The child's first and only input. */
    task: string;
    maxRounds: number;
    /** Output tokens the child may spend across its run. */
    maxOutputTokens: number;
    timeoutMs: number;
    apiKeys?: UserApiKeys;
    runTools: NonNullable<StreamChatParams["runTools"]>;
    /** Called once the child has finished, however it ended. */
    cleanup?: () => void;
};

/** How a child's run ended, as the parent's host is told. */
export type SubagentOutcome = {
    callId: string;
    childId: string;
    status: "done" | "failed" | "timed_out" | "stopped";
    /** The child's final answer, or why there is none. */
    report: string;
    usage: { input: number; output: number; cost: number };
};

/**
 * A parent turn's side of delegation (see modules/chat/engine/subagents).
 * The runtime owns the child's conversation, limits and records; the host
 * checks a call and tells the parent's stream and transcript about the child.
 */
export type SubagentHost = {
    /**
     * The delegate tool's description, model-selection memo included. It is
     * the same for every user: per-user choices (types, allowed models)
     * belong in the turn context.
     */
    toolDescription: string;
    /**
     * Set when the person allows background subagents: children started with
     * `background: true` keep working after the turn ends, report into the
     * chat when they finish, and may be messaged. `timeoutMs` bounds each of
     * a background child's runs.
     */
    background?: { timeoutMs: number };
    /** The child's spec, or the refusal the model reads instead. */
    prepare: (input: Record<string, unknown>) => Promise<SubagentSpec | string>;
    started?: (child: {
        callId: string;
        childId: string;
        address: string;
        type: string;
        model: string;
        task: string;
        /** Set for a background child: its name in the chat, such as research-1. */
        name?: string;
    }) => void;
    finished?: (child: SubagentOutcome) => void;
};

// The envelope and transcript are wire shapes, declared with the API contracts.
export type { SubagentEnvelope, SubagentTranscript } from "@mike/contracts";

export type StreamChatResult = {
    fullText: string;
    /**
     * Tokens and cost this turn's own model responses spent, subagents not
     * included (each reports its own). Absent when it could not be measured.
     */
    usage?: { input: number; output: number; cost: number };
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
    /**
     * Heading the model is listed under in the model pickers, normally the
     * provider serving it ("Phala (encrypted)"). Defaults to "Configured".
     */
    group?: string;
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
    attestation?:
        | {
              /** Base URL of the verifier; the request goes to `{endpoint}/attestation`. */
              endpoint: string;
              /** TEE measurement the endpoint must report; a mismatch fails closed. */
              expectedMeasurement: string;
          }
        | {
              /**
               * Attested Confidential Inference (Phala's gateway): a TDX quote
               * verified to Intel's root, bound to a fresh nonce, with TLS
               * pinned to the attested keys (lib/llm/attestation/aci.ts).
               */
              scheme: "aci";
              /** Source repository the workload must be built from (default: Phala's gateway). */
              repoUrl: string;
              /** Optional pin on the exact measured app compose (sha256 hex). */
              composeHash?: string;
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
    /**
     * Total tokens (input and output) the model accepts. Drives compaction and
     * the output budget; omitted, Mike assumes a conservative 128,000 and warns.
     */
    contextWindow?: number;
    /** Most output tokens one response may use. */
    maxOutputTokens?: number;
    /** How the endpoint reasons. Omitted, the model is treated as non-reasoning. */
    reasoning?: ConfiguredReasoning;
    /** Price in US dollars per million tokens, so spend is visible. Omitted, zero. */
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /**
     * Longest silence (ms) tolerated on a response stream once it is flowing.
     * Defaults to CONFIGURED_STREAM_IDLE_TIMEOUT_MS for configured models.
     */
    streamIdleTimeoutMs?: number;
};

/** Reasoning efforts a configured model may declare, lightest first (pi-ai's thinking levels). */
export const CONFIGURED_REASONING_EFFORTS = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type ConfiguredReasoningEffort =
    (typeof CONFIGURED_REASONING_EFFORTS)[number];

/**
 * A reasoning model's controls. Reasoning models are not built to run without
 * reasoning: unless `canDisable` is true, a request for no reasoning is sent at
 * the lightest declared effort instead.
 */
export type ConfiguredReasoning = {
    /** Efforts the endpoint accepts, lightest first. Sent verbatim. */
    efforts: ConfiguredReasoningEffort[];
    /** Effort used when Mike asks for none in particular. */
    default: ConfiguredReasoningEffort;
    /** Whether reasoning can be turned off at all. */
    canDisable: boolean;
    /** Effort value that turns reasoning off, when `canDisable` (default "none"). */
    offValue?: string;
    /**
     * Request field carrying the effort: `reasoning_effort` (top level, the
     * OpenAI convention), `reasoning.effort` (OpenRouter's nested object), or
     * `none` when the model reasons with no control field.
     */
    param: "reasoning_effort" | "reasoning.effort" | "none";
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
