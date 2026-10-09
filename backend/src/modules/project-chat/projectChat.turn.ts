// project chat turn — driving one project assistant turn, from the run to the
// stored answer.
//
// The generation half of POST /projects/:projectId/chat: start the
// server-owned run, stream the model through runLLMStream, and store what
// came back (or the cancellation, or the error). It takes the prepared turn
// and an `open` that attaches the run to whoever is listening, so the route
// drives it for a request and the resumer drives it again, with nobody
// attached yet, for a turn a restart cut off. Neither touches req/res here.
import { randomUUID } from "node:crypto";
import {
    startAssistantTurnRun,
    type AssistantTurnRun,
} from "../../lib/assistantTurnRuns";
import { enqueueChatTurnAudit } from "../../lib/audit";
import { finishTurn } from "../../lib/llm";
import { drainReceiptsSince } from "../../lib/llm/attestation";
import {
    releaseMemoryConversationTurn,
    scheduleMemoryConsolidation,
} from "../../lib/memory/schedule";
import { titleModelForChat } from "../../lib/modelSelection";
import { safeError } from "../../lib/safeError";
import { stopOutcomeFrame } from "../../lib/streamRuns";
import type { Db } from "../../lib/db";
import {
    appendAssistantEventsToMessage,
    AssistantStreamError,
    assistantStreamErrorPayload,
    buildCancelledAssistantMessage,
    extractCitations,
    CHAT_TITLE_FALLBACK,
    generateAssistantChatTitle,
    isAbortError,
    logChatTitleFailure,
    PROJECT_EXTRA_TOOLS,
    runLLMStream,
    setLeaf,
    stripTransientAssistantEvents,
    updateChatTitle,
    writeApprovedConnectorFrames,
    type AskInputsResponseRequest,
    type AssistantEvent,
    type ChatDocumentReference,
    type ChatWriteResult,
} from "../chat/chat.service";
import type { PreparedProjectChatStream } from "./projectChat.service";

/**
 * What a later process needs to drive a project chat turn again: the request
 * that started it, minus the history (reloaded from storage up to the turn's
 * prompt). JSON only; it is stored with the turn.
 */
export type ProjectChatTurnResumeContext = {
    surface: "project-chat";
    userId: string;
    userEmail: string | null;
    projectId: string;
    chatId: string;
    model: string | null;
    reasoning: string | null;
    autoMode: boolean;
    timeZone: string | null;
    displayedDoc: ChatDocumentReference | null;
    attachedDocuments: ChatDocumentReference[] | null;
    turnUserMessageId: string;
};

export type DriveProjectChatTurnArgs = {
    prepared: PreparedProjectChatStream;
    userId: string;
    userEmail: string | undefined;
    projectId: string;
    assistantMessageId: string | null;
    inputMessageId: string | null;
    askInputsResponse: AskInputsResponseRequest | null;
    /** Stored with the turn so a restart can drive it again; null for turns that cannot be. */
    durableContext: ProjectChatTurnResumeContext | null;
    /** Driving a turn a restart cut off: its run is already in Pi. */
    resume?: boolean;
    /** Attach the run to its listener and return the writer the turn streams through. */
    open: (run: AssistantTurnRun) => {
        signal: AbortSignal;
        write: (line: string) => boolean;
        finish: () => void;
    };
};

/** A failure before anything streamed, for the route to answer as HTTP. */
export type DriveProjectChatTurnOutcome =
    | { ok: true }
    | { ok: false; status: number; body: Record<string, unknown> };

// Persist the assistant's turn for a project chat.
//
// The streaming route reaches this from three places — the completed turn,
// the partial saved after a client abort, and the error turn — which all
// wrote the same row with the same "empty array means NULL" normalisation.
// That normalisation lives here so every caller stores an identical shape.
//
// Unlike the global /chat stream, this route does not pre-reserve an
// assistant message id, so the turn is a plain insert rather than an update.
// The id is still generated up front so the client can associate the streamed
// UI with the durable row, and `memory_input_message_id` links the turn back
// to the user message that opened it for the memory curator.
export async function insertAssistantMessage(
    db: Db,
    args: {
        chatId: string;
        assistantMessageId: string | null;
        events: AssistantEvent[];
        citations: unknown[];
        authorUserId: string;
        inputMessageId: string | null;
        /**
         * Tree parent for the row. Defaults to the user input message that
         * opened the turn; callers that know a different parent pass it.
         */
        parentMessageId?: string | null;
    },
): Promise<ChatWriteResult> {
    const { error } = await db.from("chat_messages").insert({
        id: args.assistantMessageId,
        chat_id: args.chatId,
        role: "assistant",
        content: args.events.length ? args.events : null,
        citations: args.citations.length ? args.citations : null,
        author_user_id: args.authorUserId,
        memory_input_message_id: args.inputMessageId,
        parent_message_id: args.parentMessageId ?? args.inputMessageId,
    });

    if (error) return { ok: false, error };

    // Advance the caller's leaf onto the saved answer, so a reload resolves
    // to it instead of stopping at the user row. Bookkeeping only: the row
    // above is durable, so a failed leaf move must not fail the save; the
    // leaf then stays on the user row (degraded, still visible).
    if (args.assistantMessageId) {
        try {
            await setLeaf(
                db,
                args.chatId,
                args.authorUserId,
                args.assistantMessageId,
            );
        } catch (leafError) {
            console.error(
                "[project-chat/stream] failed to move chat leaf",
                leafError,
            );
        }
    }
    return { ok: true };
}

export async function driveProjectChatTurn(
    db: Db,
    args: DriveProjectChatTurnArgs,
): Promise<DriveProjectChatTurnOutcome> {
    const {
        prepared,
        userId,
        userEmail,
        projectId,
        assistantMessageId,
        inputMessageId,
        askInputsResponse,
    } = args;
    const {
        chatId,
        lastUser,
        turnUserMessageId,
        turnParentMessageId,
        allowDocumentMutation,
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
    // Mutable: the title-generation flow below reassigns it once a title
    // has been persisted.
    let chatTitle = prepared.chatTitle;
    let completedTurnPersisted = prepared.completedTurnPersisted;
    let memoryTurnScheduled = false;

    try {
        // The generation is a server-owned run: it survives the caller's
        // socket and only the Stop endpoint (POST /chat/:chatId/turn/:turnId/
        // stop) aborts it. `attachAssistantTurnSse` gives the same
        // { signal, write, finish } the chat route drives its stream with.
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
        const stream = args.open(run);
        const write = stream.write;

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
                    // Same contract as the non-project chat route: the
                    // caller's user row already exists (turnUserMessageId).
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

            const { events, citations } = await runLLMStream({
                apiMessages,
                docStore,
                docIndex,
                userId,
                db,
                write,
                extraTools: PROJECT_EXTRA_TOOLS,
                // Read-only collaborators keep the conversational surface
                // (read_document, find_in_document, list/fetch_documents, the
                // workflow and research tools) and lose only the writers.
                allowDocumentMutation,
                workflowStore,
                includeResearchTools: legalResearchUs,
                model: selectedModel,
                reasoning: selectedReasoningLevel,
                apiKeys,
                signal: stream.signal,
                projectId,
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
                memoryProjectId: projectId,
                memorySharedAudience,
                nonce,
                emitDone: false,
                durableTurn: args.durableContext
                    ? { context: args.durableContext, resume: args.resume }
                    : undefined,
            });

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
                const saved = await insertAssistantMessage(db, {
                    chatId,
                    assistantMessageId,
                    events: persistedEvents,
                    citations,
                    authorUserId: userId,
                    inputMessageId: turnUserMessageId ?? inputMessageId,
                });
                if (!saved.ok) {
                    console.error(
                        "[project-chat/stream] failed to save assistant response",
                        saved.error,
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
                    "[project-chat/stream] failed to generate chat title",
                    titleOutcome.failure.error,
                    null,
                );
            }

            // Only a title the model could not give, even on a retry, falls
            // back; see the chat turn.
            if (!chatTitle && titleOutcome.failure) {
                const title = CHAT_TITLE_FALLBACK;
                await updateChatTitle(db, { chatId, title });
                chatTitle = title;
                if (shouldGenerateTitle && !stream.signal.aborted) {
                    write(
                        `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                    );
                }
            }

            // A completed, durable assistant turn is the debounce trigger for the
            // asynchronous memory curator. ask_inputs is a pause, so continuations
            // resolve the existing assistant row and only schedule once it closes.
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
                        projectId: allowDocumentMutation ? projectId : null,
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
                    projectId,
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
                    "[project-chat/stream] failed to generate chat title",
                    titleOutcome.failure.error,
                    isAbortError(err) ? null : err,
                );
            }
            if (isAbortError(err)) {
                console.log("[project-chat/stream] turn stopped", {
                    chatId,
                });
                if (err instanceof AssistantStreamError) {
                    const partial = buildCancelledAssistantMessage({
                        fullText: err.fullText,
                        events: err.events,
                        buildCitations: (fullText) =>
                            extractCitations(fullText, docIndex),
                    });
                    const saved = askInputsResponse
                        ? null
                        : await insertAssistantMessage(db, {
                              chatId,
                              assistantMessageId,
                              events: partial.events,
                              citations: partial.citations,
                              authorUserId: userId,
                              inputMessageId: turnUserMessageId ?? inputMessageId,
                          });
                    const saveError = saved && !saved.ok ? saved.error : null;
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
                            "[project-chat/stream] failed to save aborted stream",
                            saveError,
                        );
                    }
                }
                write(stopOutcomeFrame(run));
                write("data: [DONE]\n\n");
                return { ok: true };
            }
            console.error("[project-chat/stream] error:", err);
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
                const saved = askInputsResponse
                    ? null
                    : await insertAssistantMessage(db, {
                          chatId,
                          assistantMessageId,
                          events: errorEvents,
                          citations,
                          authorUserId: userId,
                          inputMessageId: turnUserMessageId ?? inputMessageId,
                      });
                const saveError = saved && !saved.ok ? saved.error : null;
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
                        "[project-chat/stream] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error(
                    "[project-chat/stream] failed to save error",
                    saveErr,
                );
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
            if (args.durableContext && assistantMessageId) {
                await finishTurn(assistantMessageId).catch((error) =>
                    console.error("[project-chat/stream] failed to finish a durable turn", safeError(error)),
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
                console.warn("[memory] project chat activity release failed", {
                    chatId,
                });
            }
        }
    }
    return { ok: true };
}
