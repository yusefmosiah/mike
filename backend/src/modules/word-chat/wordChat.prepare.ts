// The non-streaming halves of POST /word-chat: preparing a turn before its
// first SSE byte, and recording chat activity once it ends.
import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/db";
import { resolveRequestTimeZone } from "../../lib/userTime";
import {
  beginMemoryConversationTurn,
  releaseMemoryConversationTurn,
  type MemoryConversationTurn,
} from "../../lib/memory/schedule";
import {
  ACTIVE_WORD_DOCUMENT_ID,
  buildDocContext,
  buildMessages,
  buildUserPersonalisationPrompt,
  buildWordChatSystemPrompt,
  buildWorkflowStore,
  enrichWithPriorEvents,
  loadUserMessageSentTimes,
  generateSpotlightNonce,
  type ChatMessage,
} from "../chat/chat.service";
import {
  getUserModelSettings,
  resolveUserChatSelection,
} from "../user/user.service";
import type { resolveEffectiveReasoningLevel } from "../../lib/modelSelection";
import { ensureWordDocumentRow, getAccessibleWordChat } from "./wordChat.shared";

// ---------------------------------------------------------------------------
// Pre-stream preparation for POST /word-chat (streaming)
// ---------------------------------------------------------------------------
//
// The DB work that precedes the SSE stream: resolving or creating the Word
// document row and its chat, persisting the user message, building doc context
// + messages, and assembling the workflow store. It RETURNS the prepared data;
// driveWordChatTurn (wordChat.turn.ts) owns the assistant-message reservation,
// the run, the runLLMStream loop, and the persistence that follows it.

export type PreparedWordChatStream = {
  chatId: string;
  chatTitle: string | null;
  lastUserContent: string | null | undefined;
  /** Row id of the persisted user message; null for local-only chats. */
  inputMessageId: string | null;
  /** The row before the user message (the previous answer), or null for a
   *  chat's first message or a local-only chat. */
  turnParentMessageId: string | null;
  /** Curator reservation taken for this turn; null when nothing was persisted. */
  memoryTurn: MemoryConversationTurn | null;
  docIndex: Awaited<ReturnType<typeof buildDocContext>>["docIndex"];
  docStore: Awaited<ReturnType<typeof buildDocContext>>["docStore"];
  apiMessages: ReturnType<typeof buildMessages>;
  workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
  apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
  selectedModel: string;
  selectedReasoningLevel: ReturnType<typeof resolveEffectiveReasoningLevel>;
  nonce: ReturnType<typeof generateSpotlightNonce>;
};

export async function prepareWordChatStream(
  db: Db,
  args: {
    userId: string;
    userEmail: string | undefined;
    messages: ChatMessage[];
    chatId: string | null;
    clientDocumentId: string;
    activeDocumentName: string;
    // Trimmed `document_context` from the task pane: the live document as
    // structure-annotated markdown, or undefined when the pane sent none.
    documentContext: string | undefined;
    // `storage: "cloud"` — a local-only chat performs no persistence at all.
    persistChat: boolean;
    // Capability flag from the task pane. Only a pane that declares it can
    // answer client_tool_call frames; older panes keep the streamed <EDITS>
    // protocol so they are never handed tool calls they would ignore.
    clientToolsEnabled: boolean;
    requestedModel: string | null | undefined;
    requestedReasoning:
      ReturnType<typeof resolveEffectiveReasoningLevel> | undefined;
    /** The task pane's IANA time zone; unvalidated request input. */
    requestedTimeZone?: unknown;
    /**
     * Driving again a turn a restart cut off: its prompt is this stored row,
     * so nothing is inserted. Cloud chats only.
     */
    resumeUserMessageId?: string;
  },
): Promise<
  | { ok: true; prepared: PreparedWordChatStream }
  | { ok: false; status: number; code?: string; detail: string; error?: unknown }
> {
  const {
    userId,
    userEmail,
    messages,
    clientDocumentId,
    activeDocumentName,
    persistChat,
  } = args;
  let chatId = args.chatId;
  let chatTitle: string | null = null;
  let chatModel: string | null = null;
  let chatReasoningLevel: string | null = null;
  let wordDocumentRowId: string | null = null;

  if (persistChat) {
    wordDocumentRowId = await ensureWordDocumentRow(
      clientDocumentId,
      userId,
      db,
    );
    if (!wordDocumentRowId) {
      return {
        ok: false,
        status: 500,
        detail: "Failed to initialize Word chat storage",
      };
    }
  }

  if (chatId && persistChat) {
    const existingLookup = await getAccessibleWordChat(
      chatId,
      wordDocumentRowId as string,
      userId,
      db,
    );
    if (!existingLookup.ok) {
      console.error("[word-chat] failed to resume chat", existingLookup.detail);
      return { ok: false, status: 500, detail: "Failed to resume Word chat" };
    }
    const existing = existingLookup.value;
    if (!existing) {
      return { ok: false, status: 404, detail: "Chat not found" };
    }
    chatTitle = typeof existing.title === "string" ? existing.title : null;
    chatModel = typeof existing.model === "string" ? existing.model : null;
    chatReasoningLevel =
      typeof existing.reasoning_level === "string"
        ? existing.reasoning_level
        : null;
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
    persistChat &&
    (chatModel !== selectedModel ||
      chatReasoningLevel !== selectedReasoningLevel)
  ) {
    const { error } = await db
      .from("word_chats")
      .update({
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .eq("id", chatId)
      .eq("user_id", userId);
    if (error) {
      return { ok: false, status: 500, detail: "Failed to save chat model" };
    }
  }

  if (!chatId && persistChat) {
    const { data, error } = await db
      .from("word_chats")
      .insert({
        user_id: userId,
        word_document_id: wordDocumentRowId,
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .select("id, title")
      .single();
    if (error || !data) {
      console.error("[word-chat] failed to create chat", error);
      return { ok: false, status: 500, detail: "Failed to create Word chat" };
    }
    chatId = data.id as string;
    chatTitle = (data.title as string | null) ?? null;
  }
  if (!chatId) chatId = randomUUID();

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const resuming = persistChat && !!args.resumeUserMessageId;
  const inputMessageId = resuming
    ? (args.resumeUserMessageId as string)
    : persistChat
      ? randomUUID()
      : null;
  let turnParentMessageId: string | null = null;
  if (persistChat) {
    const previous = await previousWordChatMessageId(
      db,
      chatId,
      resuming ? inputMessageId : null,
    );
    if (!previous.ok) {
      return { ok: false, status: 500, detail: "Failed to load Word chat" };
    }
    turnParentMessageId = previous.id;
  }
  let memoryTurn: MemoryConversationTurn | null = null;
  if (lastUser && persistChat && !resuming) {
    // Persist only the user's actual message. The Word edit contract is added
    // later as a system prompt and therefore cannot leak into chat history.
    const { error } = await db.from("word_chat_messages").insert({
      id: inputMessageId,
      chat_id: chatId,
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
      author_user_id: userId,
    });
    if (error) {
      return { ok: false, status: 500, detail: "Failed to save Word message" };
    }
  }

  if (lastUser && persistChat) {
    // Reserve the memory curator's turn before any model call so a crash
    // mid-stream still releases it (the route's finally block does that).
    // Fail open: the lease is only a checkpoint marker, and
    // beginMemoryConversationTurn now returns null instead of throwing when
    // the RPC fails, so a lease failure skips this turn's checkpoint rather
    // than 500ing a request whose user message is already persisted.
    memoryTurn = await beginMemoryConversationTurn({
      db,
      surface: "word",
      conversationId: chatId,
      actorUserId: userId,
    });
  }

  // From here on a throw (document context, workflow store) would strand the
  // reservation taken above: the route's finally block only runs once this
  // function has returned it. Release on the way out instead.
  try {
    const { docIndex, docStore } = await buildDocContext(
      messages,
      userId,
      db,
      persistChat ? chatId : null,
      "word_chat_messages",
      userEmail,
    );
    const activeDocumentText = args.documentContext;
    if (activeDocumentText !== undefined) {
      docStore.set(ACTIVE_WORD_DOCUMENT_ID, {
        // This is an in-memory identity, never a storage path.
        storage_path: `inline:word-document:${clientDocumentId}`,
        file_type: "text/markdown",
        filename: activeDocumentName,
        inline_text: activeDocumentText,
      });
    }
    const docAvailability = [
      ...(activeDocumentText !== undefined
        ? [
            {
              doc_id: ACTIVE_WORD_DOCUMENT_ID,
              filename: activeDocumentName,
            },
          ]
        : []),
      ...Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
      })),
    ];
    const nonce = generateSpotlightNonce(persistChat ? chatId : null);
    const timeZone = resolveRequestTimeZone(args.requestedTimeZone);
    const enrichedMessages = await enrichWithPriorEvents(
      messages,
      persistChat ? chatId : null,
      db,
      docIndex,
      nonce,
      "word_chat_messages",
      timeZone,
    );
    const { api_keys: configuredApiKeys, personalisation } = modelSettings;
    const apiKeys = { ...configuredApiKeys };
    delete apiKeys.courtlistener;
    const personalisationPrompt = buildUserPersonalisationPrompt(
      personalisation,
      nonce,
    );
    const wordSystemPrompt = [
      buildWordChatSystemPrompt(args.clientToolsEnabled),
      personalisationPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    // A local-only chat stores no messages, so only its newest message is
    // stamped (with the current time).
    const userSentAt = await loadUserMessageSentTimes(
      db,
      "word_chat_messages",
      persistChat ? chatId : null,
      enrichedMessages,
    );
    const apiMessages = buildMessages(
      enrichedMessages,
      docAvailability,
      wordSystemPrompt,
      docIndex,
      false,
      nonce,
      "replace",
      { timeZone, now: new Date(), userSentAt },
    );
    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    return {
      ok: true,
      prepared: {
        chatId,
        chatTitle,
        lastUserContent: lastUser?.content,
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
      },
    };
  } catch (error) {
    if (memoryTurn) {
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
    throw error;
  }
}

/**
 * The newest message stored in a Word chat, or the newest before `beforeId`
 * when that row is given: the answer a new prompt follows, which is the turn's
 * tree parent for the model runtime.
 */
async function previousWordChatMessageId(
  db: Db,
  chatId: string,
  beforeId: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  let before: string | null = null;
  if (beforeId) {
    const { data, error } = await db
      .from("word_chat_messages")
      .select("created_at")
      .eq("id", beforeId)
      .eq("chat_id", chatId)
      .maybeSingle();
    if (error || !data) return { ok: false };
    before = data.created_at as string;
  }
  let query = db.from("word_chat_messages").select("id").eq("chat_id", chatId);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, id: (data?.id as string | undefined) ?? null };
}

// Post-stream: bump the chat's activity timestamp and, on the first turn,
// title it from the user's prompt.
//
// Returns the title that was just persisted so the caller can mirror it into
// its local `chatTitle`, the way chat.ts does — without this the first turn of
// every Word chat would audit under a null title. Returns null when nothing was
// titled (local-only storage, an already-titled chat, or a failed write).
export async function recordWordChatActivity(
  db: Db,
  args: {
    persistChat: boolean;
    chatId: string;
    userId: string;
    chatTitle: string | null;
    lastUserContent: string | null | undefined;
  },
): Promise<string | null> {
  if (!args.persistChat) return null;
  const nextTitle =
    !args.chatTitle && args.lastUserContent
      ? args.lastUserContent.slice(0, 120)
      : null;
  const update = {
    ...(nextTitle ? { title: nextTitle } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db
    .from("word_chats")
    .update(update)
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) {
    console.error("[word-chat] failed to update chat activity", error);
    return null;
  }
  return nextTitle;
}
