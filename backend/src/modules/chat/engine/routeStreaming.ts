import type { Db } from "../../../lib/supabase";
import { setLeaf } from "../chat.tree";

type AssistantMessageTable = "chat_messages" | "word_chat_messages";

export async function reserveAssistantMessage(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
  inputMessageId: string;
  /**
   * Tree parent for the reservation. Defaults to the user input message that
   * opened the turn; branch flows that know a different parent pass it.
   */
  parentMessageId?: string;
  authorUserId: string;
}): Promise<unknown | null> {
  const row: Record<string, unknown> = {
    id: args.id,
    chat_id: args.chatId,
    role: "assistant",
    content: null,
    citations: null,
    author_user_id: args.authorUserId,
    memory_input_message_id: args.inputMessageId,
  };
  // Only chat_messages carries the message-tree column; word chat transcripts
  // are linear and have no parent_message_id column at all.
  const isChatMessages = args.table === "chat_messages";
  if (isChatMessages) {
    row.parent_message_id = args.parentMessageId ?? args.inputMessageId;
  }
  const { error } = await args.db.from(args.table).insert(row);
  if (error) return error;

  // Advance the caller's leaf onto the answer they just asked for, so a
  // reload (or another tab) resolves to it — an empty reservation is dropped
  // from the rendered transcript while the turn runs. Bookkeeping only: the
  // reservation above is durable, so a failed leaf move must not fail the
  // turn; the leaf then stays on the user row (degraded, still visible).
  if (isChatMessages) {
    try {
      await setLeaf(args.db, args.chatId, args.authorUserId, args.id);
    } catch (leafError) {
      console.error("[chat/stream] failed to move chat leaf", leafError);
    }
  }
  return null;
}

export function createReservedAssistantMessageUpdater(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
  enabled?: boolean;
}): (content: unknown, citations: unknown) => Promise<unknown | null> {
  return async (content, citations) => {
    if (args.enabled === false) return null;
    let lastError: unknown | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await args.db
        .from(args.table)
        .update({ content, citations })
        .eq("id", args.id)
        .eq("chat_id", args.chatId);
      lastError = result.error;
      if (!lastError) return null;
    }
    return lastError;
  };
}

export function withoutEmptyAssistantReservations<
  T extends { role?: unknown; content?: unknown },
>(messages: T[]): T[] {
  return messages.filter(
    (message) => !(message.role === "assistant" && message.content == null),
  );
}
