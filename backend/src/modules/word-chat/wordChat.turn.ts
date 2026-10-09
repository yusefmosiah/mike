// Word chat turn — driving one Word assistant turn, from the run to the
// stored answer.
//
// The generation half of POST /word-chat: start the server-owned run, reserve
// the answer's row (cloud chats), stream the model through runLLMStream with
// the client-tool adapter, and store what came back (or the cancellation, or
// the error). It takes the prepared turn and an `open` that attaches the run
// to whoever is listening, so the route drives it for a request and the
// resumer drives it again, with no pane attached yet, for a cloud turn a
// restart cut off. Neither touches req/res here.
import {
  startAssistantTurnRun,
  type AssistantTurnRun,
} from "../../lib/assistantTurnRuns";
import { enqueueChatTurnAudit } from "../../lib/audit";
import { abandonTurn, finishTurn } from "../../lib/llm";
import { drainReceiptsSince } from "../../lib/llm/attestation";
import {
  releaseMemoryConversationTurn,
  scheduleMemoryConsolidation,
} from "../../lib/memory/schedule";
import { safeError } from "../../lib/safeError";
import { stopOutcomeFrame } from "../../lib/streamRuns";
import type { Db } from "../../lib/db";
import {
  AssistantStreamError,
  assistantStreamErrorPayload,
  buildCancelledAssistantMessage,
  createReservedAssistantMessageUpdater,
  createWordClientToolsAdapter,
  extractCitations,
  isAbortError,
  isClientToolCallPending,
  persistWordDocumentEdits,
  reserveAssistantMessage,
  runLLMStream,
  stripTransientAssistantEvents,
  type ChatMessage,
  type WordEditApplyMode,
} from "../chat/chat.service";
import {
  prepareWordChatStream,
  recordWordChatActivity,
  type PreparedWordChatStream,
} from "./wordChat.prepare";

/**
 * What a later process needs to drive a cloud Word turn again: the request
 * that started it, minus the history (reloaded from storage up to the turn's
 * prompt). Local chats keep nothing server-side and are never durable. JSON
 * only; it is stored with the turn.
 */
export type WordChatTurnResumeContext = {
  surface: "word";
  userId: string;
  userEmail: string | null;
  chatId: string;
  clientDocumentId: string;
  activeDocumentName: string;
  /** The live document the pane sent; the read tools answer from it. */
  documentContext: string | null;
  clientToolsEnabled: boolean;
  editApplyMode: WordEditApplyMode;
  model: string | null;
  reasoning: string | null;
  timeZone: string | null;
  turnUserMessageId: string;
};

export type DriveWordChatTurnArgs = {
  prepared: PreparedWordChatStream;
  userId: string;
  userEmail: string | undefined;
  clientDocumentId: string;
  activeDocumentName: string;
  persistChat: boolean;
  clientToolsEnabled: boolean;
  editApplyMode: WordEditApplyMode;
  assistantMessageId: string;
  /** Stored with the turn so a restart can drive it again; null for turns that cannot be. */
  durableContext: WordChatTurnResumeContext | null;
  /** Driving a turn a restart cut off: its row is already reserved and its run already in Pi. */
  resume?: boolean;
  /** Attach the run to its listener and return the writer the turn streams through. */
  open: (run: AssistantTurnRun) => {
    signal: AbortSignal;
    write: (line: string) => boolean;
    finish: () => void;
  };
};

/** A failure before anything streamed, for the route to answer as HTTP. */
export type DriveWordChatTurnOutcome =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * The bridge id of a `client_tool_call` SSE record, or null for anything
 * else (ordinary frames, and the `: tool-wait` keep-alive comments the
 * adapter writes between them).
 *
 * The driver recognises the frame by parsing it back rather than having the
 * adapter announce it, because the adapter's contract is a plain
 * `write(line)` — one that knows nothing about runs, replay predicates or
 * which surface is streaming it.
 */
function clientToolCallIdOf(line: string): string | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (!payload.includes('"client_tool_call"')) return null;
  try {
    const frame = JSON.parse(payload) as {
      type?: unknown;
      tool_call_id?: unknown;
    };
    return frame.type === "client_tool_call" &&
      typeof frame.tool_call_id === "string"
      ? frame.tool_call_id
      : null;
  } catch {
    return null;
  }
}

export async function driveWordChatTurn(
  db: Db,
  args: DriveWordChatTurnArgs,
): Promise<DriveWordChatTurnOutcome> {
  const {
    prepared,
    userId,
    userEmail,
    clientDocumentId,
    activeDocumentName,
    persistChat,
    clientToolsEnabled,
    editApplyMode,
    assistantMessageId,
  } = args;
  const {
    chatId,
    lastUserContent,
    inputMessageId,
    turnParentMessageId,
    memoryTurn,
    docIndex,
    docStore,
    apiMessages,
    workflowStore,
    apiKeys,
    selectedModel,
    selectedReasoningLevel,
    nonce,
  } = prepared;
  let chatTitle = prepared.chatTitle;
  let memoryTurnScheduled = false;
  // Only a cloud turn has rows a later process can rebuild it from.
  const durable = persistChat && !!inputMessageId ? args.durableContext : null;
  try {
    // The answer is a server-owned run from here on: it survives the pane's
    // socket (the task pane closing, Word reloading it, a dropped connection)
    // and only POST /word-chat/:chatId/turn/:turnId/stop aborts it. `chatId`
    // always exists by now — a cloud row's id, or the UUID local storage was
    // given — so every Word turn is keyed and attachable, local ones included.
    const run = startAssistantTurnRun({
      id: assistantMessageId,
      chatId,
      userId,
      assistantMessageId,
      surface: "word",
      // What the attach endpoints authorise against; a local chat has no row.
      clientDocumentId,
      persistChat,
    });
    if (!run) {
      return {
        ok: false,
        status: 409,
        body: {
          code: "turn_in_progress",
          detail: "A response is already being generated for this chat.",
        },
      };
    }

    // A resumed turn's row was reserved by the request that started it.
    if (persistChat && !args.resume) {
      const error = await reserveAssistantMessage({
        db,
        table: "word_chat_messages",
        id: assistantMessageId,
        chatId,
        inputMessageId: inputMessageId as string,
        authorUserId: userId,
      });
      if (error) {
        console.error("[word-chat] failed to reserve assistant message", error);
        run.finish();
        return {
          ok: false,
          status: 500,
          body: { detail: "Failed to start Word assistant response" },
        };
      }
    }

    const stream = args.open(run);
    const write = stream.write;
    /**
     * The adapter's writer, with one extra rule: a `client_tool_call` frame is
     * replayed to a pane that attaches LATER only while the call is still
     * pending. A pane closed mid-call reopens, is handed the call again, and
     * answers the tool loop that has been waiting for it; a call that has been
     * answered, timed out or cancelled is settled, and replaying it would apply
     * the same edit twice. (Keep-alive comment lines are neither buffered nor
     * numbered — see `streamRuns.write`.)
     */
    const writeClientToolFrame = (line: string): boolean => {
      const callId = clientToolCallIdOf(line);
      if (!callId) return write(line);
      return run.write(line, { replay: () => isClientToolCallPending(callId) });
    };
    const updateAssistantMessage = createReservedAssistantMessageUpdater({
      db,
      table: "word_chat_messages",
      id: assistantMessageId,
      chatId,
      enabled: persistChat,
    });
    const normalizeAssistantEvents = async (
      events: unknown[],
    ): Promise<unknown[]> => {
      if (!persistChat) return events;
      const normalized = await persistWordDocumentEdits({
        db,
        messageId: assistantMessageId,
        events,
        applyMode: editApplyMode,
      });
      return normalized.events;
    };
    const updateChatActivity = async (): Promise<void> => {
      // Mirror the title the service just persisted back into the local
      // variable so the audit enqueue below names the chat, the way chat.ts
      // does. Without this the first turn of every Word chat would audit under
      // a null title.
      const nextTitle = await recordWordChatActivity(db, {
        persistChat,
        chatId,
        userId,
        chatTitle,
        lastUserContent,
      });
      if (nextTitle) chatTitle = nextTitle;
    };

    try {
      write(
        `data: ${JSON.stringify({
          type: "chat_id",
          chatId,
          turnId: run.id,
          assistantMessageId,
        })}\n\n`,
      );
      const { events, citations } = await runLLMStream({
        apiMessages,
        docStore,
        docIndex,
        userId,
        db,
        write,
        workflowStore,
        // CourtListener is intentionally unavailable in document-scoped Word
        // chats. Legal research remains a web-assistant capability.
        includeResearchTools: false,
        includeAskInputs: false,
        ...(clientToolsEnabled
          ? {
              clientTools: createWordClientToolsAdapter({
                userId,
                write: writeClientToolFrame,
                signal: stream.signal,
                nonce,
              }),
              // The edit flow is built around retry round-trips (propose →
              // fail → read_active_document → retry), each costing one
              // iteration; the default budget of 10 can end the loop before
              // the model gets to write its summary.
              maxIterations: 16,
            }
          : {}),
        model: selectedModel,
        reasoning: selectedReasoningLevel,
        apiKeys,
        signal: stream.signal,
        conversationId: persistChat ? chatId : null,
        turn:
          persistChat && inputMessageId
            ? {
                userMessageId: inputMessageId,
                parentMessageId: turnParentMessageId,
                assistantMessageId,
              }
            : undefined,
        includeMemory: true,
        memoryProjectId: null,
        nonce,
        emitDone: false,
        durableTurn: durable
          ? { context: durable, resume: args.resume }
          : undefined,
      });
      const persistedEvents = await normalizeAssistantEvents(
        stripTransientAssistantEvents(events),
      );
      const saveError = await updateAssistantMessage(
        persistedEvents.length ? persistedEvents : null,
        citations.length ? citations : null,
      );
      await updateChatActivity();
      if (saveError) {
        console.error("[word-chat] failed to save assistant response", saveError);
        write(
          `data: ${JSON.stringify({
            type: "error",
            message:
              "The response was generated but could not be saved. Keep this document open and review its tracked changes in Word.",
          })}\n\n`,
        );
        write("data: [DONE]\n\n");
        return { ok: true };
      }
      // Local Word chats deliberately have no durable transcript. Only a cloud
      // turn can be curated later, once its reserved assistant row is complete.
      if (
        persistChat &&
        !persistedEvents.some((event) =>
          typeof event === "object" && event !== null && "type" in event
            ? event.type === "error" || event.type === "ask_inputs"
            : false,
        )
      ) {
        const scheduled = await scheduleMemoryConsolidation({
          db,
          surface: "word",
          conversationId: chatId,
          actorUserId: userId,
          projectId: null,
          turnId: assistantMessageId,
          turn: memoryTurn,
        });
        memoryTurnScheduled = scheduled != null;
      }
      // chatId/projectId stay null because a Word chat lives in word_chats —
      // neither chats.id nor projects.id is a legal value for those columns —
      // so `surface: "word"` is what makes these rows identifiable in the
      // history feed. Placement mirrors the chat module: after the response is
      // durable, immediately before [DONE].
      void enqueueChatTurnAudit(
        db,
        {
          userId,
          userEmail,
          chatId: null,
          projectId: null,
          surface: "word",
          // Never the raw prompt: storage:"local" is the user asking that this
          // conversation NOT be kept server-side, so the audit row records that
          // a Word turn happened and which document it touched, not what was
          // said. In cloud mode chatTitle is the prompt-derived title the
          // server already stores, so nothing is lost there.
          title: chatTitle ?? activeDocumentName ?? null,
          model: selectedModel,
        },
        // Word edits are applied client-side in the document, not persisted as
        // doc_created/doc_edited artifacts, so there is nothing here for the
        // artifact fan-out to map — only the chat.message row.
        [],
        drainReceiptsSince(),
      );
      write("data: [DONE]\n\n");
    } catch (error) {
      if (isAbortError(error)) {
        void enqueueChatTurnAudit(
          db,
          {
            userId,
            userEmail,
            chatId: null,
            projectId: null,
            surface: "word",
            title: chatTitle ?? activeDocumentName ?? null,
            model: selectedModel,
            status: "cancelled",
          },
          null,
          drainReceiptsSince(),
        );
        if (error instanceof AssistantStreamError) {
          const partial = buildCancelledAssistantMessage({
            fullText: error.fullText,
            events: error.events,
            buildCitations: (fullText) =>
              extractCitations(fullText, docIndex, docStore),
          });
          const partialEvents = await normalizeAssistantEvents(partial.events);
          const saveError = await updateAssistantMessage(
            partialEvents.length ? partialEvents : null,
            partial.citations.length ? partial.citations : null,
          );
          if (saveError) {
            console.error("[word-chat] failed to save aborted stream", saveError);
          }
        }
        await updateChatActivity();
        // Readers still attached (Stop came from another pane, or this one is
        // only watching) learn the outcome the way a reopen would.
        write(stopOutcomeFrame(run));
        write("data: [DONE]\n\n");
        return { ok: true };
      }
      console.error("[word-chat] stream error", error);
      const errorPayload = assistantStreamErrorPayload(error);
      const message = errorPayload.message;
      const errorEvents =
        error instanceof AssistantStreamError
          ? stripTransientAssistantEvents(error.events)
          : [{ type: "error" as const, message }];
      const errorFullText =
        error instanceof AssistantStreamError ? error.fullText : "";
      try {
        const citations = extractCitations(errorFullText, docIndex, docStore);
        const normalizedErrorEvents = await normalizeAssistantEvents(errorEvents);
        const saveError = await updateAssistantMessage(
          normalizedErrorEvents.length ? normalizedErrorEvents : null,
          citations.length ? citations : null,
        );
        if (saveError) {
          console.error("[word-chat] failed to save stream error", saveError);
        }
      } catch (saveError) {
        console.error("[word-chat] failed to persist stream error", saveError);
      }
      try {
        write(
          `data: ${JSON.stringify({ type: "error", ...errorPayload })}\n\n`,
        );
        write("data: [DONE]\n\n");
      } catch {
        // The client disconnected while the error was being handled.
      }
    } finally {
      // The outcome is stored (or could not be): a restart must not drive
      // this turn again.
      if (durable) {
        await finishTurn(assistantMessageId).catch((error) =>
          console.error("[word-chat] failed to finish a durable turn", safeError(error)),
        );
      }
      stream.finish();
    }
  } finally {
    if (memoryTurn && !memoryTurnScheduled) {
      try {
        await releaseMemoryConversationTurn({
          db,
          surface: "word",
          conversationId: chatId,
          turn: memoryTurn,
        });
      } catch {
        console.warn("[memory] Word activity release failed", { chatId });
      }
    }
  }
  return { ok: true };
}

const RESTART_FAILURE_MESSAGE =
  "This answer was interrupted by a server restart and could not be resumed. Please try again.";

function isWordResumeContext(value: unknown): value is WordChatTurnResumeContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Record<string, unknown>;
  return (
    context.surface === "word" &&
    typeof context.userId === "string" &&
    typeof context.chatId === "string" &&
    typeof context.clientDocumentId === "string" &&
    typeof context.activeDocumentName === "string" &&
    typeof context.turnUserMessageId === "string"
  );
}

type StoredWordMessage = {
  id: string;
  role: string;
  content: unknown;
  files: unknown;
  workflow: unknown;
};

/** A stored message as the pane would send it back: prompts with their files and workflow, answers as prose. */
function wordTranscriptFromRows(rows: StoredWordMessage[]): ChatMessage[] {
  return rows.map((row): ChatMessage => {
    if (row.role !== "assistant") {
      return {
        role: "user",
        content: typeof row.content === "string" ? row.content : null,
        ...(Array.isArray(row.files) ? { files: row.files as ChatMessage["files"] } : {}),
        ...(row.workflow && typeof row.workflow === "object"
          ? { workflow: row.workflow as ChatMessage["workflow"] }
          : {}),
      };
    }
    const text = Array.isArray(row.content)
      ? (row.content as Array<{ type?: unknown; text?: unknown }>)
          .filter((event) => event?.type === "content" && typeof event.text === "string")
          .map((event) => event.text as string)
          .join("")
      : "";
    return { role: "assistant", content: text };
  });
}

/**
 * Drive again a cloud Word turn a previous process left in flight. It is
 * prepared from storage as its request would be (the chat must still be the
 * caller's, on the same document), then driven into a server-owned run a
 * reopening pane attaches to. A turn that can no longer be driven is given up
 * and its reserved row says so.
 */
export async function resumeInterruptedWordChatTurn(
  db: Db,
  turn: { assistantMessageId: string; context: unknown },
): Promise<void> {
  const context = turn.context;
  if (!isWordResumeContext(context)) {
    await abandonTurn(turn.assistantMessageId).catch(() => undefined);
    return;
  }
  try {
    const resumed = await resumeWordChatTurn(db, turn.assistantMessageId, context);
    if (!resumed) {
      await abandonTurn(turn.assistantMessageId).catch(() => undefined);
      await failInterruptedWordTurn(db, context.chatId, turn.assistantMessageId);
    }
  } catch (error) {
    console.error("[word-chat/resume] failed to resume a turn", safeError(error));
    await abandonTurn(turn.assistantMessageId).catch(() => undefined);
    await failInterruptedWordTurn(db, context.chatId, turn.assistantMessageId);
  }
}

async function resumeWordChatTurn(
  db: Db,
  assistantMessageId: string,
  context: WordChatTurnResumeContext,
): Promise<boolean> {
  const { data, error } = await db
    .from("word_chat_messages")
    .select("id, role, content, files, workflow")
    .eq("chat_id", context.chatId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as StoredWordMessage[];
  const answerIndex = rows.findIndex((row) => row.id === assistantMessageId);
  const answer = rows[answerIndex];
  // The reserved row is gone (chat deleted) or already holds the outcome.
  if (!answer) return false;
  if (answer.content != null) {
    await abandonTurn(assistantMessageId);
    return true;
  }
  // The prompt must still be the stored row the turn answers, and the newest
  // prompt: a later send has moved the chat on.
  const prompt = rows[answerIndex - 1];
  if (!prompt || prompt.id !== context.turnUserMessageId || prompt.role !== "user") return false;
  if (rows.slice(answerIndex + 1).some((row) => row.role === "user")) return false;
  const history = rows
    .slice(0, answerIndex)
    .filter((row) => row.role === "user" || row.content != null);

  const prep = await prepareWordChatStream(db, {
    userId: context.userId,
    userEmail: context.userEmail ?? undefined,
    messages: wordTranscriptFromRows(history),
    chatId: context.chatId,
    clientDocumentId: context.clientDocumentId,
    activeDocumentName: context.activeDocumentName,
    documentContext: context.documentContext ?? undefined,
    persistChat: true,
    clientToolsEnabled: context.clientToolsEnabled,
    requestedModel: context.model ?? undefined,
    requestedReasoning: (context.reasoning ?? undefined) as Parameters<
      typeof prepareWordChatStream
    >[1]["requestedReasoning"],
    requestedTimeZone: context.timeZone ?? undefined,
    resumeUserMessageId: context.turnUserMessageId,
  });
  if (!prep.ok || prep.prepared.chatId !== context.chatId) return false;

  const outcome = await driveWordChatTurn(db, {
    prepared: prep.prepared,
    userId: context.userId,
    userEmail: context.userEmail ?? undefined,
    clientDocumentId: context.clientDocumentId,
    activeDocumentName: context.activeDocumentName,
    persistChat: true,
    clientToolsEnabled: context.clientToolsEnabled,
    editApplyMode: context.editApplyMode,
    assistantMessageId,
    durableContext: context,
    resume: true,
    // No pane is attached yet: a reopening pane finds the run through
    // GET /word-chat/:chatId and attaches to it like any other.
    open: (run) => ({ signal: run.signal, write: run.write, finish: run.finish }),
  });
  return outcome.ok;
}

/** Store the failure in the turn's reserved row, so a reopened pane shows why it ended. */
async function failInterruptedWordTurn(
  db: Db,
  chatId: string,
  assistantMessageId: string,
): Promise<void> {
  const update = createReservedAssistantMessageUpdater({
    db,
    table: "word_chat_messages",
    id: assistantMessageId,
    chatId,
    enabled: true,
  });
  const error = await update([{ type: "error", message: RESTART_FAILURE_MESSAGE }], null);
  if (error) console.error("[word-chat/resume] failed to store the interruption", safeError(error));
}
