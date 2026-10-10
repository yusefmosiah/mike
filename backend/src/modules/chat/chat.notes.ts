// A message, with any attached documents, added to a thread without asking
// the assistant for a reply: the composer's `/nr` (no response). It joins
// the thread like any prompt, with its author, and the next prompt that does
// ask for a reply sees it in the history. Back-to-back user messages reach
// the model merged into one turn (lib/llm/userTurns.ts), because some local
// chat templates refuse two user turns in a row.
import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/db";
import type { ChatMessage } from "./engine/index";
import { can } from "../../lib/permissions";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { currentTurnHolder } from "../../lib/turnClaims";
import { getAccessibleChat } from "./chat.access";
import { resolveLeaf, setLeaf } from "./chat.tree";

export const MAX_NOTE_CHARS = 100_000;

export async function postChatNote(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        userEmail: string | null | undefined;
        content: string;
        files?: ChatMessage["files"];
    },
): Promise<ServiceResult<{ id: string; parent_message_id: string | null }>> {
    const content = args.content.trim();
    if (!content) return failure("validation", "The message is empty.");
    if (content.length > MAX_NOTE_CHARS) return failure("validation", "The message is too long.");
    const access = await getAccessibleChat(db, args);
    if (!access.ok) return failure("not_found", "Chat not found");
    if (!can(access.projectRole, "content.edit"))
        return failure("forbidden", "You do not have permission to modify this chat");
    // While a response is being written its place in the thread is taken;
    // a message added now would sit before an answer that never saw it.
    if (await currentTurnHolder(db, "chat", args.chatId)) {
        return failure(
            "conflict",
            "A response is still being generated in this chat. Try again once it finishes.",
            "turn_in_progress",
        );
    }
    const parent = await resolveLeaf(db, args.chatId, args.userId);
    const id = randomUUID();
    const { error } = await db.from("chat_messages").insert({
        id,
        chat_id: args.chatId,
        role: "user",
        content,
        files: args.files?.length ? args.files : null,
        author_user_id: args.userId,
        parent_message_id: parent,
    });
    if (error) return internalFailure(error);
    try {
        await setLeaf(db, args.chatId, args.userId, id);
    } catch (leafError) {
        // The message is stored; the next send resolves the leaf again.
        console.error("[chat/note] failed to move chat leaf", leafError);
    }
    return ok({ id, parent_message_id: parent });
}
