// Business logic + data-access for the project-chat module.
//
// Service layer behind projectChat.routes.ts. Takes an explicit database client
// (`db`) plus request-derived primitives, does the pre-stream DB orchestration,
// and RETURNS the prepared data (or a typed error). It never touches req/res.
//
// The generation itself (runLLMStream, abort handling, assistant-message
// persistence) is projectChat.turn.ts, driven by the route for a request and
// by resumeInterruptedProjectChatTurn after a restart.

import { randomUUID } from "node:crypto";
import { abandonTurn } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import { createTurnAdmission, type TurnClaim } from "../../lib/turnClaims";
import type { Db } from "../../lib/db";
import { resolveRequestTimeZone } from "../../lib/userTime";
import type { McpToolEvent } from "@mike/contracts";
import {
    buildProjectDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    buildWorkflowStore,
    enrichWithPriorEvents,
    loadUserMessageSentTimes,
    appendAskInputsResponseToAssistantMessage,
    linkedPrompt,
    resolveLeaf,
    transcriptFromRows,
    walkActivePath,
    runApprovedConnectorActions,
    setLeaf,
    generateSpotlightNonce,
    spotlightFilename,
    type AskInputsResponseRequest,
    type ChatDocumentReference,
    type ChatMessage,
} from "../chat/chat.service";
import { getUserModelSettings, resolveUserChatSelection } from "../user/user.service";
import {
    checkProjectAccess,
    ensureChatAccess,
    projectHasSharedAudience,
    resolveContentOrgId,
} from "../../lib/access";
import { hasDirectContentGrants } from "../../lib/contentAccess";
import { can, type ProjectRole } from "../../lib/permissions";
import {
    resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";
import {
    beginMemoryConversationTurn,
    releaseMemoryConversationTurn,
    type MemoryConversationTurn,
} from "../../lib/memory/schedule";
// A project chat IS a `chats` row, so its title is persisted by the chat
// module. Crossing module boundaries is only allowed through the facade, so
// this reaches chat via `chat.service` and re-exports the function by name —
// the route imports everything it needs from its own service.
import { updateChatTitle, type ChatWriteResult } from "../chat/chat.service";
import {
    driveProjectChatTurn,
    insertAssistantMessage,
    type ProjectChatTurnResumeContext,
} from "./projectChat.turn";

export { updateChatTitle };
export type { ChatWriteResult };
export {
    driveProjectChatTurn,
    insertAssistantMessage,
    type ProjectChatTurnResumeContext,
} from "./projectChat.turn";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of documents the user has organised for a single matter or piece of work. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
Copies created with replicate_document are saved as project documents in this project. After replication, use the returned doc_id for any requested edits.`;

export type PreparedProjectChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
    /** The row this turn's user message occupies (null for ask_inputs continuations). */
    turnUserMessageId: string | null;
    /** The tree parent of this turn's user message (null for a chat's first message). */
    turnParentMessageId: string | null;
    // Whether the turn that is about to stream has a durable row behind it.
    // An ask_inputs continuation that could not be appended is not durable,
    // and must not trigger memory consolidation.
    completedTurnPersisted: boolean;
    // Connector actions the user approved in this continuation, already run
    // and appended; the route streams them before the model continues.
    approvalEvents: McpToolEvent[];
    // Auto Mode opt-in for this turn, forwarded to runLLMStream. Every caller
    // that reaches this function already holds content.edit (the gate above
    // answers 403 otherwise), so it is the same standing writing needs.
    autoMode: boolean;
    // Whether the document-WRITING tools are offered this turn. This is a
    // question about the caller's standing on the PROJECT, never about their
    // standing in the thread — see the long note in prepareProjectChatStream.
    allowDocumentMutation: boolean;
    memorySharedAudience: boolean;
    memoryTurn: MemoryConversationTurn | null;
    docIndex: Awaited<ReturnType<typeof buildProjectDocContext>>["docIndex"];
    docStore: Awaited<ReturnType<typeof buildProjectDocContext>>["docStore"];
    apiMessages: ReturnType<typeof buildMessages>;
    workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
    legalResearchUs: boolean;
    apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
    titleModel: Awaited<ReturnType<typeof getUserModelSettings>>["title_model"];
    selectedModel: string;
    selectedReasoningLevel: ReturnType<
        typeof resolveEffectiveReasoningLevel
    >;
    nonce: ReturnType<typeof generateSpotlightNonce>;
    /** This turn's hold on the thread across replicas; released when it ends. */
    turnClaim: TurnClaim | null;
    /** The standing the sender held when the turn was admitted. */
    actorRole: string | null;
};

type PrepareProjectChatStreamArgs = {
        userId: string;
        userEmail: string | undefined;
        projectId: string;
        messages: ChatMessage[];
        chatId: string | null;
        // Pre-generated id for the user message this turn persists, so the
        // route can link the assistant row to it via memory_input_message_id.
        inputMessageId: string | null;
        /**
         * Regenerate names the existing prompt the new answer hangs from; see
         * linkOnlyToMessageId in prepareChatStream. Without it a send is a send.
         */
        linkOnlyToMessageId?: string | null;
        displayed_doc: ChatDocumentReference | undefined;
        attached_documents: ChatDocumentReference[] | undefined;
        // Parsed `ask_inputs_response` payload (answers to an ask_inputs
        // event emitted by the assistant in a prior turn). When present, the
        // user's answers are appended onto the previous assistant message
        // instead of being stored as a new user message.
        askInputsResponse: AskInputsResponseRequest | null;
        /**
         * Auto Mode requested for this turn. Echoed back through `prepared`
         * so the route hands the stream one verdict; the content.edit gate
         * above is what decides whether the caller may use it.
         */
        autoMode?: boolean;
        requestedModel: string | null | undefined;
        requestedReasoning:
            | ReturnType<typeof resolveEffectiveReasoningLevel>
            | undefined;
        /** The browser's IANA time zone; unvalidated request input. */
        requestedTimeZone?: unknown;
        /** The turn being admitted: its assistant row's id. */
        turnId: string;
};

type ProjectChatPrepareFailure =
    | { ok: false; status: number; code?: string; detail: string; generating?: { user_id: string | null; since: string | null } }
    // "internal" carries the raw error so the route can hand it to
    // sendInternalError, preserving the request_id in the body and the
    // [http/internal-error] correlation log.
    | { ok: false; internal: true; error: unknown };

export async function prepareProjectChatStream(
    db: Db,
    args: PrepareProjectChatStreamArgs,
): Promise<{ ok: true; prepared: PreparedProjectChatStream } | ProjectChatPrepareFailure> {
    // The thread is claimed across replicas before anything is written to
    // it; see createTurnAdmission.
    const admission = createTurnAdmission(db, { surface: "chat", userId: args.userId, turnId: args.turnId });
    const result = await prepareAdmittedProjectChatStream(db, args, admission.admit);
    if (!result.ok) {
        await admission.abandon();
        return result;
    }
    return {
        ok: true,
        prepared: { ...result.prepared, turnClaim: admission.claim(), actorRole: admission.role() },
    };
}

async function prepareAdmittedProjectChatStream(
    db: Db,
    args: PrepareProjectChatStreamArgs,
    admit: (chatId: string, role: string | null) => Promise<ProjectChatPrepareFailure | null>,
): Promise<
    | { ok: true; prepared: Omit<PreparedProjectChatStream, "turnClaim" | "actorRole"> }
    | ProjectChatPrepareFailure
> {
    const {
        userId,
        userEmail,
        projectId,
        messages,
        displayed_doc,
        attached_documents,
    } = args;

    // Verify the caller can reach the project at all. Whether they may WRITE
    // is decided below, once we know whether this is their own chat.
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    // Memory bookkeeping never decides whether the user gets an answer: a
    // database error in the audience check is reported as a normal internal
    // failure instead of escaping as a rejected promise.
    let memorySharedAudience = false;
    try {
        memorySharedAudience = await projectHasSharedAudience(
            db,
            projectId,
            projectAccess.project.org_id,
        );
    } catch (error) {
        return { ok: false, internal: true, error };
    }

    // Two different questions, deliberately answered by two different
    // derivations:
    //
    //   (1) May this caller CONTINUE THIS CONVERSATION? That is standing on
    //       the chat — `writeRole` below, from ensureChatAccess.
    //   (2) May this caller MODIFY THIS PROJECT'S DOCUMENTS? That is standing
    //       on the PROJECT, and nothing about a chat can grant it.
    //
    // They come apart exactly where chats gained grants of their own. A
    // project VIEWER holding a member grant on one chat may talk in that
    // thread, but the tool
    // loop runs against `buildProjectDocContext`, which loads EVERY document
    // in the project with no per-caller filter. Judging the tools on the
    // chat-derived role would hand that viewer edit_document, replicate_document
    // and the generate_* family over the whole project through a thread
    // someone shared with them.
    const allowDocumentMutation = can(projectAccess.projectRole, "content.edit");

    let chatId = args.chatId;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;

    // The role this write is judged against. Starting a NEW chat is judged
    // against the project — the caller is adding content to it. Continuing
    // an EXISTING one is judged against that chat, because a chat carries
    // standing of its own.
    let writeRole: ProjectRole | null = projectAccess.projectRole;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select(
                "id, title, model, reasoning_level, project_id, user_id, org_id",
            )
            .eq("id", chatId)
            .maybeSingle();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else {
            chatTitle = existing!.title;
            chatModel = (existing!.model as string | null) ?? null;
            chatReasoningLevel =
                (existing!.reasoning_level as string | null) ?? null;
            // Exactly the derivation GET /chat uses, so the two routes can
            // no longer disagree about who may write. It folds in the
            // branches the project role alone cannot see: the chat's own
            // creator, direct grants, and the chat's org — strongest-wins.
            //
            // A project VIEWER holding a member grant on the chat derives
            // `member` from ensureChatAccess and can open and read
            // the thread through GET /chat, while this route still saw only
            // their viewer role on the project and returned 403. The client
            // gates on the served role, so it rendered the message and then
            // lost it — nothing had been persisted.
            const chatAccess = await ensureChatAccess(
                existing as {
                    id: string;
                    user_id: string | null;
                    project_id: string | null;
                    org_id?: string | null;
                },
                userId,
                userEmail,
                db,
            );
            // No verdict at all means no write. `can(null, …)` is false, so
            // an unreadable chat cannot be written through this door either.
            writeRole = chatAccess.ok ? chatAccess.projectRole : null;
            try {
                memorySharedAudience =
                    memorySharedAudience ||
                    (await hasDirectContentGrants(db, "chat", existing!.id));
            } catch (error) {
                return { ok: false, internal: true, error };
            }
        }
    }

    // This verdict must precede model resolution: the model/reasoning
    // persistence below is a real UPDATE on the chats row, and running it
    // ahead of the gate would let a refused caller permanently change the
    // model on a thread they may not write to.
    if (!can(writeRole, "content.edit"))
        return {
            ok: false,
            status: 403,
            detail: "You do not have permission to write in this project.",
        };
    if (chatId) {
        const refused = await admit(chatId, writeRole);
        if (refused) return refused;
    }

    const selection = await resolveUserChatSelection(db, {
        userId,
        chatModel,
        chatReasoningLevel,
        requestedModel: args.requestedModel,
        requestedReasoning: args.requestedReasoning,
    });
    if (!selection.ok) return selection;
    const { modelSettings, selectedModel, selectedReasoningLevel } = selection;

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to save chat model",
            };
        }
    }

    if (!chatId) {
        const resolvedOrg = await resolveContentOrgId(db, { projectId });
        if (!resolvedOrg.ok) {
            return { ok: false, status: 500, detail: "Failed to create chat" };
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: projectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
                org_id: resolvedOrg.orgId,
            })
            .select("id, title")
            .single();
        if (error || !newChat)
            return { ok: false, status: 500, detail: "Failed to create chat" };
        chatId = newChat.id as string;
        chatTitle = newChat.title;
        const refused = await admit(chatId, "owner");
        if (refused) return refused;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let completedTurnPersisted = true;
    let memoryTurn: MemoryConversationTurn | null = null;
    let approvalEvents: McpToolEvent[] = [];
    // The row this turn's user message occupies (null for continuations that
    // append to an existing assistant row). Callers wire the assistant row's
    // parent/memory link from this, never from a freshly generated id that
    // may not have been inserted.
    let turnUserMessageId: string | null = null;
    let turnParentMessageId: string | null = null;
    if (args.askInputsResponse) {
        const appendResult = await appendAskInputsResponseToAssistantMessage(
            db,
            chatId,
            args.askInputsResponse,
            userId,
        );
        if (appendResult === "forbidden") {
            return {
                ok: false,
                status: 403,
                detail:
                    "Only the user who started this turn can answer these questions",
            };
        }
        if (appendResult === "invalid") {
            return {
                ok: false,
                status: 400,
                detail: "The answers do not match the pending questions",
            };
        }
        if (appendResult === "stale") {
            return {
                ok: false,
                status: 409,
                code: "ask_inputs_stale",
                detail:
                    "These questions have already been answered or are no longer active",
            };
        }
        completedTurnPersisted = appendResult === "appended";
        if (!completedTurnPersisted) {
            return { ok: false, status: 500, detail: "Failed to save message" };
        }
        // The append above is the single-use claim; only now may an approved
        // connector action run.
        approvalEvents = await runApprovedConnectorActions({
            db,
            chatId,
            messageId: args.askInputsResponse.assistant_message_id,
            askEventId: args.askInputsResponse.ask_event_id,
            userId,
        });
    } else if (lastUser) {
        // The new user turn hangs off the caller's active leaf (same rule as
        // the global chat stream): after branch navigation the leaf can be
        // older than the newest row, and parenting to the newest row would
        // put the turn on the wrong branch.
        const parentMessageId = await resolveLeaf(db, chatId as string, userId);

        // A re-answer names its stored prompt (mirrors chat.prepare.ts).
        const linked = args.linkOnlyToMessageId
            ? await linkedPrompt(db, chatId as string, args.linkOnlyToMessageId, lastUser.content)
            : null;

        if (linked) {
            turnUserMessageId = linked.id;
            turnParentMessageId = linked.parentMessageId;
        } else {
            const { error: userMessageError } = await db
                .from("chat_messages")
                .insert({
                    id: args.inputMessageId,
                    chat_id: chatId,
                    role: "user",
                    content: lastUser.content,
                    files: lastUser.files ?? null,
                    workflow: lastUser.workflow ?? null,
                    author_user_id: userId,
                    parent_message_id: parentMessageId,
                });
            if (userMessageError) {
                return { ok: false, internal: true, error: userMessageError };
            }
            turnUserMessageId = args.inputMessageId;
            turnParentMessageId = parentMessageId;

            // Bookkeeping only: the row above is already durable, so a failed
            // leaf move must not fail the turn.
            if (args.inputMessageId) {
                try {
                    await setLeaf(db, chatId as string, userId, args.inputMessageId);
                } catch (error) {
                    console.error(
                        "[project-chat/stream] failed to move chat leaf",
                        error,
                    );
                }
            }
        }
    }

    if (args.askInputsResponse || lastUser) {
        // Fail open: the lease is only a checkpoint marker, and
        // beginMemoryConversationTurn now returns null instead of throwing
        // when the RPC fails, so this turn simply is not a checkpoint.
        memoryTurn = await beginMemoryConversationTurn({
            db,
            surface: "chat",
            conversationId: chatId,
            actorUserId: userId,
        });
    }

    // From here on a throw (document context, workflow store) would strand
    // the conversation turn opened above: the route's finally block only runs
    // once this function has returned it. Release on the way out instead.
    try {
        const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
            projectId,
            userId,
            db,
            messages,
        );
        const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
            doc_id,
            filename: info.filename,
            folder_path: folderPaths.get(doc_id),
        }));
        const documentsById = new Map(
            Object.entries(docIndex).map(([slug, document]) => [
                document.document_id,
                { slug, filename: document.filename },
            ] as const),
        );
        // Generate the nonce before adding request metadata or prior events so
        // every document filename is fenced wherever it enters the prompt.
        const nonce = generateSpotlightNonce(chatId);
        const documentPromptRef = (
            documentId: string,
            requestFilename: string,
        ) => {
            const document = documentsById.get(documentId);
            return {
                slug: document?.slug,
                filename: spotlightFilename(
                    document?.filename ?? requestFilename,
                    nonce,
                ),
            };
        };

        const timeZone = resolveRequestTimeZone(args.requestedTimeZone);
        const enrichedMessages = await enrichWithPriorEvents(
            messages,
            chatId,
            db,
            docIndex,
            nonce,
            "chat_messages",
            timeZone,
        );
        const messagesForLLM: ChatMessage[] = displayed_doc
            ? enrichedMessages.map((m, i) => {
                  if (i !== enrichedMessages.length - 1 || m.role !== "user")
                      return m;
                  const displayedDocument = documentPromptRef(
                      displayed_doc.document_id,
                      displayed_doc.filename,
                  );
                  return {
                      ...m,
                      content: `${m.content}\n\ndisplayed_doc: ${displayedDocument.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
                  };
              })
            : enrichedMessages;

        // The user-attached docs for this turn (dragged into / picked from
        // the chat input) come in as a request-level field. Surface them in
        // the system prompt with the current-turn doc_id slugs so the model
        // knows which docs the user is highlighting *now*, distinct from
        // the broader project doc list.
        let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
        if (attached_documents?.length) {
            const lines = attached_documents.map((d) => {
                const document = documentPromptRef(d.document_id, d.filename);
                return document.slug
                    ? `- ${document.slug}: ${document.filename}`
                    : `- ${document.filename}`;
            });
            systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
        }

        const {
            api_keys: apiKeys,
            legal_research_us: legalResearchUs,
            title_model: titleModel,
            personalisation,
        } = modelSettings;
        const personalisationPrompt = buildUserPersonalisationPrompt(
            personalisation,
            nonce,
        );
        if (personalisationPrompt) {
            systemPromptExtra += `\n\n${personalisationPrompt}`;
        }
        const userSentAt = await loadUserMessageSentTimes(
            db,
            "chat_messages",
            chatId,
            messagesForLLM,
            !!args.askInputsResponse,
        );
        const apiMessages = buildMessages(
            messagesForLLM,
            docAvailability,
            systemPromptExtra,
            undefined,
            legalResearchUs,
            nonce,
            "append",
            { timeZone, now: new Date(), userSentAt },
        );

        const workflowStore = await buildWorkflowStore(userId, userEmail, db);

        return {
            ok: true,
            prepared: {
                chatId,
                chatTitle,
                lastUser,
                turnUserMessageId,
                turnParentMessageId,
                completedTurnPersisted,
                approvalEvents,
                autoMode: args.autoMode === true,
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
            },
        };
    } catch (error) {
        if (memoryTurn) {
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
        throw error;
    }
}

const RESTART_FAILURE_MESSAGE =
    "This answer was interrupted by a server restart and could not be resumed. Please try again.";

function isProjectResumeContext(value: unknown): value is ProjectChatTurnResumeContext {
    if (!value || typeof value !== "object") return false;
    const context = value as Record<string, unknown>;
    return (
        context.surface === "project-chat" &&
        typeof context.userId === "string" &&
        typeof context.projectId === "string" &&
        typeof context.chatId === "string" &&
        typeof context.turnUserMessageId === "string"
    );
}

/**
 * Drive again a project chat turn a previous process left in flight. It is
 * prepared from storage as its request would be (project access checked
 * again, documents reloaded), then driven into a server-owned run a reloading
 * client attaches to. A turn that can no longer be driven is stopped and an
 * answer row saying so is stored under its prompt.
 */
export async function resumeInterruptedProjectChatTurn(
    db: Db,
    turn: { assistantMessageId: string; context: unknown },
): Promise<void> {
    const context = turn.context;
    if (!isProjectResumeContext(context)) {
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        return;
    }
    try {
        const resumed = await resumeProjectChatTurn(db, turn.assistantMessageId, context);
        if (!resumed) {
            await abandonTurn(turn.assistantMessageId).catch(() => undefined);
            await failInterruptedProjectTurn(db, turn.assistantMessageId, context);
        }
    } catch (error) {
        console.error("[project-chat/resume] failed to resume a turn", safeError(error));
        await abandonTurn(turn.assistantMessageId).catch(() => undefined);
        await failInterruptedProjectTurn(db, turn.assistantMessageId, context);
    }
}

async function resumeProjectChatTurn(
    db: Db,
    assistantMessageId: string,
    context: ProjectChatTurnResumeContext,
): Promise<boolean> {
    // Stored before the process died: nothing left to drive.
    if (await answerRowExists(db, assistantMessageId)) {
        await abandonTurn(assistantMessageId);
        return true;
    }
    const path = await walkActivePath(db, context.chatId, context.turnUserMessageId);
    const prompt = path.at(-1);
    // The prompt must still be the stored row the turn answers; prepare would
    // otherwise insert a new one.
    if (!prompt || prompt.id !== context.turnUserMessageId) return false;
    if (!(await linkedPrompt(db, context.chatId, prompt.id, prompt.content))) return false;

    const prep = await prepareProjectChatStream(db, {
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        projectId: context.projectId,
        messages: transcriptFromRows(path),
        chatId: context.chatId,
        inputMessageId: randomUUID(),
        linkOnlyToMessageId: context.turnUserMessageId,
        displayed_doc: context.displayedDoc ?? undefined,
        attached_documents: context.attachedDocuments ?? undefined,
        askInputsResponse: null,
        autoMode: context.autoMode,
        requestedModel: context.model ?? undefined,
        requestedReasoning: (context.reasoning ?? undefined) as Parameters<
            typeof prepareProjectChatStream
        >[1]["requestedReasoning"],
        requestedTimeZone: context.timeZone ?? undefined,
        turnId: assistantMessageId,
    });
    if (!prep.ok) return false;
    if (prep.prepared.turnUserMessageId !== context.turnUserMessageId) {
        await prep.prepared.turnClaim?.release();
        return false;
    }

    const outcome = await driveProjectChatTurn(db, {
        prepared: prep.prepared,
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        projectId: context.projectId,
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

async function answerRowExists(db: Db, id: string): Promise<boolean> {
    const { data, error } = await db
        .from("chat_messages")
        .select("id")
        .eq("id", id)
        .maybeSingle();
    if (error) throw error;
    return !!data;
}

/** Store the failure as the turn's answer, so a reload shows why it ended. */
async function failInterruptedProjectTurn(
    db: Db,
    assistantMessageId: string,
    context: ProjectChatTurnResumeContext,
): Promise<void> {
    try {
        if (await answerRowExists(db, assistantMessageId)) return;
        const saved = await insertAssistantMessage(db, {
            chatId: context.chatId,
            assistantMessageId,
            events: [{ type: "error", message: RESTART_FAILURE_MESSAGE }],
            citations: [],
            authorUserId: context.userId,
            inputMessageId: context.turnUserMessageId,
        });
        if (!saved.ok) throw saved.error;
    } catch (error) {
        console.error("[project-chat/resume] failed to store the interruption", safeError(error));
    }
}
