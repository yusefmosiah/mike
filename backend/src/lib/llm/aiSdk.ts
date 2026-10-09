import { randomUUID } from "node:crypto";
import type { LanguageModel, ToolSet } from "ai" with {
  "resolution-mode": "import",
};
import type * as AiSdk from "ai" with { "resolution-mode": "import" };
import type {
  LlmUserContent,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  Provider,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { streamChunkTimeouts } from "../runtimeConfig";
import { assertEgressAllowed } from "../egress";
import { clampThresholdPercent, contextTokensFromUsage } from "../compaction/policy";
import { asProviderStallError, toProviderStreamError } from "./providerErrors";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";
import {
  maxOutputTokensForOpenCodeGoModel,
  modelSupportsVision,
} from "./models";
import { repairToolArguments } from "./toolCallParsing";
import {
  compactModelMessages,
  replayConversationCompaction,
} from "./conversationCompaction";

/**
 * Per-step output limit, or undefined to leave it to the provider.
 *
 * Unset by default: each provider applies its own model-aware ceiling
 * (`@ai-sdk/anthropic` fills in the model's maximum for the required
 * `max_tokens`), which a single shared number cannot track. Operators who want
 * a backstop set `LLM_MAX_OUTPUT_TOKENS`; an unusable value is ignored rather
 * than sent upstream.
 *
 * OpenCode Go resolves each model's canonical maximum output capacity from
 * Models.dev (https://models.dev/providers/opencode-go/): e.g. 384,000 for
 * DeepSeek V4/V4.1, 500,000 for Grok, 131,072 for GLM-5/Qwen3.8.
 */
export function maxOutputTokensFor(
  provider: Provider,
  modelId?: string,
): number | undefined {
  const value = Number(process.env.LLM_MAX_OUTPUT_TOKENS);
  if (Number.isSafeInteger(value) && value > 0) return value;
  return provider === "opencode-go"
    ? maxOutputTokensForOpenCodeGoModel(modelId)
    : undefined;
}

/**
 * Tool-call rounds allowed per turn before `stopWhen` halts the run.
 *
 * 16, matching what the Word pane already passes. Document-heavy turns spend
 * several rounds just reading before any real work starts, and when this cap
 * fires the run simply ends — no error, no partial answer — so a value that is
 * merely "usually enough" fails invisibly. Callers may still override it.
 */
export const DEFAULT_MAX_ITERATIONS = 16;

/**
 * User-facing explanation for a turn that ended without finishing, or "" when
 * it ended normally.
 *
 * Exported for tests: the conditions are easy to get subtly wrong, and wrong
 * here means either a spurious warning under every good answer or silence
 * under every bad one.
 */
export function stopNotice(
  iterations: number,
  maxIterations: number,
  finishReason: string | undefined,
): string {
  if (finishReason === "length") {
    return "\n\n_Stopped early: this response reached the model's output limit. Asking for one part at a time will get the rest._";
  }
  // Reaching the last round while still asking for tools means the model was
  // mid-work when stopWhen cut it off. Reaching it on "stop" means it had
  // finished and the round count is a coincidence, so say nothing.
  if (iterations >= maxIterations && finishReason !== "stop") {
    return `\n\n_Stopped after ${maxIterations} tool-call rounds without finishing. This is a step limit, not a length limit — narrowing the request, or pointing at fewer documents, usually resolves it._`;
  }
  return "";
}

/** Ensure a proxy-closed final SSE event is still visible to SDK parsers. */
export async function aiSdkFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof input === "object" && input !== null && "url" in input
          ? (input as Request).url
          : "";
  // Every provider SDK calls this with an absolute http(s) URL; a relative or
  // empty value could not be fetched either (Node's fetch requires an
  // absolute URL), so the gate only runs where a request could actually
  // leave. A blocked host throws here, before any bytes or credentials.
  if (/^https?:\/\//i.test(url)) {
    await assertEgressAllowed(url, "llm");
  }
  let requestInit = init;
  if (url.includes("opencode.ai")) {
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && input !== null && "headers" in input
          ? (input as Request).headers
          : undefined),
    );
    if (!headers.has("x-opencode-session")) {
      headers.set("x-opencode-session", randomUUID());
    }
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "mike-legal-agent/1.0");
    }
    requestInit = { ...init, headers };
  }
  const response = await fetch(input, requestInit);
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const partials = new Map<number, { name: string; arguments: string }>();

  const validateToolCalls = (endedCleanly: boolean) => {
    for (const partial of partials.values()) {
      if (!partial.arguments) {
        if (!endedCleanly) {
          throw new Error(
            `LLM stream ended before any arguments arrived for tool "${partial.name}".`,
          );
        }
        continue;
      }
      try {
        JSON.parse(partial.arguments);
      } catch {
        // A clean terminal event proves that the transport delivered the
        // complete provider response. Preserve malformed arguments exactly as
        // sent so AI SDK can emit its recoverable dynamic tool-error instead
        // of preempting its tool-validation path. A stream that just closes is
        // still unsafe: its partial arguments must fail before any tool could
        // run.
        if (!endedCleanly) {
          throw new Error(
            `LLM stream ended with malformed JSON arguments for tool "${partial.name}".`,
          );
        }
      }
      if (!endedCleanly) {
        throw new Error(
          `LLM stream ended before a clean terminal event for tool "${partial.name}".`,
        );
      }
    }
    partials.clear();
  };

  const inspectLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      validateToolCalls(true);
      return;
    }
    if (!data) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const choice = (
      event.choices as
        | Array<{
            delta?: { tool_calls?: Array<Record<string, unknown>> };
            finish_reason?: unknown;
          }>
        | undefined
    )?.[0];
    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const index = typeof toolCall.index === "number" ? toolCall.index : 0;
      const current = partials.get(index) ?? { name: "tool", arguments: "" };
      const fn = toolCall.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") current.name = fn.name;
      if (typeof fn?.arguments === "string") {
        current.arguments += fn.arguments;
      }
      partials.set(index, current);
    }
    if (choice?.finish_reason === "tool_calls") validateToolCalls(true);
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          inspectLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) inspectLine(buffer);
        if (partials.size) validateToolCalls(false);
        controller.enqueue(new Uint8Array([10, 10]));
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const COURTLISTENER_CITATION_REMINDER_TOOL_NAMES = new Set([
  "courtlistener_find_in_case",
  "courtlistener_read_case",
]);

const COURTLISTENER_CITATION_REMINDER = `COURTLISTENER CITATION REMINDER:
If your final answer relies on any CourtListener case, every such case reference must have BOTH a clickable markdown case link and an inline [N] marker.
Include the clickable case link only the first time you cite that case; later references to the same case should reuse the existing inline [N] marker without repeating the link unless clarity requires it.
Assign new refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
End the response with a <CITATIONS> block containing one matching case entry per [N] marker:
{"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
Do not use doc_id, page, top-level quote, case_name, or citation fields for CourtListener case entries.`;

export type AiSdkAdapterConfig = {
  provider: Provider;
  label: string;
  model: LanguageModel;
  modelId: string;
  /** Some protocol-compatible gateways reject reasoning request fields. */
  supportsReasoning?: boolean;
  /** OpenAI's CourtListener tools require an extra instruction after use. */
  courtlistenerCitationReminder?: boolean;
};

type PendingToolExecution = {
  call: NormalizedToolCall;
  resolve: (content: string) => void;
  reject: (error: unknown) => void;
};

/**
 * AI SDK executes all tool calls from a step concurrently. Collect those
 * same-tick executions so the existing provider-neutral runTools contract
 * still receives one batch per model step.
 */
class ToolExecutionBatcher {
  private pending: PendingToolExecution[] = [];
  private scheduled = false;

  constructor(
    private readonly runTools: NonNullable<StreamChatParams["runTools"]>,
    /** Fired synchronously when runTools rejects, before the SDK learns of it. */
    private readonly onFailure?: (error: unknown) => void,
  ) {}

  execute(call: NormalizedToolCall): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.push({ call, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    this.scheduled = false;

    try {
      const results = await this.runTools(pending.map(({ call }) => call));
      const byId = new Map(
        results.map((result: NormalizedToolResult) => [
          result.tool_use_id,
          result.content,
        ]),
      );
      for (const item of pending) {
        const content = byId.get(item.call.id);
        if (content === undefined) {
          const error = new Error(
            `Tool ${item.call.name} returned no result for call ${item.call.id}.`,
          );
          this.onFailure?.(error);
          item.reject(error);
        } else {
          item.resolve(content);
        }
      }
    } catch (error) {
      this.onFailure?.(error);
      for (const item of pending) item.reject(error);
    }
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function toAiSdkTools(
  schemas: OpenAIToolSchema[],
  runTools?: StreamChatParams["runTools"],
  sdk?: Pick<typeof AiSdk, "jsonSchema" | "tool">,
  onRunToolsFailure?: (error: unknown) => void,
): ToolSet | undefined {
  if (!schemas.length) return undefined;
  if (!sdk) throw new Error("AI SDK tool helpers are unavailable.");
  const batcher = runTools
    ? new ToolExecutionBatcher(runTools, onRunToolsFailure)
    : null;

  return Object.fromEntries(
    schemas.map((schema) => {
      const definition = {
        description: schema.function.description,
        inputSchema: sdk.jsonSchema<Record<string, unknown>>(
          schema.function.parameters as never,
        ),
        ...(batcher
          ? {
              execute: (
                input: unknown,
                { toolCallId }: { toolCallId: string },
              ) => {
                // Some adapters hand execute() the raw argument text instead
                // of a parsed object. Recover it through the shared ladder;
                // when even that fails, resolve with an in-band error result
                // (Station 4) instead of throwing, so the SDK feeds it back
                // and the model can re-emit instead of the run aborting.
                if (typeof input === "string") {
                  const repaired = repairToolArguments(input);
                  if (!repaired.ok) {
                    return Promise.resolve(
                      `Tool call failed: ${schema.function.name} arguments invalid (${repaired.error}). Re-emit with properly escaped JSON.`,
                    );
                  }
                  return batcher.execute({
                    id: toolCallId,
                    name: schema.function.name,
                    input: repaired.input,
                  });
                }
                return batcher.execute({
                  id: toolCallId,
                  name: schema.function.name,
                  input: normalizeToolInput(input),
                });
              },
            }
          : {}),
      };
      return [schema.function.name, sdk.tool(definition as never)];
    }),
  );
}

function errorMessage(error: unknown, label: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `${label} stream failed.`;
}

/**
 * The ORIGINAL Error instance from a `tool-error` / `error` part. Re-wrapping
 * it discards error identity, including control-flow and user-facing error
 * types thrown inside runTools (the SDK's tool `execute`).
 */
function rethrowable(error: unknown, label: string): Error {
  return error instanceof Error ? error : new Error(errorMessage(error, label));
}

function usesCourtlistenerTool(
  steps: Array<{ toolCalls: Array<{ toolName: string }> }>,
) {
  return steps.some((step) =>
    step.toolCalls.some((call) =>
      COURTLISTENER_CITATION_REMINDER_TOOL_NAMES.has(call.toolName),
    ),
  );
}

/**
 * Translate Mike's structured user content into AI SDK content parts.
 *
 * Text parts always survive. An image part becomes a `file` part only when the
 * target model can read images; otherwise the model receives the part's
 * fallback text, because an image sent to a text-only model fails the entire
 * request (fail closed). Buffers are handed to the SDK as raw bytes — the
 * provider adapter owns transport encoding — so nothing is base64-encoded
 * here.
 */
function toAiSdkContent(
  content: LlmUserContent,
  supportsVision: boolean,
): string | AiSdk.UserContent {
  if (typeof content === "string") return content;
  if (!supportsVision) {
    return content
      .map((part) => (part.type === "text" ? part.text : part.fallbackText))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "file" as const,
          data: part.image,
          mediaType: part.mimeType ?? "image/png",
        },
  );
}

/**
 * Provider-specific hints that let a multi-turn conversation reuse the
 * already-processed prompt prefix instead of paying for it on every turn.
 *
 * OpenAI caches automatically but routes by `prompt_cache_key`; sending the
 * conversation id keeps consecutive turns on the same cache. Anthropic only
 * caches up to an explicit breakpoint, so the last message gets one: it
 * covers the system prompt, tool definitions, and every earlier turn, and
 * the next request hits that prefix as long as it is byte-identical.
 * Providers ignore namespaces they do not own, so both hints are sent.
 *
 * Every message is also translated from the LlmMessage union to AI SDK
 * content; `supportsVision` decides whether image parts travel as file parts
 * or as their text fallback. It defaults to the requested model so callers
 * that only pass a model id behave correctly.
 */
type StreamTextProviderOptions = NonNullable<
  Parameters<typeof AiSdk.streamText>[0]["providerOptions"]
>;

export function withPrefixCacheHints(
  params: StreamChatParams,
  supportsVision: boolean = modelSupportsVision(params.model),
): {
  messages: AiSdk.ModelMessage[];
  providerOptions?: StreamTextProviderOptions;
} {
  const messages: AiSdk.ModelMessage[] = params.messages.map(
    (message): AiSdk.ModelMessage =>
      message.role === "assistant"
        ? { role: "assistant", content: message.content }
        : {
            role: "user",
            content: toAiSdkContent(message.content, supportsVision),
          },
  );
  if (!params.conversationId || !messages.length) {
    return { messages };
  }
  const last = messages.length - 1;
  const breakpoint = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  };
  return {
    messages: messages.map((message, index): AiSdk.ModelMessage =>
      index === last ? { ...message, providerOptions: breakpoint } : message,
    ),
    providerOptions: {
      openai: { promptCacheKey: params.conversationId },
    },
  };
}

export function extractEarlyToolCall(raw: unknown): { name: string; id?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // 1. OpenAI / OpenCode Go / vLLM / DeepSeek format
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
      const tc = delta.tool_calls[0] as Record<string, unknown> | undefined;
      const fn = tc?.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      if (name) {
        return { name, id: typeof tc?.id === "string" ? tc.id : undefined };
      }
    }
  }

  // 2. Anthropic format
  if (obj.type === "content_block_start") {
    const cb = obj.content_block as Record<string, unknown> | undefined;
    if (cb?.type === "tool_use" && typeof cb.name === "string" && cb.name) {
      return { name: cb.name, id: typeof cb.id === "string" ? cb.id : undefined };
    }
  }

  // 3. Google Gemini format
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown> | undefined;
    const content = candidate?.content as Record<string, unknown> | undefined;
    if (Array.isArray(content?.parts)) {
      for (const part of content.parts as Record<string, unknown>[]) {
        const fc = part?.functionCall as Record<string, unknown> | undefined;
        if (typeof fc?.name === "string" && fc.name) {
          return { name: fc.name };
        }
      }
    }
  }

  return null;
}

// Provider errors that explicitly say the *input* context no longer fits the
// model's window. Kept narrow on purpose: an output-length limit, auth
// failure, rate limit, tool fault or cancel must never be treated as a
// context overflow and retried. Canonical exceeded codes qualify; a bare
// context_window field in unrelated validation metadata does not.
const CONTEXT_OVERFLOW_PATTERN =
  /\b(?:context_(?:length|window)_exceeded|prompt is too long|too many (?:input|prompt) tokens|reduce the length of the messages|(?:input token count|(?:maximum )?context (?:length|window))(?:\s+(?:is\s+|of\s+)?\(?\d[\d,]*\)?(?:\s+tokens?)?,?)?\s+(?:(?:is|was|has been|which)\s+)?(?:exceed(?:s|ed)?|too (?:long|large))|(?:prompt|input|messages)(?: (?:length|size|tokens|token count))?(?: (?:of )?\(?\d[\d,]*\)?(?: tokens)?)?(?: (?:plus|and)(?: \d[\d,]*)? (?:requested )?completion (?:tokens|length))? exceed(?:s|ed)? (?:maximum(?: allowed)? |this |the )?(?:model's )?context (?:length|window))\b/i;
const CONTEXT_REQUESTED_TOKENS_PATTERN =
  /\bmaximum context (?:length|window)\b\s*(?:is\s+|of\s+|:\s*)?(\d+(?:,\d{3})*)\s+tokens\b[^\n]{0,200}\b(?:you )?requested\s+(\d+(?:,\d{3})*)\s+tokens\b/i;
const NON_CONTEXT_OVERFLOW_PATTERN =
  /\b(?:rate[ _]?limit|quota|api[ _-]?key|unauthori[sz]ed|per minute|tpm|timed? out|abort(?:ed)?|cancel(?:led|ed)?)\b/i;
const OUTPUT_CAP_ERROR_PATTERN =
  /\b(?:max_(?:completion_)?tokens[_ ](?:too_(?:large|high)|is too (?:large|high))|too many tokens (?:requested )?for (?:output|completion)|(?:maximum|at most|supports)\s+(?:of\s+)?(?:\d[\d,]*\s+)?(?:output|completion) tokens)\b/i;

function isOverflowDiagnostic(text: string): boolean {
  if (CONTEXT_OVERFLOW_PATTERN.test(text)) return true;
  const counts = CONTEXT_REQUESTED_TOKENS_PATTERN.exec(text);
  if (!counts) return false;
  const limit = Number(counts[1].replaceAll(",", ""));
  const requested = Number(counts[2].replaceAll(",", ""));
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(requested) && requested > limit;
}

type ErrorChainNode = {
  name?: unknown;
  message?: unknown;
  statusCode?: unknown;
  responseBody?: unknown;
  code?: unknown;
  data?: unknown;
  cause?: unknown;
  lastError?: unknown;
};

// Match actual diagnostic fields separately, never serialized limit/help
// metadata or prose assembled across unrelated JSON fields. Bounded traversal
// also handles nested provider errors without trusting malformed JSON bodies.
function providerErrorDiagnostics(value: unknown): string[] {
  const texts: string[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  for (let index = 0; index < pending.length && index < 16; index++) {
    let item = pending[index];
    if (typeof item === "string") {
      const trimmed = item.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          item = JSON.parse(item);
        } catch {
          continue;
        }
      } else {
        texts.push(item);
        continue;
      }
    }
    if (!item || typeof item !== "object" || Array.isArray(item) || seen.has(item)) continue;
    seen.add(item);
    const fields = item as Record<string, unknown>;
    for (const field of ["message", "code", "type", "error", "detail"]) {
      if (fields[field] != null) pending.push(fields[field]);
    }
  }
  return texts;
}

/**
 * True only when the failure is the provider stating the prompt no longer
 * fits the model's context window (OpenAI/DeepSeek "maximum context length",
 * Anthropic "prompt is too long", Gemini "input token count ... exceeds").
 * The whole cause chain is inspected — the SDK wraps provider failures in
 * RetryError and our own guard re-wraps abort-shaped ones — and any level
 * that reads as a cancel, auth, rate-limit or output failure disqualifies the
 * error so the single recovery retry is spent only where a smaller prompt can
 * actually help.
 */
function isExplicitContextOverflow(error: unknown): boolean {
  let matched = false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "string") {
      const texts = providerErrorDiagnostics(current);
      if (texts.some((text) => NON_CONTEXT_OVERFLOW_PATTERN.test(text) || OUTPUT_CAP_ERROR_PATTERN.test(text))) return false;
      if (texts.some(isOverflowDiagnostic)) matched = true;
      break;
    }
    if (typeof current !== "object") break;
    const node = current as ErrorChainNode;
    if (node.name === "AbortError") return false;
    const texts = [node.message, node.responseBody, node.code, node.data]
      .flatMap(providerErrorDiagnostics);
    if (texts.some((text) => NON_CONTEXT_OVERFLOW_PATTERN.test(text) || OUTPUT_CAP_ERROR_PATTERN.test(text))) return false;
    const status = typeof node.statusCode === "number" ? node.statusCode : null;
    if (status !== null && status !== 400 && status !== 413) return false;
    if (texts.some(isOverflowDiagnostic)) {
      matched = true;
    }
    current = node.lastError ?? node.cause;
  }
  return matched;
}

export async function streamAiSdk(
  params: StreamChatParams,
  config: AiSdkAdapterConfig,
): Promise<StreamChatResult> {
  const sdk = await import("ai");
  // Internal abort linked to the caller's signal: a runTools failure (e.g. the
  // ask_inputs pause) ends the turn, but the SDK's step loop would fire the
  // NEXT model request before this consumer sees the `tool-error` part — so
  // abort synchronously in the batcher's failure path and keep that first
  // failure (the stream may surface an `abort` part before the `tool-error`).
  // A context-overflow recovery retries the turn with a reduced transcript, so
  // every model attempt owns a fresh controller; the (once-built) tools abort
  // whichever attempt is live.
  let attemptAbort = new AbortController();
  const forwardAbort = () => attemptAbort.abort(params.abortSignal?.reason);
  if (params.abortSignal?.aborted) forwardAbort();
  else params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const runToolsFailure: { first: { error: unknown } | null } = { first: null };
  // Call IDs actually dispatched to runTools whose results are not yet part
  // of the working transcript. A failed step never reaches the onStepEnd
  // commit below, so a non-empty set means real side effects already ran that
  // the next prompt would not represent — the single overflow recovery must
  // refuse then, or the model could re-issue those calls. Merely announcing a
  // tool call is not enough to arm this: only an actual runTools dispatch
  // counts. An aborted SDK stream does not cancel runTools itself, so neither
  // the abort below nor an abort-shaped provider error may clear it.
  const uncommittedToolDispatches = new Set<string>();
  const runTools = params.runTools;
  const tools = toAiSdkTools(
    params.tools ?? [],
    runTools
      ? async (calls: NormalizedToolCall[]) => {
          for (const call of calls) uncommittedToolDispatches.add(call.id);
          return runTools(calls);
        }
      : undefined,
    sdk,
    (error) => {
      runToolsFailure.first ??= { error };
      attemptAbort.abort();
    },
  );
  // An exception that merely LOOKS like an abort (name "AbortError" or
  // isAbortError's exact message) must not take streaming.ts's silent
  // user-cancel path unless the caller's signal really is aborted.
  const guardAbortShaped = (e: Error): Error =>
    params.abortSignal?.aborted ||
    (e.name !== "AbortError" && e.message !== "Stream aborted.")
      ? e
      : new Error(
          e.message === "Stream aborted."
            ? "Stream aborted. (no abort was requested; treated as an error)"
            : e.message,
          { cause: e },
        );
  const cacheHints = withPrefixCacheHints(params);
  const providerOptions: StreamTextProviderOptions = {
    ...(cacheHints.providerOptions ?? {}),
    ...(config.provider === "openrouter"
      ? {
          // OpenRouter's adapter does not consume AI SDK's call-level
          // `reasoning` option. Its per-request namespace is merged into the
          // outbound body, so mirror the selected level there as well.
          openrouter: {
            reasoning: { effort: params.reasoning ?? "none" },
          },
        }
      : {}),
  };
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: config.provider,
    model: config.modelId,
  });
  let fullText = "";
  let iteration = 0;
  // Text the current step has streamed so far. Reset at every step boundary,
  // so when a step fails it holds only that step's uncommitted prose — a
  // recovery retry can replay it without duplicating a completed step's text.
  let stepText = "";
  const openReasoningBlocks = new Set<string>();
  const notifiedEarlyToolCalls = new Set<string>();
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastFinishReason: string | undefined;

  // Token-triggered compaction runs on the OpenCode Go route only; every other
  // provider sends the caller's transcript through untouched.
  const compactionEnabled = config.provider === "opencode-go";
  const thresholdPct = compactionEnabled
    ? clampThresholdPercent(Number(process.env.LLM_COMPACTION_THRESHOLD_PERCENT?.trim() || Number.NaN))
    : undefined;
  // Preflight replay: the raw transcript is run through the deterministic
  // checkpoint sequence, so the same conversation (plus appended turns)
  // always yields the same compacted prefix. No per-conversation store is
  // needed to keep the provider's KV-cache prefix stable across invocations.
  let sessionMessages: AiSdk.ModelMessage[] = cacheHints.messages;
  if (compactionEnabled) {
    const preflight = replayConversationCompaction({
      messages: cacheHints.messages,
      modelId: config.modelId,
      systemPrompt: params.systemPrompt,
      tools: params.tools,
      thresholdPct,
    });
    if (preflight.compacted) sessionMessages = preflight.messages;
  }
  // Newest transcript the SDK has been shown: what the next model request
  // carries, including every completed step's response messages. The post-turn
  // checkpoint rewrites it at each tool-loop boundary and the next prepareStep
  // hands it back, so a compaction carries into the next round and into the
  // overflow retry.
  //
  // The checkpoint lives only for this call: the caller's persisted transcript
  // is never mutated and no extra result fields are added. That is enough for
  // the next invocation, because its preflight replay reconstructs the same
  // checkpoint from the same raw transcript. The one limitation to know: a
  // checkpoint whose trigger existed ONLY in provider usage (never in the
  // estimate) is not reconstructed by a later invocation's replay — nothing
  // durable records it. Persisting provider-usage checkpoints would need a
  // caller-side store, which is deliberately out of scope here.
  let workingMessages: AiSdk.ModelMessage[] = sessionMessages;
  // Latest step's provider-reported prompt + output tokens, never summed
  // across rounds: summing would keep a pre-compaction figure alive after the
  // prompt already shrank, and each step reports fresh usage anyway.
  let latestContextTokens = 0;
  let overflowRecoveryUsed = false;

  try {
    // Restarted at most once, after an explicit context-window rejection was
    // answered with a forced reduction of the newest transcript.
    while (true) {
      const remainingIterations = Math.max(0, maxIterations - iteration);
      try {
        const result = sdk.streamText({
          model: config.model,
          system: params.systemPrompt,
          messages: sessionMessages,
          ...(Object.keys(providerOptions).length
            ? { providerOptions }
            : {}),
          tools,
          maxOutputTokens: maxOutputTokensFor(config.provider, config.modelId),
          stopWhen: sdk.stepCountIs(remainingIterations),
          abortSignal: attemptAbort.signal,
          // Cut off a provider that stops sending, at the source. Tool execution
          // is deliberately not bounded here: it runs through runTools, which
          // does not observe the SDK's per-tool signal, so the run-level idle
          // deadline in streamRuns.ts is what covers a hung tool.
          timeout: streamChunkTimeouts(),
          reasoning:
            config.supportsReasoning === false
              ? undefined
              : // The OpenAI adapter and API support `max`, while AI SDK Core 7's
                // shared call-options type still omits it. Preserve the runtime
                // value across that temporary upstream type mismatch.
                ((params.reasoning ?? "none") as
                  | "provider-default"
                  | Exclude<NonNullable<StreamChatParams["reasoning"]>, "max">
                  | undefined),
          include: { rawChunks: true },
          // Without an onError, streamText's default is `console.error(error)`:
          // the raw provider error is logged — and filed by the Sentry console
          // bridge — before the same failure reaches the "error" part below,
          // where it is classified and the caller reports it once
          // (MIKE-BACKEND-C). Every failure still arrives through fullStream.
          onError: () => {},
          // Post-turn checkpoint, which is also the tool-loop boundary: once a
          // step's tools have completed, fold its response messages into the
          // working transcript and re-check the model's context window with
          // the provider-reported usage. `step.response.messages` preserves
          // complete tool call/result pairs.
          ...(compactionEnabled
            ? {
                onStepEnd: (step: {
                  finishReason: string;
                  usage: AiSdk.LanguageModelUsage;
                  response: { messages: AiSdk.ModelMessage[] };
                }) => {
                  // A step that ended in a provider error never completed its
                  // tools; its partial response must not join the transcript
                  // the retry prompt is built from (an assistant tool-call
                  // without its result would be rejected outright).
                  if (step.finishReason === "error") return;
                  workingMessages = [
                    ...workingMessages,
                    ...step.response.messages,
                  ];
                  // The step's dispatched tool executions are now represented
                  // in the transcript; only a real commit may clear the
                  // watermark that gates overflow recovery.
                  uncommittedToolDispatches.clear();
                  latestContextTokens = contextTokensFromUsage(step.usage);
                  const checkpoint = compactModelMessages({
                    messages: workingMessages,
                    modelId: config.modelId,
                    systemPrompt: params.systemPrompt,
                    tools: params.tools,
                    thresholdPct,
                    contextTokens: latestContextTokens,
                  });
                  if (checkpoint.compacted) {
                    workingMessages = checkpoint.messages;
                  }
                },
              }
            : {}),
          ...(config.courtlistenerCitationReminder || compactionEnabled
            ? {
                prepareStep: ({
                  steps,
                }: {
                  steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
                }) => {
                  const overrides: {
                    system?: string;
                    messages?: AiSdk.ModelMessage[];
                  } = {};
                  if (
                    config.courtlistenerCitationReminder &&
                    usesCourtlistenerTool(steps)
                  ) {
                    overrides.system = `${params.systemPrompt}\n\n${COURTLISTENER_CITATION_REMINDER}`;
                  }
                  // Hand back the checkpointed transcript so the next round
                  // sends the compacted prefix instead of the raw expansion
                  // (the SDK appends each step's response messages to this
                  // array; the post-turn checkpoint above already folded them
                  // in, so the two stay in lockstep).
                  if (compactionEnabled) {
                    overrides.messages = workingMessages;
                  }
                  return Object.keys(overrides).length ? overrides : undefined;
                },
              }
            : {}),
        });

        for await (const part of result.stream) {
          switch (part.type) {
            case "start-step":
              iteration += 1;
              notifiedEarlyToolCalls.clear();
              stepText = "";
              break;
            case "raw":
              logRawLlmStream({
                provider: config.provider,
                model: config.modelId,
                iteration: Math.max(0, iteration - 1),
                label: "ai_sdk_raw",
                payload: part.rawValue,
              });
              rawStreamRecorder?.record({
                iteration: Math.max(0, iteration - 1),
                label: "ai_sdk_raw",
                payload: part.rawValue,
              });

              // Early tool-call notification: fires the instant the provider names a tool in
              // the first chunk of tool_calls, long before AI SDK parses the complete JSON
              // arguments (which can take 15-60s for large tools like generate_docx). This
              // flushes any trailing prose held back in visible buffers and signals the client
              // to open "Working..." instead of appearing frozen mid-sentence.
              const earlyCall = extractEarlyToolCall(part.rawValue);
              if (earlyCall && !notifiedEarlyToolCalls.has(earlyCall.name)) {
                notifiedEarlyToolCalls.add(earlyCall.name);
                params.callbacks?.onToolCallStart?.({
                  id: earlyCall.id || randomUUID(),
                  name: earlyCall.name,
                  input: {},
                });
              }
              break;
            case "text-delta":
              fullText += part.text;
              stepText += part.text;
              params.callbacks?.onContentDelta?.(part.text);
              break;
            case "reasoning-start":
              openReasoningBlocks.add(part.id);
              break;
            case "reasoning-delta":
              openReasoningBlocks.add(part.id);
              params.callbacks?.onReasoningDelta?.(part.text);
              break;
            case "reasoning-end":
              if (openReasoningBlocks.delete(part.id)) {
                params.callbacks?.onReasoningBlockEnd?.();
              }
              break;
            case "tool-call": {
              const call: NormalizedToolCall = {
                id: part.toolCallId,
                name: part.toolName,
                input: normalizeToolInput(part.input),
              };
              // The early stub (input: {}) opens the client's Working state; the
              // parsed call re-fires with the real arguments so a consumer that
              // records the last notification per tool ends with the true input.
              notifiedEarlyToolCalls.add(call.name);
              params.callbacks?.onToolCallStart?.(call);
              break;
            }
            case "finish-step":
              lastFinishReason = part.finishReason;
              break;
            // A tool's own failure is not the model provider's: a search tool
            // answering 401 says nothing about our LLM key, so this path keeps the
            // executor error rather than blaming the user's credentials.
            case "tool-error":
              // Station 4: `dynamic: true` = the SDK synthesized this part for a
              // call it could not dispatch (unknown tool / unparseable input). It
              // has already queued the error as that call's result and keeps the
              // step loop alive, so break out of the switch (continue the loop)
              // and let the model recover in-band. Falling through to the throw
              // would abort a turn the model can still finish. Mike's tools are
              // static, so only a genuine execute() failure reaches the throw.
              if ("dynamic" in part && part.dynamic === true) break;
              runToolsFailure.first ??= { error: part.error };
              throw guardAbortShaped(rethrowable(part.error, config.label));
            case "error":
              throw guardAbortShaped(toProviderStreamError(part.error, config));
            case "abort": {
              const stalled = params.abortSignal?.aborted
                ? null
                : asProviderStallError(part.reason, config);
              if (stalled) throw stalled;
              const error = new Error(part.reason || "Stream aborted.");
              error.name = "AbortError";
              throw error;
            }
          }
        }

        for (const id of openReasoningBlocks) {
          openReasoningBlocks.delete(id);
          params.callbacks?.onReasoningBlockEnd?.();
        }
        // A run halted by stopWhen, or cut off at the output ceiling, otherwise
        // ends exactly like a finished one: streamText just stops and this
        // function returns whatever text happened to accumulate. That renders
        // as a bare "Completed in N steps" with no answer and no error, which
        // is indistinguishable from the model having nothing to say. Name it
        // instead.
        const notice = stopNotice(iteration, maxIterations, lastFinishReason);
        if (notice) {
          fullText += notice;
          params.callbacks?.onContentDelta?.(notice);
        }
        await rawStreamRecorder?.flush("completed");
        return { fullText };
      } catch (error) {
        attemptAbort.abort();
        // Prose the failed step already streamed to the user, and nothing
        // else: completed steps' text is committed into workingMessages via
        // onStepEnd, and the accumulator was reset at this step's boundary.
        const streamedStepText = stepText;
        stepText = "";
        // Only model-provider failures are eligible for API-key/quota guidance.
        // Tool failures (including pauses) retain their original identity.
        const fatal = runToolsFailure.first
          ? guardAbortShaped(rethrowable(runToolsFailure.first.error, config.label))
          : guardAbortShaped(toProviderStreamError(error, config));
        // One bounded recovery: an explicit context-window rejection, answered
        // with a forced reduction of the newest transcript, is retried once
        // with the remaining iteration budget. Tool faults, cancels, auth
        // failures and output-length errors never qualify, an error whose
        // transcript cannot actually be reduced is rethrown unchanged, and a
        // failed step that already dispatched tool executions refuses it too:
        // those side effects are absent from the transcript a retry would
        // send, so the model could repeat them.
        if (
          compactionEnabled &&
          !overflowRecoveryUsed &&
          !runToolsFailure.first &&
          uncommittedToolDispatches.size === 0 &&
          !params.abortSignal?.aborted &&
          iteration < maxIterations &&
          isExplicitContextOverflow(fatal)
        ) {
          const reduced = compactModelMessages({
            messages: workingMessages,
            modelId: config.modelId,
            systemPrompt: params.systemPrompt,
            tools: params.tools,
            thresholdPct,
            contextTokens: latestContextTokens,
            force: true,
          });
          if (reduced.compacted && reduced.messages !== workingMessages) {
            overflowRecoveryUsed = true;
            // Text-only assistant continuation: the retry request repeats the
            // partial answer so the model continues it instead of restarting.
            // No tool-call parts from the failed step ride along, so the
            // transcript cannot gain an orphan call/result pair.
            const retryMessages: AiSdk.ModelMessage[] = streamedStepText
              ? [
                  ...reduced.messages,
                  { role: "assistant", content: streamedStepText },
                ]
              : reduced.messages;
            sessionMessages = retryMessages;
            workingMessages = retryMessages;
            // The retry prompt is smaller; stale pre-compaction usage must not
            // floor the next checkpoint's estimate.
            latestContextTokens = 0;
            attemptAbort = new AbortController();
            if (params.abortSignal?.aborted) {
              attemptAbort.abort(params.abortSignal.reason);
            }
            continue;
          }
        }
        await rawStreamRecorder?.flush("error", fatal);
        throw fatal;
      }
    }
  } finally {
    params.abortSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function completeAiSdkText(
  params: {
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
  },
  config: AiSdkAdapterConfig,
): Promise<string> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: config.model,
    system: params.systemPrompt,
    prompt: params.user,
    maxOutputTokens: params.maxTokens ?? 512,
    reasoning: config.supportsReasoning === false ? undefined : "none",
  });
  return result.text;
}
