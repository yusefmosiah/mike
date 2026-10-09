// Business logic + data-access for the word-chat module, and its facade.
//
// Service layer behind wordChat.routes.ts. Every function takes an explicit
// database client (`db`) plus request-derived primitives, performs the DB work,
// and RETURNS typed results. Nothing here imports express or touches req/res —
// the thin route handlers map these results onto status codes and JSON.
//
// POST /word-chat's pre-stream preparation and post-stream activity write are
// wordChat.prepare.ts; its generation half (the run, runLLMStream, the
// client-tool adapter, storing the answer, resuming after a restart) is
// wordChat.turn.ts.

import type { Db } from "../../lib/db";
import {
  withoutEmptyAssistantReservations,
  type WordEditApplyMode,
} from "../chat/chat.service";
import {
  getUserModelSettings,
  persistLastSelectedChatModel,
  persistLastSelectedReasoningLevel,
} from "../user/user.service";
import {
  resolveEffectiveChatModel,
  resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";
import {
  getAccessibleWordChat,
  getAccessibleWordMessage,
  getWordDocumentRowId,
} from "./wordChat.shared";

export {
  prepareWordChatStream,
  recordWordChatActivity,
  type PreparedWordChatStream,
} from "./wordChat.prepare";
export {
  driveWordChatTurn,
  resumeInterruptedWordChatTurn,
  type WordChatTurnResumeContext,
} from "./wordChat.turn";

/** The canonical payload of a proposed Word edit, as parsed by the route. */
export type ProposedWordEdit = {
  original_text: string;
  replacement_text: string;
  formats: string[];
  occurrence: "all" | null;
  reason: string | null;
  apply_mode: WordEditApplyMode;
};

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

// GET /word-chat
export async function listWordChats(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    limit: number;
    offset: number;
  },
): Promise<
  { ok: true; chats: Record<string, unknown>[] } | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to load document chats",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  const wordDocumentRowId = documentLookup.value;
  // No stored document row yet means this pane has never persisted a chat.
  if (!wordDocumentRowId) return { ok: true, chats: [] };

  let query = db
    .from("word_chats")
    .select(
      "id, user_id, title, model, reasoning_level, created_at, updated_at",
    )
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", args.userId)
    .order("updated_at", { ascending: false });
  query =
    args.offset > 0
      ? query.range(args.offset, args.offset + args.limit - 1)
      : query.limit(args.limit);
  const { data, error } = await query;
  if (error) {
    console.error("[word-chat] failed to list chats", error);
    return { ok: false, kind: "error" };
  }
  return {
    ok: true,
    chats: (data ?? []).map((chat) => ({ ...chat, project_id: null })),
  };
}

// GET /word-chat/:chatId
export async function getWordChatWithMessages(
  db: Db,
  args: { userId: string; clientDocumentId: string; chatId: string },
): Promise<
  | {
      ok: true;
      chat: Record<string, unknown>;
      messages: Record<string, unknown>[];
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve chat document",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  const wordDocumentRowId = documentLookup.value;
  if (!wordDocumentRowId) return { ok: false, kind: "not_found" };
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    wordDocumentRowId,
    args.userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error("[word-chat] failed to load chat", chatLookup.detail);
    return { ok: false, kind: "error" };
  }
  const chat = chatLookup.value;
  if (!chat) return { ok: false, kind: "not_found" };

  const { data: messages, error } = await db
    .from("word_chat_messages")
    .select("*")
    .eq("chat_id", args.chatId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[word-chat] failed to load messages", error);
    return { ok: false, kind: "error" };
  }
  const visibleMessages = withoutEmptyAssistantReservations(messages ?? []);
  const assistantMessageIds = visibleMessages.flatMap((message) =>
    message.role === "assistant" && typeof message.id === "string"
      ? [message.id]
      : [],
  );
  const editsByMessage = new Map<string, Record<string, unknown>[]>();
  if (assistantMessageIds.length > 0) {
    const { data: edits, error: editsError } = await db
      .from("word_document_edits")
      .select("*")
      .in("word_chat_message_id", assistantMessageIds)
      .order("block_index", { ascending: true });
    if (editsError) {
      console.error("[word-chat] failed to load document edits", editsError);
      return { ok: false, kind: "error" };
    }
    for (const edit of (edits ?? []) as Record<string, unknown>[]) {
      const messageId = edit.word_chat_message_id;
      if (typeof messageId !== "string") continue;
      const current = editsByMessage.get(messageId) ?? [];
      current.push(edit);
      editsByMessage.set(messageId, current);
    }
  }
  return {
    ok: true,
    chat,
    messages: visibleMessages.map((message) => ({
      ...message,
      ...(typeof message.id === "string" && editsByMessage.has(message.id)
        ? { edits: editsByMessage.get(message.id) }
        : {}),
    })),
  };
}

// PATCH /word-chat/:chatId/model — selection-time persistence for an existing
// cloud Word chat.
export async function updateWordChatModel(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    chatId: string;
    requestedModel: string;
  },
): Promise<
  | { ok: true; model: string }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
  | { ok: false; kind: "model"; status: number; code: string; detail: string }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve model-selection document",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!documentLookup.value) return { ok: false, kind: "not_found" };
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    documentLookup.value,
    args.userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error(
      "[word-chat] failed to load model-selection chat",
      chatLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!chatLookup.value) return { ok: false, kind: "not_found" };

  const settings = await getUserModelSettings(args.userId, db);
  const resolution = await resolveEffectiveChatModel({
    requested: args.requestedModel,
    chatModel: chatLookup.value.model as string | null,
    lastSelectedModel: settings.last_selected_chat_model,
    apiKeys: settings.api_keys,
    userId: args.userId,
    db,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      kind: "model",
      status: resolution.status,
      code: resolution.code,
      detail: resolution.detail,
    };
  }

  const { error } = await db
    .from("word_chats")
    .update({
      model: resolution.model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) {
    console.error("[word-chat] failed to save selected chat model", error);
    return { ok: false, kind: "error" };
  }
  const profileError = await persistLastSelectedChatModel(
    args.userId,
    resolution.model,
    db,
  );
  if (profileError) {
    console.error(
      "[word-chat] failed to save last-selected model",
      profileError,
    );
    return { ok: false, kind: "error" };
  }
  return { ok: true, model: resolution.model };
}

// PATCH /word-chat/:chatId/reasoning
export async function updateWordChatReasoning(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    chatId: string;
    reasoningLevel: ReturnType<typeof resolveEffectiveReasoningLevel>;
  },
): Promise<
  { ok: true } | { ok: false; kind: "not_found" } | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok || !documentLookup.value) {
    return { ok: false, kind: "not_found" };
  }
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    documentLookup.value,
    args.userId,
    db,
  );
  if (!chatLookup.ok || !chatLookup.value) {
    return { ok: false, kind: "not_found" };
  }
  const { error } = await db
    .from("word_chats")
    .update({
      reasoning_level: args.reasoningLevel,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) return { ok: false, kind: "error" };
  const profileError = await persistLastSelectedReasoningLevel(
    args.userId,
    args.reasoningLevel,
    db,
  );
  if (profileError) return { ok: false, kind: "error" };
  return { ok: true };
}

// PUT /word-chat/messages/:messageId/edits/:blockIndex
//
// Idempotently creates the canonical edit row as soon as a streamed edit block
// seals. The final assistant-message save later replaces the raw tags with a
// lightweight reference to the same row.
export async function saveProposedWordEdit(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    messageId: string;
    blockIndex: number;
    edit: ProposedWordEdit;
  },
): Promise<
  | { ok: true; edit: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
> {
  const messageLookup = await getAccessibleWordMessage({
    messageId: args.messageId,
    clientDocumentId: args.clientDocumentId,
    userId: args.userId,
    db,
  });
  if (!messageLookup.ok) {
    console.error(
      "[word-chat] failed to validate edit message",
      messageLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!messageLookup.value) return { ok: false, kind: "not_found" };
  const { error: insertError } = await db
    .from("word_document_edits")
    .upsert(
      {
        word_chat_message_id: args.messageId,
        block_index: args.blockIndex,
        ...args.edit,
      },
      {
        onConflict: "word_chat_message_id,block_index",
        ignoreDuplicates: true,
      },
    )
    .select("id");
  if (insertError) {
    console.error("[word-chat] failed to save edit", insertError);
    return { ok: false, kind: "error" };
  }
  // The first sealed payload is canonical. A retry returns that row without
  // rewriting its text, apply mode, or any lifecycle state already recorded.
  const { data, error } = await db
    .from("word_document_edits")
    .select("*")
    .eq("word_chat_message_id", args.messageId)
    .eq("block_index", args.blockIndex)
    .maybeSingle();
  if (error || !data) {
    console.error("[word-chat] failed to load edit", error);
    return { ok: false, kind: "error" };
  }
  return { ok: true, edit: data as Record<string, unknown> };
}

// PATCH /word-chat/messages/:messageId/edits/:blockIndex
//
// Stores durable apply and accept/reject outcomes without rewriting the
// assistant message JSON. The patch itself is validated by the route.
export async function updateWordEditOutcome(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    messageId: string;
    blockIndex: number;
    patch: Record<string, unknown>;
  },
): Promise<
  | { ok: true; edit: Record<string, unknown> }
  | { ok: false; kind: "message_not_found" }
  | { ok: false; kind: "edit_not_found" }
  | { ok: false; kind: "error" }
> {
  const messageLookup = await getAccessibleWordMessage({
    messageId: args.messageId,
    clientDocumentId: args.clientDocumentId,
    userId: args.userId,
    db,
  });
  if (!messageLookup.ok) return { ok: false, kind: "error" };
  if (!messageLookup.value) return { ok: false, kind: "message_not_found" };
  const { data, error } = await db
    .from("word_document_edits")
    .update(args.patch)
    .eq("word_chat_message_id", args.messageId)
    .eq("block_index", args.blockIndex)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("[word-chat] failed to update edit", error);
    return { ok: false, kind: "error" };
  }
  if (!data) return { ok: false, kind: "edit_not_found" };
  return { ok: true, edit: data as Record<string, unknown> };
}
