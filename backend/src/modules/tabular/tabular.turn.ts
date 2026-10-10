// Tabular chat turn — driving one review-chat answer, from the run to the
// stored answer.
//
// The generation half of POST /:reviewId/chat: start the server-owned run,
// stream the model through runLLMStream with the review's tools, and store
// what came back (or the cancellation, or the error). It takes the prepared
// turn and an `open` that attaches the run to whoever is listening, so the
// route drives it for a request and the resumer drives it again, with nobody
// attached yet, for a turn a restart cut off. Neither touches req/res here.
import {
    startAssistantTurnRun,
    type AssistantTurnRun,
} from "../../lib/assistantTurnRuns";
import { abandonTurn, finishTurn } from "../../lib/llm";
import {
    releaseMemoryConversationTurn,
    scheduleMemoryConsolidation,
} from "../../lib/memory/schedule";
import { safeError } from "../../lib/safeError";
import { claimTurn, type TurnClaim } from "../../lib/turnClaims";
import { stopOutcomeFrame } from "../../lib/streamRuns";
import type { Db } from "../../lib/db";
import {
    AssistantStreamError,
    assistantStreamErrorPayload,
    buildCancelledAssistantMessage,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    TABULAR_TOOLS,
    type ChatMessage,
} from "../chat/chat.service";
import {
    extractTabularAnnotations,
    prepareTabularChat,
    saveTabularChatTurn,
    titleTabularChat,
    type PreparedTabularChat,
} from "./tabular.chats";

/**
 * What a later process needs to drive a review-chat turn again: the request
 * that started it, minus the history (reloaded from storage up to the turn's
 * prompt). JSON only; it is stored with the turn.
 */
export type TabularChatTurnResumeContext = {
    surface: "tabular";
    userId: string;
    userEmail: string | null;
    reviewId: string;
    chatId: string;
    model: string | null;
    reasoning: string | null;
    timeZone: string | null;
    /** What the client named the review and its project, for the chat title. */
    reviewTitle: string | null;
    projectName: string | null;
    turnUserMessageId: string;
};

type TurnStream = {
    signal: AbortSignal;
    write: (line: string) => boolean;
    finish: () => void;
};

export type DriveTabularChatTurnArgs = {
    prepared: PreparedTabularChat;
    userId: string;
    lastUserContent: string;
    /** The client's names for the review and its project, for the chat title. */
    clientReviewTitle: string | null;
    clientProjectName: string | null;
    assistantMessageId: string;
    /** Stored with the turn so a restart can drive it again; null for turns that cannot be. */
    durableContext: TabularChatTurnResumeContext | null;
    /** Driving a turn a restart cut off: its run is already in Pi. */
    resume?: boolean;
    /**
     * Attach the run to its listener and return the writer the turn streams
     * through. `run` is null only when there is no chat to key one on; the
     * answer then lives and dies with the caller's socket.
     */
    open: (run: AssistantTurnRun | null) => TurnStream;
};

/** A failure before anything streamed, for the route to answer as HTTP. */
export type DriveTabularChatTurnOutcome =
    | { ok: true }
    | { ok: false; status: number; body: Record<string, unknown> };

export async function driveTabularChatTurn(
    db: Db,
    args: DriveTabularChatTurnArgs,
): Promise<DriveTabularChatTurnOutcome> {
    const { prepared, userId, lastUserContent, assistantMessageId } = args;
    const {
        apiMessages,
        apiKeys: api_keys,
        chatId,
        chatTitle,
        inputMessageId,
        turnParentMessageId,
        isFirstExchange,
        memorySharedAudience,
        memoryTurn,
        model: selectedChatModel,
        readableMemoryProjectId,
        reasoningLevel: selectedReasoningLevel,
        reviewTitle,
        tabularStore,
        titleModel,
        writableMemoryProjectId,
    } = prepared;
    const durable = chatId ? args.durableContext : null;
    // The fence `prepareTabularChat` opened is released here unless this turn
    // hands it to the curator (`scheduleMemoryConsolidation`).
    let memoryTurnScheduled = false;
    const releaseMemoryFence = async () => {
        if (!memoryTurn) return;
        try {
            await releaseMemoryConversationTurn({
                db,
                surface: "tabular",
                conversationId: chatId as string,
                turn: memoryTurn,
            });
        } catch {
            console.warn("[memory] tabular activity release failed", {
                chatId,
            });
        }
    };

    // One generating turn per review chat across every replica: the same
    // database claim chat and project chat take (lib/turnClaims.ts). A
    // restarted turn claims again under its own id. If the claim cannot be
    // read the turn goes ahead; the in-process run below still refuses a
    // second turn on this replica.
    let turnClaim: TurnClaim | null = null;
    if (chatId) {
        const claimed = await claimTurn(db, {
            surface: "tabular",
            chatId,
            turnId: assistantMessageId,
            actorUserId: userId,
            actorRole: null,
        });
        if (claimed.ok) {
            turnClaim = claimed.claim;
        } else if (claimed.reason === "held") {
            await releaseMemoryFence();
            return {
                ok: false,
                status: 409,
                body: {
                    code: "turn_in_progress",
                    detail: "A response is already being generated for this chat.",
                    generating: { user_id: claimed.holder.actorUserId, since: claimed.holder.claimedAt },
                },
            };
        } else {
            console.warn("[tabular/chat] turn claim unavailable", safeError(claimed.error));
        }
    }

    // The answer is a server-owned run from here on: it survives the caller's
    // socket (a refresh, a closed panel, a second tab taking over) and only
    // POST .../turn/:turnId/stop aborts it. A chat may have one at a time.
    const run = chatId
        ? startAssistantTurnRun({
              id: assistantMessageId,
              chatId,
              userId,
              assistantMessageId,
              surface: "tabular",
          })
        : null;
    if (chatId && !run) {
        // Refused before the first SSE byte, so the caller gets a status code
        // rather than an error frame — but the user turn is already stored,
        // so the fence this request opened has to be handed back here.
        await turnClaim?.release();
        await releaseMemoryFence();
        return {
            ok: false,
            status: 409,
            body: {
                code: "turn_in_progress",
                detail: "A response is already being generated for this chat.",
            },
        };
    }

    const stream = args.open(run);
    const write = stream.write;

    if (chatId && run) {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                turnId: run.id,
            })}\n\n`,
        );
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            includeResearchTools: false,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: selectedChatModel,
            reasoning: selectedReasoningLevel,
            apiKeys: api_keys,
            signal: stream.signal,
            conversationId: chatId,
            turn: chatId
                ? {
                      userMessageId: inputMessageId,
                      parentMessageId: turnParentMessageId,
                      assistantMessageId,
                  }
                : undefined,
            includeMemory: true,
            memoryProjectId: readableMemoryProjectId,
            memorySharedAudience,
            emitDone: false,
            durableTurn: durable
                ? { context: durable, resume: args.resume }
                : undefined,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        let assistantSaved = false;
        if (chatId) {
            const saved = await saveTabularChatTurn(db, {
                chatId,
                messageId: assistantMessageId,
                authorUserId: userId,
                memoryInputMessageId: inputMessageId,
                content: persistedEvents,
                annotations,
                touch: "when-saved",
            });
            if (saved.error)
                console.error(
                    "[tabular/chat] failed to save assistant response",
                    saved.error,
                );
            assistantSaved = saved.saved;
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUserContent) {
            const title = await titleTabularChat(db, {
                chatId,
                titleModel,
                userContent: lastUserContent,
                reviewTitle: args.clientReviewTitle ?? reviewTitle ?? null,
                projectName: args.clientProjectName ?? null,
                apiKeys: api_keys,
            });
            if (title) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }

        // Only a durably saved, successful turn is worth consolidating: an
        // `ask_inputs` continuation is not finished, and an `error` frame is
        // not a turn at all.
        if (
            chatId &&
            assistantSaved &&
            !persistedEvents.some(
                (event) =>
                    event.type === "ask_inputs" || event.type === "error",
            )
        ) {
            const scheduled = await scheduleMemoryConsolidation({
                db,
                surface: "tabular",
                conversationId: chatId,
                actorUserId: userId,
                projectId: writableMemoryProjectId,
                turnId: assistantMessageId,
                turn: memoryTurn,
            });
            memoryTurnScheduled = scheduled != null;
        }
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[tabular/chat] turn stopped", { chatId });
            if (chatId && err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractTabularAnnotations(fullText, tabularStore),
                });
                const { error: saveError } = await saveTabularChatTurn(db, {
                    chatId,
                    messageId: assistantMessageId,
                    authorUserId: userId,
                    memoryInputMessageId: inputMessageId,
                    content: partial.events,
                    annotations: partial.citations,
                    touch: "always",
                });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
            }
            // Readers still attached (Stop came from another tab, or this one
            // is only watching) learn the outcome the same way a reload
            // would: the stored row now ends "Cancelled by user."
            write(stopOutcomeFrame(run));
            write("data: [DONE]\n\n");
            return { ok: true };
        }
        console.error("[tabular/chat] error", err);
        const errorPayload = assistantStreamErrorPayload(err);
        const message = errorPayload.message;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        if (chatId) {
            try {
                const { error: saveError } = await saveTabularChatTurn(db, {
                    chatId,
                    messageId: assistantMessageId,
                    authorUserId: userId,
                    memoryInputMessageId: inputMessageId,
                    content: errorEvents,
                    annotations: extractTabularAnnotations(
                        errorFullText,
                        tabularStore,
                    ),
                    touch: "never",
                });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[tabular/chat] failed to save error", saveErr);
            }
        }
        try {
            write(
                `data: ${JSON.stringify({ type: "error", ...errorPayload })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        // The outcome is stored (or could not be): a restart must not drive
        // this turn again.
        if (durable) {
            await finishTurn(assistantMessageId).catch((error) =>
                console.error("[tabular/chat] failed to finish a durable turn", safeError(error)),
            );
        }
        // Ends every response attached to the run — this one, a reload, a
        // second tab — and starts its retention window, so a client
        // reconnecting a moment later still gets the last frames.
        stream.finish();
        await turnClaim?.release();
        // Whatever ended the stream, the fence must not outlive it: released
        // here unless this turn already handed it to the curator, which owns
        // it from that point on.
        if (!memoryTurnScheduled) await releaseMemoryFence();
    }
    return { ok: true };
}

const RESTART_FAILURE_MESSAGE =
    "This answer was interrupted by a server restart and could not be resumed. Please try again.";

function isTabularResumeContext(value: unknown): value is TabularChatTurnResumeContext {
    if (!value || typeof value !== "object") return false;
    const context = value as Record<string, unknown>;
    return (
        context.surface === "tabular" &&
        typeof context.userId === "string" &&
        typeof context.reviewId === "string" &&
        typeof context.chatId === "string" &&
        typeof context.turnUserMessageId === "string"
    );
}

type StoredTabularMessage = { id: string; role: string; content: unknown };

/** A stored message as the panel would send it back: prompts as typed, answers as prose. */
function tabularTranscriptFromRows(rows: StoredTabularMessage[]): ChatMessage[] {
    return rows.map((row): ChatMessage => {
        if (row.role !== "assistant") {
            return {
                role: "user",
                content: typeof row.content === "string" ? row.content : null,
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
 * Drive again a review-chat turn a previous process left in flight. It is
 * prepared from storage as its request would be (review access checked again,
 * the grid reloaded), then driven into a server-owned run a reloading panel
 * attaches to. A turn that can no longer be driven is given up and an answer
 * row saying so is stored under its prompt.
 */
export async function resumeInterruptedTabularChatTurn(
    db: Db,
    turn: { assistantMessageId: string; context: unknown },
): Promise<void> {
    const context = turn.context;
    if (!isTabularResumeContext(context)) {
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        return;
    }
    try {
        const resumed = await resumeTabularChatTurn(db, turn.assistantMessageId, context);
        if (!resumed) {
            await abandonTurn(turn.assistantMessageId).catch(() => undefined);
            await failInterruptedTabularTurn(db, turn.assistantMessageId, context);
        }
    } catch (error) {
        console.error("[tabular/resume] failed to resume a turn", safeError(error));
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        await failInterruptedTabularTurn(db, turn.assistantMessageId, context);
    }
}

async function loadChatMessages(db: Db, chatId: string): Promise<StoredTabularMessage[]> {
    const { data, error } = await db
        .from("tabular_review_chat_messages")
        .select("id, role, content")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as StoredTabularMessage[];
}

async function resumeTabularChatTurn(
    db: Db,
    assistantMessageId: string,
    context: TabularChatTurnResumeContext,
): Promise<boolean> {
    const rows = await loadChatMessages(db, context.chatId);
    // Stored before the process died: nothing left to drive.
    if (rows.some((row) => row.id === assistantMessageId)) {
        await abandonTurn(assistantMessageId);
        return true;
    }
    // The prompt must still be the newest message: anything after it means
    // the chat has moved on without this answer.
    const prompt = rows.at(-1);
    if (!prompt || prompt.id !== context.turnUserMessageId || prompt.role !== "user") return false;
    if (typeof prompt.content !== "string" || !prompt.content.trim()) return false;

    const prep = await prepareTabularChat(db, {
        reviewId: context.reviewId,
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        messages: tabularTranscriptFromRows(rows),
        lastUserContent: prompt.content,
        chatId: context.chatId,
        requestedModel: context.model ?? undefined,
        requestedReasoning: context.reasoning ?? undefined,
        requestedTimeZone: context.timeZone ?? undefined,
        resumeUserMessageId: context.turnUserMessageId,
    });
    if (!prep.ok || prep.data.chatId !== context.chatId) return false;

    const outcome = await driveTabularChatTurn(db, {
        prepared: prep.data,
        userId: context.userId,
        lastUserContent: prompt.content,
        clientReviewTitle: context.reviewTitle,
        clientProjectName: context.projectName,
        assistantMessageId,
        durableContext: context,
        resume: true,
        // Nobody is attached yet: a reloading panel finds the run through the
        // chat list's `active_turn` and attaches to it like any other.
        open: (run) => ({
            signal: run!.signal,
            write: run!.write,
            finish: run!.finish,
        }),
    });
    return outcome.ok;
}

/** Store the failure as the turn's answer, so a reload shows why it ended. */
async function failInterruptedTabularTurn(
    db: Db,
    assistantMessageId: string,
    context: TabularChatTurnResumeContext,
): Promise<void> {
    try {
        const rows = await loadChatMessages(db, context.chatId);
        if (rows.some((row) => row.id === assistantMessageId)) return;
        if (!rows.some((row) => row.id === context.turnUserMessageId)) return;
        const { error } = await saveTabularChatTurn(db, {
            chatId: context.chatId,
            messageId: assistantMessageId,
            authorUserId: context.userId,
            memoryInputMessageId: context.turnUserMessageId,
            content: [{ type: "error", message: RESTART_FAILURE_MESSAGE }],
            annotations: [],
            touch: "never",
        });
        if (error) throw error;
    } catch (error) {
        console.error("[tabular/resume] failed to store the interruption", safeError(error));
    }
}
