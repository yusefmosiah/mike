import { buildGoogleWorkspaceTools } from "../../../lib/integrations/googleWorkspace";
import {
  streamChatWithTools,
  resolveModel,
  type LlmMessage,
  type LlmUserContent,
  type NormalizedToolCall,
  type OpenAIToolSchema,
} from "../../../lib/llm";
import { resolveRequestedModel } from "../../../lib/routerModels";
import { UserFacingError } from "../../../lib/userFacingError";
import { InvalidApiKeyError } from "../../../lib/llm/apiKeyErrors";
import { reportError } from "../../../lib/observability/sentry";
import type { Db } from "../../../lib/supabase";
import { buildUserMcpTools, type McpToolEvent } from "../../../lib/mcpConnectors";
import type { SourceDocument } from "../../../lib/sourceDocuments";
import { buildGoogleDriveTools } from "../../../lib/integrations/googleDrive";
import {
  COURTLISTENER_TOOLS,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./tools/courtlistenerTools";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputResponseItem,
  type AskInputsEvent,
  type EditAnnotation,
  devLog,
  resolveDocLabel,
  TOOL_ERROR_MESSAGE,
} from "./types";
import {
  TOOLS,
  WORKFLOW_TOOLS,
  isDocumentMutatingTool,
  withoutDocumentMutatingTools,
} from "./tools/toolSchemas";
import {
  parseCitationsWithDiagnostics,
  parsePartialCitationObjects,
  createCitation,
  CITATIONS_OPEN_TAG,
} from "./citations";
import { runToolCalls } from "./tools/toolDispatcher";
import {
  getCachedCaseOpinionTexts,
  type CourtlistenerTurnState,
} from "./tools/courtlistenerTurnState";
import {
  readDocumentContent,
  type TurnEditState,
  type TurnReadState,
} from "./tools/documentOps";
import { verifyCitations } from "./verifyCitations";
import { buildMemoryTurn } from "../../../lib/memory/prompt";
import {
  AUTO_MODE_SAFE_DEFAULTS,
  classifyToolCall,
  inScopeForContainer,
  tierForTool,
} from "../../../lib/guardrails";

export type { AssistantEvent } from "@mike/contracts";
import type { AssistantEvent, AssistantErrorCode } from "@mike/contracts";

/**
 * Tools the model can call that execute outside this process — in the Word
 * task pane. The adapter owns forwarding the call to the client and awaiting
 * its posted result; the loop treats the returned content exactly like a
 * server-side tool result.
 */
export interface ClientToolsAdapter {
  schemas: OpenAIToolSchema[];
  owns: (name: string) => boolean;
  execute: (
    call: import("../../../lib/llm").NormalizedToolCall,
  ) => Promise<{ content: string; events: AssistantEvent[] }>;
}

export class AssistantStreamError extends Error {
  fullText: string;
  events: AssistantEvent[];

  constructor(
    message: string,
    fullText: string,
    events: AssistantEvent[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AssistantStreamError";
    this.fullText = fullText;
    this.events = events;
  }
}

export const ASSISTANT_ERROR_MESSAGE =
  "The response could not be completed. Please try again.";

/**
 * What to tell the client about a failed stream.
 *
 * The engine already decided whether a failure is safe to show (a rejected API
 * key, an unavailable model) and tagged it on the error event. Every streaming
 * route has to forward that verdict rather than flattening to "try again",
 * which sends the user to retry something that cannot succeed — so the choice
 * lives here once instead of in each route's catch.
 */
export function assistantStreamErrorPayload(error: unknown): {
  message: string;
  safe_to_display?: true;
  code?: AssistantErrorCode;
} {
  const safe =
    error instanceof AssistantStreamError
      ? [...error.events]
          .reverse()
          .find(
            (event): event is Extract<AssistantEvent, { type: "error" }> =>
              event.type === "error" && event.safe_to_display === true,
          )
      : undefined;
  if (!safe) return { message: ASSISTANT_ERROR_MESSAGE };
  return {
    message: safe.message,
    safe_to_display: true,
    ...(safe.code ? { code: safe.code } : {}),
  };
}

function sanitizeAssistantEvent(event: AssistantEvent): AssistantEvent {
  if (event.type === "error") {
    return event.safe_to_display
      ? event
      : { ...event, message: ASSISTANT_ERROR_MESSAGE };
  }
  if ("error" in event && typeof event.error === "string" && event.error) {
    return { ...event, error: TOOL_ERROR_MESSAGE };
  }
  return event;
}

export function sanitizeAssistantSseChunk(chunk: string): string {
  if (!chunk.startsWith("data: ")) return chunk;
  const payload = chunk.slice(6).trim();
  if (!payload || payload === "[DONE]") return chunk;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return chunk;
    }
    const sanitized = sanitizeAssistantEvent(parsed as AssistantEvent);
    return `data: ${JSON.stringify(sanitized)}\n\n`;
  } catch {
    return chunk;
  }
}

export class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

function isAskInputsPause(error: unknown): boolean {
  if (error instanceof AssistantStreamAskInputsPause) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    record.name === "AssistantStreamAskInputsPause" ||
    record.message === "Waiting for user input."
  ) {
    return true;
  }
  return record.cause !== error && isAskInputsPause(record.cause);
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" || record.message === "Stream aborted.";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  throw err;
}

/**
 * The turn's own words: the last user message, flattened to text. Auto Mode's
 * classifier judges a tool call against what the USER asked for, so the intent
 * is read from the user's message alone — assistant prose is model-written and
 * must never be able to argue a call into an allow.
 */
function lastUserIntent(apiMessages: unknown[]): string {
  for (let index = apiMessages.length - 1; index >= 0; index -= 1) {
    const message = apiMessages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    if (!("role" in message) || message.role !== "user") continue;
    if (!("content" in message)) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object" || !("text" in part)) return "";
        return typeof part.text === "string" ? part.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The deterministic answer Auto Mode gives to a model-emitted `ask_inputs`
 * call. In Auto Mode the tool is not advertised, so this only fires if the
 * model names it from memory; there is no user to pause for, so every item
 * gets the least committal answer (AUTO_MODE_SAFE_DEFAULTS): the first
 * offered option for a choice, an empty string for free text, a skip for
 * document requests — Auto Mode cannot upload a file — and a rejection for
 * approval items, because Auto Mode never approves a write on the user's
 * behalf.
 */
function autoAnswerAskInputs(args: Record<string, unknown>): {
  event: AskInputsEvent;
  responses: AskInputResponseItem[];
} {
  const items: AskInputsEvent["items"] = [];
  const responses: AskInputResponseItem[] = [];
  const rawItems = Array.isArray(args.items) ? args.items : [];
  rawItems.forEach((rawItem, index) => {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return;
    }
    const rawId = "id" in rawItem ? rawItem.id : undefined;
    const rawKind = "kind" in rawItem ? rawItem.kind : undefined;
    const rawQuestion = "question" in rawItem ? rawItem.question : undefined;
    const id =
      typeof rawId === "string" && rawId.trim()
        ? rawId.trim().slice(0, 80)
        : `auto-${index + 1}`;
    const question =
      typeof rawQuestion === "string"
        ? rawQuestion.trim().slice(0, 500)
        : "";

    if (rawKind === "approval") {
      // Approval items carry a connector write; Auto Mode denies them
      // (AUTO_MODE_SAFE_DEFAULTS.approval) and the write never runs.
      responses.push({ id, kind: "approval", decision: "reject" });
      return;
    }

    if (rawKind === "documents") {
      // Nothing can be attached without a human: documents → "skip".
      items.push({ id, kind: "documents", document_types: [] });
      responses.push({ id, kind: "documents", filenames: [], skipped: true });
      return;
    }

    if (rawKind === "text") {
      const asked = question || "Please provide the requested information.";
      items.push({ id, kind: "text", question: asked });
      responses.push({
        id,
        kind: "text",
        question: asked,
        answer: AUTO_MODE_SAFE_DEFAULTS.text,
      });
      return;
    }

    const multiChoice = rawKind === "multi_choice";
    const asked =
      question ||
      (multiChoice
        ? "Please choose one or more options."
        : "Please choose an option.");
    const rawOptions = "options" in rawItem ? rawItem.options : undefined;
    const options = (Array.isArray(rawOptions) ? rawOptions : [])
      .map((option): string => {
        if (typeof option === "string") return option.trim();
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          return "";
        }
        const value = "value" in option ? option.value : undefined;
        if (typeof value === "string" && value.trim()) return value.trim();
        const label = "label" in option ? option.label : undefined;
        return typeof label === "string" ? label.trim() : "";
      })
      .filter(Boolean)
      .slice(0, 8);
    // choice / multi_choice → "first_option".
    const values = options.length > 0 ? options : ["Continue"];
    const normalizedOptions = values.map((value) => ({ value }));
    if (multiChoice) {
      items.push({
        id,
        kind: "multi_choice",
        question: asked,
        options: normalizedOptions,
        allow_other: false,
        other_label: "Other",
      });
      responses.push({
        id,
        kind: "multi_choice",
        question: asked,
        answers: [values[0]],
      });
      return;
    }
    items.push({
      id,
      kind: "choice",
      question: asked,
      options: normalizedOptions,
      allow_other: false,
      other_label: "Other",
    });
    responses.push({ id, kind: "choice", question: asked, answer: values[0] });
  });

  return {
    event: { type: "ask_inputs", event_id: crypto.randomUUID(), items },
    responses,
  };
}

export async function runLLMStream(params: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  db: Db;
  write: (s: string) => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  /** Expose ask_inputs only to clients that can render and answer it. */
  includeAskInputs?: boolean;
  /**
   * The surface continues a paused turn from an ask_inputs_response, so a
   * connector write can wait there for the user's approval. Surfaces without
   * that continuation refuse writes that need approval instead.
   */
  connectorApprovals?: boolean;
  /**
   * May this turn WRITE documents (edit_document, replicate_document, the
   * generate_* family)? Defaults to true; pass false and those tools are
   * neither advertised to the model nor executed if it asks for one anyway.
   *
   * The caller decides this from the role the caller holds on the CONTAINER
   * whose documents the tools would touch — not from their standing in the
   * chat. The two come apart: a project viewer named on one chat's share
   * list writes in that thread as a member, and without this partition the
   * thread would hand them edit_document over every document in the project.
   */
  allowDocumentMutation?: boolean;
  /**
   * Auto Mode: run the turn with no human in the loop, so nothing may pause
   * for one. Every tool call is judged on the server before it runs
   * (lib/guardrails): reads run, document writes run only where the caller
   * may mutate documents and the call stays inside the turn's container, and
   * everything with external egress needs the on-route classifier's allow.
   * A refusal is an in-band tool result the model can read — never a throw —
   * `ask_inputs` is neither advertised nor able to pause the turn, and
   * connector approvals are recorded without pausing. Defaults to false;
   * callers that omit it keep their exact behavior.
   */
  autoMode?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  /** Tools executed by the connected client (Word add-in) instead of here. */
  clientTools?: ClientToolsAdapter;
  /**
   * Tool-loop iteration budget (default 10). Surfaces whose tools are built
   * around retry round-trips (Word client edits: propose → fail → re-read →
   * retry) need headroom, or the loop ends before the model's summary.
   */
  maxIterations?: number;
  buildCitations?: (fullText: string) => unknown[];
  model?: string;
  /** AI SDK reasoning effort for this interactive request. */
  reasoning?: import("../../../lib/llm").ReasoningLevel;
  apiKeys?: import("../../../lib/llm").UserApiKeys;
  signal?: AbortSignal;
  /** Let a route persist the completed turn before it signals stream success. */
  emitDone?: boolean;
  /** Add read-only app/project memory as an earliest untrusted reference turn. */
  includeMemory?: boolean;
  /** Memory scope is independent from generated-document destination. */
  memoryProjectId?: string | null;
  /** Tell the memory policy whether other people can see the persisted turn. */
  memorySharedAudience?: boolean;
  /**
   * If set, generate_docx will attach created docs to this project so
   * they appear in the project sidebar. Leave null for general chats —
   * generated docs still get persisted, but as standalone documents.
   */
  projectId?: string | null;
  /** Spotlighting nonce — generated by the caller and passed here so that
   *  the same nonce fences both the system-prompt filenames (added by
   *  buildMessages) and the document bodies returned by tools. */
  nonce?: string;
  /** Durable conversation id, forwarded to the provider as a cache hint. */
  conversationId?: string | null;
}): Promise<{
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
}> {
  const {
    apiMessages,
    docStore,
    docIndex,
    userId,
    db,
    write: unsafeWrite,
    extraTools,
    includeResearchTools = true,
    includeAskInputs = true,
    connectorApprovals = false,
    allowDocumentMutation = true,
    autoMode = false,
    workflowStore,
    tabularStore,
    clientTools,
    buildCitations,
    model,
    apiKeys,
    signal,
    projectId,
    includeMemory = false,
    memoryProjectId,
    memorySharedAudience = false,
    nonce,
    conversationId,
  } = params;
  const write = (chunk: string) =>
    unsafeWrite(sanitizeAssistantSseChunk(chunk));
  const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
  const mcpTools = await buildUserMcpTools(userId, db);
  const googleDriveTools = await buildGoogleDriveTools(userId, db);
  // Auto Mode has no one to answer a question, so `ask_inputs` is withheld
  // exactly as it is for surfaces that cannot render it. Enforcement for a
  // call the model emits anyway is in the `runTools` wrapper below.
  const conversationTools =
    includeAskInputs && !autoMode
      ? TOOLS
      : TOOLS.filter((tool) => tool.function.name !== "ask_inputs");
  const baseTools = [...conversationTools, ...researchTools, ...WORKFLOW_TOOLS];
  const advertisedTools = [
    ...baseTools,
    ...mcpTools,
    ...googleDriveTools,
    ...(await buildGoogleWorkspaceTools(userId, db)),
    ...(extraTools ?? []),
    ...(clientTools?.schemas ?? []),
  ];
  // Hiding the schema is the first half of the gate: a tool the model was
  // never shown is a tool it will not plan around. The second half is in
  // `runTools` below, because "not advertised" is not "not callable" — a
  // model can name a tool from memory.
  const activeTools = allowDocumentMutation
    ? advertisedTools
    : withoutDocumentMutatingTools(advertisedTools);

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages.
  const rawMsgs = apiMessages as {
    role: string;
    content: string | LlmUserContent | null;
  }[];
  const firstMsg = rawMsgs[0];
  const baseSystemPrompt =
    firstMsg?.role === "system" && typeof firstMsg.content === "string"
      ? firstMsg.content
      : "";
  const memory = await buildMemoryTurn({
    db,
    userId,
    systemPrompt: baseSystemPrompt,
    include: includeMemory,
    projectId: memoryProjectId,
    sharedAudience: memorySharedAudience,
  });
  const systemPrompt = memory.systemPrompt;
  const chatMessages: LlmMessage[] = rawMsgs
    .filter((m) => m.role !== "system")
    .map(
      (m): LlmMessage =>
        m.role === "assistant"
          ? {
              role: "assistant",
              content: typeof m.content === "string" ? m.content : "",
            }
          : { role: "user", content: m.content ?? "" },
    )
    // An assistant turn with no text (an error, a cancellation, or a client
    // that keeps prose in events) carries nothing for the model, and Anthropic
    // rejects the entire request over one empty text block. A user turn with
    // array content survives as long as one part carries text or an image —
    // the adapter decides later whether the image becomes a file part or its
    // fallback text.
    .filter((m) => {
      if (m.role === "assistant") return m.content.trim().length > 0;
      return typeof m.content === "string"
        ? m.content.trim().length > 0
        : m.content.some(
            (part) => part.type === "image" || part.text.trim().length > 0,
          );
    });
  // Before every real turn: see MemoryTurn for why it goes there.
  if (memory.message) chatMessages.unshift(memory.message);

  const events: AssistantEvent[] = [];
  // One assistant turn produces at most one document_versions row per
  // edited doc. `runToolCalls` fires once per tool-call batch; the model
  // may emit multiple batches in a single turn, so this map persists
  // across batches to let subsequent edit_document calls overwrite the
  // turn's existing version instead of creating a new one.
  const turnEditState: TurnEditState = new Map();
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
  const courtlistenerTurnState: CourtlistenerTurnState = {
    casesByClusterId: new Map(),
  };
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let visibleTailBuffer = "";
  let citationsOpenSeen = false;
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  const emitCitationStreamSnapshot = (
    status: "started" | "partial",
    citations: unknown[],
  ) => {
    if (buildCitations) return;
    write(
      `data: ${JSON.stringify({ type: "citations", status, citations })}\n\n`,
    );
  };

  const streamHiddenCitationContent = (delta: string) => {
    if (buildCitations || !delta) return;
    streamingCitationsBuffer += delta;
    const partial = parsePartialCitationObjects(streamingCitationsBuffer);
    if (partial.length <= streamedCitationCount) return;
    streamedCitationCount = partial.length;
    const citations = partial.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    emitCitationStreamSnapshot("partial", citations);
  };

  const streamVisibleContent = (delta: string) => {
    if (!delta) return;
    if (citationsOpenSeen) {
      streamHiddenCitationContent(delta);
      return;
    }

    const combined = visibleTailBuffer + delta;
    const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
    if (markerIdx >= 0) {
      const visible = combined.slice(0, markerIdx);
      if (visible) {
        iterVisibleText += visible;
        write(
          `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
        );
      }
      visibleTailBuffer = "";
      citationsOpenSeen = true;
      streamingCitationsBuffer = "";
      streamedCitationCount = 0;
      emitCitationStreamSnapshot("started", []);
      streamHiddenCitationContent(
        combined.slice(markerIdx + CITATIONS_OPEN_TAG.length),
      );
      return;
    }

    const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
    const visible = combined.slice(0, combined.length - keep);
    visibleTailBuffer = combined.slice(combined.length - keep);
    if (visible) {
      iterVisibleText += visible;
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
      );
    }
  };

  const flushVisibleTail = (opts: { emit?: boolean } = {}) => {
    const emit = opts.emit ?? true;
    if (citationsOpenSeen || !visibleTailBuffer) {
      visibleTailBuffer = "";
      return;
    }
    iterVisibleText += visibleTailBuffer;
    if (emit) {
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visibleTailBuffer })}\n\n`,
      );
    }
    visibleTailBuffer = "";
  };

  const flushText = (opts: { emit?: boolean } = {}) => {
    if (!iterText) return;
    fullText += iterText;
    flushVisibleTail(opts);
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
    visibleTailBuffer = "";
    citationsOpenSeen = false;
    streamingCitationsBuffer = "";
    streamedCitationCount = 0;
  };

  const flushPartialTurn = (opts: { emit?: boolean } = {}) => {
    flushText(opts);
    if (iterReasoning) {
      events.push({ type: "reasoning", text: iterReasoning });
      iterReasoning = "";
    }
  };

  // Auto Mode bookkeeping for the whole turn: the intent every classifier
  // call is judged against, and the tool names already attempted — allowed or
  // denied — so a refused call cannot be laundered through a second,
  // differently-named one.
  const autoModeIntent = autoMode ? lastUserIntent(apiMessages) : "";
  const priorToolNames: string[] = [];
  if (autoMode) {
    devLog("[chat/stream] auto mode turn", {
      userId,
      conversationId: conversationId ?? null,
    });
  }

  try {
    throwIfAborted(signal);
    // Single request-time choke point for every runLLMStream caller (chat,
    // project chat, Word chat, tabular): router-prefixed models must be in the
    // user's saved selection.
    //
    // This lives INSIDE the try because it touches the database. Above it, a
    // read failure escaped as a bare rejection — before any error event was
    // pushed and before AssistantStreamError could carry the partial turn — so
    // the SSE client saw the socket end with no explanation. Inside, a blip
    // takes the same path as any other mid-stream failure.
    //
    // "throw" (not silent fallback) because `model` here is what the caller
    // asked for in THIS request. Stored task models are validated by their
    // route before they arrive here, but this guard keeps every caller safe.
    const requestedModel = resolveModel(model, "");
    if (!requestedModel) {
      throw new UserFacingError(
        model
          ? `Model "${model}" is not available. Select another model.`
          : "Select a model before sending a message.",
      );
    }
    const selectedModel = await resolveRequestedModel(
      requestedModel,
      "",
      userId,
      db,
      "throw",
    );
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt,
      messages: chatMessages,
      tools: activeTools as OpenAIToolSchema[],
      // Keep in step with DEFAULT_MAX_ITERATIONS in llm/aiSdk.ts. Deliberately
      // a literal, not an import: tests mock the "../llm" barrel, and reaching
      // past it into llm/aiSdk loads the real SDK module into suites that only
      // ever wanted the mock, which broke unrelated tests at random.
      maxIterations: params.maxIterations ?? 16,
      apiKeys,
      reasoning: params.reasoning ?? "high",
      abortSignal: signal,
      conversationId,
      callbacks: {
        onContentDelta: (delta) => {
          iterText += delta;
          streamVisibleContent(delta);
        },
        onReasoningDelta: (delta) => {
          iterReasoning += delta;
          write(
            `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
          );
        },
        onReasoningBlockEnd: () => {
          if (!iterReasoning) return;
          events.push({ type: "reasoning", text: iterReasoning });
          write(`data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`);
          iterReasoning = "";
        },
        // Fires after Claude's turn ends with stop_reason=tool_use, before
        // the tool actually runs. Flushes any buffered assistant text so
        // it's emitted in chronological order, then signals the client so
        // it can open a fresh PreResponseWrapper (shows "Working…") while
        // the tool executes — avoids the dead gap between message_stop
        // and the first tool-specific event.
        onToolCallStart: (call) => {
          flushText();
          write(
            `data: ${JSON.stringify({
              type: "tool_call_start",
              name: call.name,
            })}\n\n`,
          );
        },
      },
      runTools: async (calls) => {
        throwIfAborted(signal);
        // Emit any text the model produced before this tool turn so the
        // UI sees it before the tool results stream in.
        flushText();

        // Client-executed tools (Word add-in) round-trip through the SSE
        // stream and never enter the server dispatcher. They run before the
        // server batch and sequentially among themselves: each call mutates
        // or reads the live document, so order is part of their semantics.
        const clientResultByCallId = new Map<string, string>();
        // Results for calls the Auto Mode guardrails refuse or answer
        // themselves. Keyed by tool_call_id and merged into the batch's
        // results below, so every tool_use the model sent gets an answer.
        const guardrailResultByCallId = new Map<string, string>();

        // Auto Mode: judge every call before it can reach the dispatcher, and
        // return the refusal as a tool RESULT the model can read and react
        // to — a throw here would end the turn.
        //   Tier 1 — reads; always allowed.
        //   Tier 2 — document writes; allowed only where the caller may
        //            mutate documents AND the arguments stay inside this
        //            turn's container.
        //   Tier 3 — connector writes, anything with external egress, and
        //            every unknown tool; allowed only when the on-route
        //            classifier says so, judged against the user's own words
        //            and the tools already tried.
        // A model-emitted ask_inputs call is answered here deterministically:
        // Auto Mode has nobody to pause for.
        const applyAutoModeGuardrails = async (
          call: NormalizedToolCall,
        ): Promise<string | null> => {
          const denied = (reason: string) =>
            JSON.stringify({
              error: `Auto Mode guardrail denied ${call.name}: ${reason}`,
            });

          if (call.name === "ask_inputs") {
            const { event, responses } = autoAnswerAskInputs(call.input);
            // Mirror the dispatcher: a call with nothing to ask is no
            // question, so it leaves no event behind.
            if (event.items.length > 0) {
              write(`data: ${JSON.stringify(event)}\n\n`);
              events.push(event);
              const answerEvent: AssistantEvent = {
                type: "ask_inputs_response",
                // The assistant row this turn becomes is reserved by the
                // route, not known here; the pairing that matters in the
                // transcript is ask_event_id.
                assistant_message_id: "",
                ask_event_id: event.event_id,
                responses,
              };
              write(`data: ${JSON.stringify(answerEvent)}\n\n`);
              events.push(answerEvent);
            }
            const approvalDenied = responses.some(
              (response) =>
                response.kind === "approval" && response.decision === "reject",
            );
            return JSON.stringify({
              ok: true,
              auto_answered: true,
              responses,
              message: approvalDenied
                ? "Auto Mode answered these itself and rejected the approval items: nothing was approved. Do not ask again or retry the approvals."
                : "Auto Mode answered these itself — no user is present. Continue with the answers above and do not ask again.",
            });
          }

          const tier = tierForTool(call.name);
          if (tier === 1) return null;
          if (tier === 2) {
            if (!allowDocumentMutation) {
              return denied(
                "this conversation does not allow changing documents",
              );
            }
            if (!inScopeForContainer(call.input, projectId ?? null)) {
              return denied(
                "the call targets a container outside this conversation",
              );
            }
            return null;
          }

          let verdict: { verdict: "allow" | "deny"; reason: string };
          try {
            verdict = await classifyToolCall({
              userIntent: autoModeIntent,
              toolName: call.name,
              toolArgs: call.input,
              history: [...priorToolNames],
              model: selectedModel,
              apiKeys,
            });
          } catch {
            // `classifyToolCall` fails closed by contract; this catch is the
            // second belt, because a throw here would end the whole turn.
            verdict = { verdict: "deny", reason: "classifier unavailable" };
          }
          if (verdict.verdict === "allow") return null;
          return denied(verdict.reason || "the classifier did not allow it");
        };

        // Enforcement, not just omission: a document-writing call from a
        // caller who may not write is dropped before dispatch, on the server
        // side and the client side alike. It falls through to the
        // "Tool 'x' is not available." answer below, which every tool_use
        // without a result already gets, so the model is told plainly rather
        // than left waiting on a call that silently did nothing.
        let permittedCalls: NormalizedToolCall[];
        if (autoMode) {
          permittedCalls = [];
          for (const call of calls) {
            const refusal = await applyAutoModeGuardrails(call);
            if (refusal === null) permittedCalls.push(call);
            else guardrailResultByCallId.set(call.id, refusal);
            priorToolNames.push(call.name);
          }
        } else {
          permittedCalls = allowDocumentMutation
            ? calls
            : calls.filter((c) => !isDocumentMutatingTool(c.name));
        }
        const serverCalls = clientTools
          ? permittedCalls.filter((c) => !clientTools.owns(c.name))
          : permittedCalls;
        if (clientTools) {
          for (const call of permittedCalls) {
            if (!clientTools.owns(call.name)) continue;
            const { content, events: clientEvents } =
              await clientTools.execute(call);
            clientResultByCallId.set(call.id, content);
            events.push(...clientEvents);
            throwIfAborted(signal);
          }
        }

        const toolCalls: ToolCall[] = serverCalls.map((c) => ({
          id: c.id,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
        const {
          toolResults,
          docsRead,
          docsFound,
          docsCreated,
          docsReplicated,
          workflowsApplied,
          docsEdited,
          askInputsEvents,
          courtlistenerEvents,
          caseCitationEvents,
          mcpEvents,
        } = await runToolCalls(
          toolCalls,
          docStore,
          userId,
          db,
          write,
          workflowStore,
          tabularStore,
          docIndex,
          turnEditState,
          turnReadState,
          projectId,
          courtlistenerTurnState,
          apiKeys,
          nonce,
          { connectorApprovals: connectorApprovals && includeAskInputs },
        );
        throwIfAborted(signal);
        for (const r of docsRead) {
          events.push({
            type: "doc_read",
            filename: r.filename,
            document_id: r.document_id,
            version_id: r.version_id,
            version_number: r.version_number,
          });
        }
        for (const f of docsFound) {
          events.push({
            type: "doc_find",
            filename: f.filename,
            document_id: f.document_id,
            version_id: f.version_id,
            version_number: f.version_number,
            query: f.query,
            total_matches: f.total_matches,
          });
        }
        for (const dl of docsCreated) {
          events.push({
            type: "doc_created",
            filename: dl.filename,
            download_url: dl.download_url,
            document_id: dl.document_id,
            version_id: dl.version_id,
            version_number: dl.version_number ?? null,
          });
        }
        for (const r of docsReplicated) {
          events.push({
            type: "doc_replicated",
            filename: r.filename,
            count: r.count,
            copies: r.copies,
          });
        }
        for (const wf of workflowsApplied) {
          events.push({
            type: "workflow_applied",
            workflow_id: wf.workflow_id,
            title: wf.title,
          });
        }
        for (const e of docsEdited) {
          events.push({
            type: "doc_edited",
            filename: e.filename,
            document_id: e.document_id,
            version_id: e.version_id,
            version_number: e.version_number,
            download_url: e.download_url,
            annotations: e.annotations,
          });
        }
        for (const askInputsEvent of askInputsEvents) {
          write(`data: ${JSON.stringify(askInputsEvent)}\n\n`);
          events.push(askInputsEvent);
        }
        for (const event of courtlistenerEvents) {
          events.push(event);
        }
        for (const event of mcpEvents) {
          events.push(event);
        }
        for (const event of caseCitationEvents) {
          events.push(event);
        }

        // Auto Mode never pauses for input. The events above still stream and
        // persist (a connector approval can be answered from the transcript
        // later), but the turn continues toward the model's summary; a pause
        // would park the run on a user who is not there.
        if (askInputsEvents.length > 0 && !autoMode) {
          throw new AssistantStreamAskInputsPause();
        }

        // Index alignment would break if any tool branch skips its
        // push (unhandled tool name, disabled store, guard failure).
        // Each tool_result already carries its tool_call_id, so key off
        // that directly — and fall back to an error result for any
        // tool_use that didn't produce one, so Claude's next request
        // has a tool_result for every tool_use it sent.
        const resultByCallId = new Map<string, string>(clientResultByCallId);
        for (const [callId, content] of guardrailResultByCallId) {
          resultByCallId.set(callId, content);
        }
        for (const r of toolResults) {
          const row = r as {
            tool_call_id: string;
            content?: unknown;
          };
          resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
        }
        // Answer every tool_use the model sent — client and server alike —
        // in the model's original call order.
        return calls.map((c) => ({
          tool_use_id: c.id,
          content:
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.name}' is not available.`,
            }),
        }));
      },
    });
  } catch (err) {
    if (isAskInputsPause(err)) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      flushPartialTurn({ emit: false });
      throw new AssistantStreamAbortError(
        fullText,
        events.map(sanitizeAssistantEvent),
      );
    } else {
      flushPartialTurn();
      const safeToDisplay = err instanceof UserFacingError;
      // The response already started, so the HTTP 500 path never sees this:
      // it is the one report of the turn's failure. Reporting it HERE, before
      // any console.error, is what lets the console bridge recognise every
      // later log of it — this line's, and the route's log of the
      // AssistantStreamError below, whose `cause` is `err` — as already sent.
      // A UserFacingError (rejected or missing API key, model not allowed)
      // is the user's configuration rather than our bug: still one event, so
      // operators see a rejected key with its provider_error tag, but a
      // warning, not an error. (Left unreported, the console bridge filed it
      // anyway, at error level, as MIKE-BACKEND-E.)
      reportError(err, {
        tags: { component: "chat-stream" },
        ...(safeToDisplay ? { level: "warning" as const } : {}),
      });
      console.error("[chat/stream] model stream failed", err);
      const message = safeToDisplay ? err.message : ASSISTANT_ERROR_MESSAGE;
      events.push({
        type: "error",
        message,
        ...(safeToDisplay ? { safe_to_display: true } : {}),
        // A rejected key is worth naming: the client turns this into a prompt
        // to go fix the key rather than a suggestion to retry.
        ...(err instanceof InvalidApiKeyError
          ? { code: "invalid_api_key" as const }
          : {}),
      });
      throw new AssistantStreamError(
        message,
        fullText,
        events.map(sanitizeAssistantEvent),
        { cause: err },
      );
    }
  }

  flushText();

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitations, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  let citations: unknown[];
  if (buildCitations) {
    // Custom builders (tabular) bypass document-citation verification.
    citations = buildCitations(fullText);
  } else {
    const rawCitations = parsedCitations.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    // Server-side quote verification. Fetch each document's extracted source
    // text at most once per turn (memoized by doc_id), reading only bytes
    // already in storage with emitEvents:false. Case citations are matched
    // against the opinion text cached during this turn.
    const sourceTextByDocId = new Map<string, Promise<string>>();
    const getSourceText = (docId: string): Promise<string> => {
      let pending = sourceTextByDocId.get(docId);
      if (!pending) {
        const label = resolveDocLabel(docId, docStore, docIndex);
        pending = label
          ? readDocumentContent(label, docStore, () => {}, docIndex, db, {
              emitEvents: false,
              // Quote verification compares against the whole source; a
              // bounded window would mark every quote past it unverified.
              fullText: true,
            })
          : Promise.resolve("");
        sourceTextByDocId.set(docId, pending);
      }
      return pending;
    };
    citations = await verifyCitations(
      rawCitations,
      getSourceText,
      async (clusterId) =>
        getCachedCaseOpinionTexts(courtlistenerTurnState, clusterId),
    );
  }
  devLog("[chat/stream] final citations", {
    hasCitationsBlock: citationDiagnostics.hasBlock,
    citationsBlockLength: citationDiagnostics.rawLength,
    parseError: citationDiagnostics.error,
    parsedCitationCount: parsedCitations.length,
    emittedCitationCount: citations.length,
    usedCustomCitationBuilder: !!buildCitations,
  });
  write(
    `data: ${JSON.stringify({ type: "citations", status: "final", citations })}\n\n`,
  );
  if (params.emitDone !== false) {
    write("data: [DONE]\n\n");
  }

  return {
    fullText,
    events: events.map(sanitizeAssistantEvent),
    citations,
  };
}
