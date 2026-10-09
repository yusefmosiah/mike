// Lookups shared by the word-chat service's topic files: a caller's Word
// document row, and the chats and messages on it that the caller may reach.
// Not exported through the facade.
import type { Db } from "../../lib/db";

export type LookupResult<T> =
  { ok: true; value: T | null } | { ok: false; detail: string };

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function getWordDocumentRowId(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<string>> {
  const { data, error } = await db
    .from("word_documents")
    .select("id")
    .eq("user_id", userId)
    .eq("client_document_id", clientDocumentId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return { ok: true, value: data.id as string };
}

export async function ensureWordDocumentRow(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<string | null> {
  const { data, error } = await db
    .from("word_documents")
    .upsert(
      {
        user_id: userId,
        client_document_id: clientDocumentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,client_document_id" },
    )
    .select("id")
    .single();
  if (error || !data) {
    console.error("[word-chat] failed to resolve document", error);
    return null;
  }
  return data.id as string;
}

export async function getAccessibleWordChat(
  chatId: string,
  wordDocumentRowId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<Record<string, unknown>>> {
  const { data, error } = await db
    .from("word_chats")
    .select("*")
    .eq("id", chatId)
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return {
    ok: true,
    value: { ...(data as Record<string, unknown>), project_id: null },
  };
}

export async function getAccessibleWordMessage(args: {
  messageId: string;
  clientDocumentId: string;
  userId: string;
  db: Db;
}): Promise<LookupResult<Record<string, unknown>>> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    args.db,
  );
  if (!documentLookup.ok) return documentLookup;
  if (!documentLookup.value) return { ok: true, value: null };
  const { data: message, error } = await args.db
    .from("word_chat_messages")
    .select("id, chat_id, role")
    .eq("id", args.messageId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!message || message.role !== "assistant") {
    return { ok: true, value: null };
  }
  const chatLookup = await getAccessibleWordChat(
    message.chat_id as string,
    documentLookup.value,
    args.userId,
    args.db,
  );
  if (!chatLookup.ok || !chatLookup.value) return chatLookup;
  return { ok: true, value: message as Record<string, unknown> };
}
