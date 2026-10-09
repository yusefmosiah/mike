// chat turn — driving one assistant turn, from the run to the stored answer.
//
// The generation half of POST /chat: start the server-owned run, reserve the
// answer's row, stream the model through runLLMStream, and store what came
// back (or the cancellation, or the error). It takes the prepared turn and an
// `open` that attaches the run to whoever is listening, so the route drives it
// for a request and the resumer drives it again, with nobody attached yet,
// for a turn a restart cut off. Neither touches req/res here.
import { randomUUID } from "node:crypto";
import {
    startAssistantTurnRun,
    type AssistantTurnRun,
} from "../../lib/assistantTurnRuns";
import { enqueueChatTurnAudit } from "../../lib/audit";
import { abandonTurn, finishTurn } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import { drainReceiptsSince } from "../../lib/llm/attestation";
import {
    releaseMemoryConversationTurn,
    scheduleMemoryConsolidation,
} from "../../lib/memory/schedule";
import { titleModelForChat } from "../../lib/modelSelection";
import { stopOutcomeFrame } from "../../lib/streamRuns";
import { type Db } from "../../lib/db";
import {
    CHAT_TITLE_FALLBACK,
    generateAssistantChatTitle,
    logChatTitleFailure,
} from "./chat.title";
import { updateChatTitle } from "./chat.titles";
import { prepareChatStream, type PreparedChatStream } from "./chat.prepare";
import { linkedPrompt, walkActivePath, type TreeRow } from "./chat.tree";
import {
    appendAssistantEventsToMessage,
    AssistantStreamError,
    assistantStreamErrorPayload,
    buildCancelledAssistantMessage,
    createReservedAssistantMessageUpdater,
    devLog,
    extractCitations,
    type AskInputsResponseRequest,
    type ChatMessage,
    isAbortError,
    isMeaningfulTextlessAssistantOutput,
    reserveAssistantMessage,
    runLLMStream,
    stripTransientAssistantEvents,
    writeApprovedConnectorFrames,
} from "./engine/index";

/**
 * What a later process needs to drive a chat turn again: the request that
 * started it, minus the history (reloaded from storage up to the turn's
 * prompt). JSON only; it is stored with the turn.
 */
export type ChatTurnResumeContext = {
    surface: "chat";
    userId: string;
    userEmail: string | null;
    chatId: string;
    projectIdProvided: boolean;
    projectId: string | null;
    model: string | null;
    reasoning: string | null;
    autoMode: boolean;
    timeZone: string | null;
    turnUserMessageId: string;
};

export type DriveChatTurnArgs = {
    prepared: PreparedChatStream;
    userId: string;
    userEmail: string | undefined;
    assistantMessageId: string | null;
    inputMessageId: string | null;
    askInputsResponse: AskInputsResponseRequest | null;
    /** Stored with the turn so a restart can drive it again; null for turns that cannot be. */
    durableContext: ChatTurnResumeContext | null;
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
export type DriveChatTurnOutcome =
    | { ok: true }
    | { ok: false; status: number; body: Record<string, unknown> };

export async function driveChatTurn(
    db: Db,
    args: DriveChatTurnArgs,
): Promise<DriveChatTurnOutcome> {
    const { userId, userEmail, assistantMessageId, inputMessageId, askInputsResponse } = args;
    const prepared = args.prepared;
    const {
        chatId,
        lastUser,
        turnUserMessageId,
        turnParentMessageId,
        resolvedProjectId,
        allowDocumentMutation,
        canReadProjectMemory,
        canCurateProjectMemory,
        memorySharedAudience,
        memoryTurn,
        docIndex,
        docStore,
        apiMessages,
        workflowStore,
        legalResearchUs,
        apiKeys,
        titleModel,
        selectedModel,
        selectedReasoningLevel,
        nonce,
        approvalEvents,
        autoMode: turnAutoMode,
    } = prepared;
    let chatTitle = prepared.chatTitle;
    let completedTurnPersisted = prepared.completedTurnPersisted;
    let memoryTurnScheduled = false;

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    try {
        // The generation is a server-owned run from here on: it survives the
        // caller's socket (a refresh, a closed tab) and only the Stop
        // endpoint aborts it. One run per chat at a time.
        const run = startAssistantTurnRun({
            id: assistantMessageId ?? randomUUID(),
            chatId,
            userId,
            assistantMessageId:
                assistantMessageId ??
                askInputsResponse?.assistant_message_id ??
                "",
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
        // Make the advertised identity durable before the response becomes an
        // SSE stream. If this reservation fails, return a normal HTTP error
        // while headers are still mutable; clients must never receive an ID
        // that cannot subsequently be loaded from chat history.
        // A resumed turn's row was reserved by the request that started it.
        if (assistantMessageId && !args.resume) {
            const reserveError = await reserveAssistantMessage({
                db,
                table: "chat_messages",
                id: assistantMessageId,
                chatId,
                // The row the turn's user message occupies: the reused prompt
                // when regenerating, otherwise the freshly inserted sibling.
                // Never the throwaway input uuid — on the reuse path no row
                // with it exists, and parent_message_id references a row.
                inputMessageId:
                    turnUserMessageId ?? (inputMessageId as string),
                authorUserId: userId,
            });
            if (reserveError) {
                console.error(
                    "[chat/stream] failed to reserve assistant message",
                    reserveError,
                );
                run.finish();
                return {
                    ok: false,
                    status: 500,
                    body: { detail: "Failed to start assistant response" },
                };
            }
        }

        const stream = args.open(run);
        const write = stream.write;
        const updateReservedAssistantMessage =
            createReservedAssistantMessageUpdater({
                db,
                table: "chat_messages",
                id: assistantMessageId ?? "",
                chatId,
                enabled: !!assistantMessageId,
            });

        let titlePromise: Promise<void> = Promise.resolve();
        // A holder, not a `let`: it is assigned inside the title promise's
        // catch, which TypeScript's flow analysis cannot see.
        const titleOutcome: { failure: { error: unknown } | null } = { failure: null };
        try {
            write(
                `data: ${JSON.stringify({
                    type: "chat_id",
                    chatId,
                    turnId: run.id,
                    ...(assistantMessageId ? { assistantMessageId } : {}),
                    // The caller's own row already exists (inserted in
                    // prepare, id = turnUserMessageId). The client stamps
                    // its optimistic user message with this so branch
                    // controls render while the answer still streams.
                    ...(turnUserMessageId ? { userMessageId: turnUserMessageId } : {}),
                })}\n\n`,
            );
            writeApprovedConnectorFrames(write, approvalEvents);

            const shouldGenerateTitle =
                !chatTitle && !!lastUser?.content && !askInputsResponse;
            const titleMessage = lastUser
                ? [
                      lastUser.content,
                      lastUser.workflow
                          ? `Workflow: ${lastUser.workflow.title}`
                          : "",
                      lastUser.files?.length
                          ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                          : "",
                  ]
                      .filter(Boolean)
                      .join("\n")
                : "";
            titlePromise = shouldGenerateTitle
                ? generateAssistantChatTitle({
                      model: titleModelForChat(selectedModel, titleModel),
                      message: titleMessage,
                      apiKeys,
                  })
                      .then(async (title) => {
                          const saved = await updateChatTitle(db, {
                              chatId,
                              title,
                          });
                          if (!saved.ok) throw saved.error;
                          chatTitle = title;
                          if (!stream.signal.aborted) {
                              write(
                                  `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                              );
                          }
                      })
                      .catch((error) => {
                          // Decided once the reply has settled: see the
                          // logChatTitleFailure calls below.
                          titleOutcome.failure = { error };
                      })
                : Promise.resolve();

            const { fullText, events, citations } = await runLLMStream({
                apiMessages,
                docStore,
                docIndex,
                userId,
                db,
                write,
                allowDocumentMutation,
                workflowStore,
                includeResearchTools: legalResearchUs,
                model: selectedModel,
                reasoning: selectedReasoningLevel,
                apiKeys,
                signal: stream.signal,
                projectId: resolvedProjectId,
                conversationId: chatId,
                turn: assistantMessageId
                    ? {
                          userMessageId: turnUserMessageId,
                          parentMessageId: turnParentMessageId,
                          assistantMessageId,
                      }
                    : undefined,
                includeMemory: true,
                connectorApprovals: true,
                autoMode: turnAutoMode,
                memoryProjectId: canReadProjectMemory
                    ? resolvedProjectId
                    : null,
                memorySharedAudience,
                nonce,
                // This route first makes the advertised assistant ID durable.
                // It emits [DONE] only after the reserved row has been
                // populated.
                emitDone: false,
                durableTurn: args.durableContext
                    ? { context: args.durableContext, resume: args.resume }
                    : undefined,
            });

            devLog("[chat/stream] LLM stream finished", {
                fullTextLen: fullText?.length ?? 0,
                eventCount: events?.length ?? 0,
            });

            // Upstream providers occasionally end the stream cleanly but empty
            // (observed via OpenRouter). Silence reads as a hung composer, so
            // surface it — unless tools produced visible artifacts, which carry
            // their own completion signal.
            const hasToolOutput =
                approvalEvents.length > 0 ||
                events?.some(isMeaningfulTextlessAssistantOutput);
            if (!fullText?.trim() && !hasToolOutput) {
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        message:
                            "The model returned an empty response. Try again, or pick a different model.",
                        safe_to_display: true,
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
                return { ok: true };
            }

            const persistedEvents = stripTransientAssistantEvents(events);
            if (askInputsResponse) {
                const appended = await appendAssistantEventsToMessage(
                    db,
                    chatId,
                    askInputsResponse.assistant_message_id,
                    userId,
                    persistedEvents,
                    citations,
                );
                completedTurnPersisted = appended;
            } else {
                const saveError = await updateReservedAssistantMessage(
                    persistedEvents.length ? persistedEvents : null,
                    citations.length ? citations : null,
                );
                if (saveError) {
                    console.error(
                        "[chat/stream] failed to save assistant response",
                        saveError,
                    );
                    write(
                        `data: ${JSON.stringify({
                            type: "error",
                            message:
                                "The response was generated but could not be saved.",
                        })}\n\n`,
                    );
                    write("data: [DONE]\n\n");
                    return { ok: true };
                }
            }

            await titlePromise;
            if (titleOutcome.failure) {
                logChatTitleFailure(
                    "[chat/stream] failed to generate chat title",
                    titleOutcome.failure.error,
                    null,
                );
            }

            // Only a title the model could not give, even on a retry, falls
            // back. A turn that never asked (an ask-inputs continuation)
            // leaves the chat untitled for the next turn to title.
            if (!chatTitle && titleOutcome.failure) {
                const title = CHAT_TITLE_FALLBACK;
                // The SSE response is already streaming, so a failure here
                // cannot become an HTTP error — but it must not be announced
                // either: an ignored error pushed a chat_title frame the
                // client rendered and the next reload undid. Log it and leave
                // the chat untitled.
                const saved = await updateChatTitle(db, { chatId, title });
                if (!saved.ok) {
                    console.error("[chat/stream] failed to save chat title", {
                        chatId,
                        message: (saved.error as { message?: string } | null)
                            ?.message,
                    });
                } else {
                    chatTitle = title;
                    if (shouldGenerateTitle && !stream.signal.aborted) {
                        write(
                            `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                        );
                    }
                }
            }

            // ask_inputs is an intentional pause, not a completed conversation.
            // A continuation reuses the preceding assistant row, so resolve that
            // durable identity only when there is no newly reserved message id.
            if (
                completedTurnPersisted &&
                !persistedEvents.some(
                    (event) =>
                        event.type === "ask_inputs" || event.type === "error",
                )
            ) {
                const completedTurnId =
                    assistantMessageId ??
                    askInputsResponse?.assistant_message_id ??
                    null;
                if (completedTurnId) {
                    const scheduled = await scheduleMemoryConsolidation({
                        db,
                        surface: "chat",
                        conversationId: chatId,
                        actorUserId: userId,
                        projectId: canCurateProjectMemory
                            ? resolvedProjectId
                            : null,
                        turnId: completedTurnId,
                        turn: memoryTurn,
                    });
                    memoryTurnScheduled = scheduled != null;
                }
            }
            void enqueueChatTurnAudit(
                db,
                {
                    userId,
                    userEmail,
                    chatId,
                    projectId: resolvedProjectId,
                    title:
                        chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                    model: selectedModel,
                },
                persistedEvents,
                drainReceiptsSince(),
            );
            write("data: [DONE]\n\n");
        } catch (err) {
            // The title ran in parallel with the reply; only now is it known
            // whether its failure is the reply's failure seen twice.
            await titlePromise;
            if (titleOutcome.failure) {
                logChatTitleFailure(
                    "[chat/stream] failed to generate chat title",
                    titleOutcome.failure.error,
                    isAbortError(err) ? null : err,
                );
            }
            if (isAbortError(err)) {
                devLog("[chat/stream] turn stopped", { chatId });
                void enqueueChatTurnAudit(
                    db,
                    {
                        userId,
                        userEmail,
                        chatId,
                        projectId: resolvedProjectId,
                        title: chatTitle,
                        model: selectedModel,
                        status: "cancelled",
                    },
                    null,
                    drainReceiptsSince(),
                );
                if (err instanceof AssistantStreamError) {
                    const partial = buildCancelledAssistantMessage({
                        fullText: err.fullText,
                        events: err.events,
                        buildCitations: (fullText) =>
                            extractCitations(fullText, docIndex),
                    });
                    const saveError = askInputsResponse
                        ? null
                        : await updateReservedAssistantMessage(
                              partial.events.length ? partial.events : null,
                              partial.citations.length
                                  ? partial.citations
                                  : null,
                          );
                    if (askInputsResponse) {
                        await appendAssistantEventsToMessage(
                            db,
                            chatId,
                            askInputsResponse.assistant_message_id,
                            userId,
                            partial.events,
                            partial.citations,
                        );
                    }
                    if (saveError) {
                        console.error(
                            "[chat/stream] failed to save aborted stream",
                            saveError,
                        );
                    }
                }
                // Readers still attached (Stop came from another tab, or
                // this one is watching) learn the outcome the same way a
                // reload would: the stored row ends "Cancelled by user."
                write(stopOutcomeFrame(run));
                write("data: [DONE]\n\n");
                return { ok: true };
            }
            console.error("[chat/stream] error:", err);
            const errorPayload = assistantStreamErrorPayload(err);
            const message = errorPayload.message;
            const errorEvents =
                err instanceof AssistantStreamError
                    ? stripTransientAssistantEvents(err.events)
                    : [{ type: "error" as const, message }];
            const errorFullText =
                err instanceof AssistantStreamError ? err.fullText : "";
            try {
                const citations = extractCitations(errorFullText, docIndex);
                const saveError = askInputsResponse
                    ? null
                    : await updateReservedAssistantMessage(
                          errorEvents.length ? errorEvents : null,
                          citations.length ? citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToMessage(
                        db,
                        chatId,
                        askInputsResponse.assistant_message_id,
                        userId,
                        errorEvents,
                        citations,
                    );
                }
                if (saveError)
                    console.error(
                        "[chat/stream] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[chat/stream] failed to save error", saveErr);
            }
            try {
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        ...errorPayload,
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
            } catch {
                /* ignore */
            }
        } finally {
            // The outcome is stored (or could not be): a restart must not drive
            // this turn again.
            if (args.durableContext && assistantMessageId) {
                await finishTurn(assistantMessageId).catch((error) =>
                    console.error("[chat/stream] failed to finish a durable turn", safeError(error)),
                );
            }
            stream.finish();
        }
    } finally {
        if (memoryTurn && !memoryTurnScheduled) {
            try {
                await releaseMemoryConversationTurn({
                    db,
                    surface: "chat",
                    conversationId: chatId,
                    turn: memoryTurn,
                });
            } catch {
                console.warn("[memory] chat activity release failed", {
                    chatId,
                });
            }
        }
    }
    return { ok: true };
}

const RESTART_FAILURE_MESSAGE =
    "This answer was interrupted by a server restart and could not be resumed. Please try again.";

function isResumeContext(value: unknown): value is ChatTurnResumeContext {
    if (!value || typeof value !== "object") return false;
    const context = value as Record<string, unknown>;
    return (
        context.surface === "chat" &&
        typeof context.userId === "string" &&
        typeof context.chatId === "string" &&
        typeof context.turnUserMessageId === "string"
    );
}

/**
 * A stored path as the client would send it: prompts with their files and
 * workflow, answers as the prose they showed. The history is what prepare
 * builds the turn from (document context, prompts), so it must be the same
 * shape a request carries.
 */
export function transcriptFromRows(rows: TreeRow[]): ChatMessage[] {
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

/** Store the failure in the turn's reserved row, so a reload shows why it ended. */
async function failInterruptedTurn(db: Db, chatId: string, assistantMessageId: string): Promise<void> {
    const update = createReservedAssistantMessageUpdater({
        db,
        table: "chat_messages",
        id: assistantMessageId,
        chatId,
        enabled: true,
    });
    const error = await update([{ type: "error", message: RESTART_FAILURE_MESSAGE }], null);
    if (error) console.error("[chat/resume] failed to store the interruption", safeError(error));
}

/**
 * Drive again a chat turn a previous process left in flight. It is prepared
 * from storage as its request would be (the caller's access is checked again,
 * the documents reloaded), then driven into a server-owned run a reloading
 * client attaches to. A turn that can no longer be driven (access gone,
 * prompt changed, chat deleted) is stopped and its row says so.
 */
export async function resumeInterruptedChatTurn(
    db: Db,
    turn: { assistantMessageId: string; context: unknown },
): Promise<void> {
    const context = turn.context;
    if (!isResumeContext(context)) {
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        return;
    }
    try {
        const resumed = await resumeChatTurn(db, turn.assistantMessageId, context);
        if (!resumed) {
            await abandonTurn(turn.assistantMessageId).catch(() => undefined);
            await failInterruptedTurn(db, context.chatId, turn.assistantMessageId);
        }
    } catch (error) {
        console.error("[chat/resume] failed to resume a turn", safeError(error));
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        await failInterruptedTurn(db, context.chatId, turn.assistantMessageId);
    }
}

async function resumeChatTurn(
    db: Db,
    assistantMessageId: string,
    context: ChatTurnResumeContext,
): Promise<boolean> {
    const path = await walkActivePath(db, context.chatId, context.turnUserMessageId);
    const prompt = path.at(-1);
    // The prompt must still be the stored row the turn answers; prepare would
    // otherwise insert a new one.
    if (!prompt || prompt.id !== context.turnUserMessageId) return false;
    if (!(await linkedPrompt(db, context.chatId, prompt.id, prompt.content))) return false;

    const prep = await prepareChatStream(db, {
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        messages: transcriptFromRows(path),
        chatId: context.chatId,
        inputMessageId: randomUUID(),
        linkOnlyToMessageId: context.turnUserMessageId,
        projectIdProvided: context.projectIdProvided,
        projectId: context.projectId,
        askInputsResponse: null,
        autoMode: context.autoMode,
        requestedModel: context.model ?? undefined,
        requestedReasoning: (context.reasoning ?? undefined) as Parameters<typeof prepareChatStream>[1]["requestedReasoning"],
        requestedTimeZone: context.timeZone ?? undefined,
    });
    if (!prep.ok || prep.prepared.turnUserMessageId !== context.turnUserMessageId) return false;

    const outcome = await driveChatTurn(db, {
        prepared: prep.prepared,
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        assistantMessageId,
        inputMessageId: null,
        askInputsResponse: null,
        durableContext: context,
        resume: true,
        // Nobody is attached yet: a reloading client finds the run through
        // GET /chat/:id and attaches to it like any other.
        open: (run) => ({ signal: run.signal, write: run.write, finish: run.finish }),
    });
    return outcome.ok;
}
