import type { Db } from "../../lib/db";
import { subagentTranscript, type SubagentTranscript } from "../../lib/llm";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getAccessibleChat } from "./chat.access";

/**
 * A subagent's transcript, for anyone who may read the chat whose turn
 * started it. The child never becomes a thread of its own; this is the only
 * way to see its work. A child of another chat is "not found", like a chat
 * the caller cannot see.
 */
export async function getChatSubagentTranscript(
    db: Db,
    args: { chatId: string; childId: string; userId: string; userEmail: string | null | undefined },
): Promise<ServiceResult<SubagentTranscript>> {
    const access = await getAccessibleChat(db, args);
    if (!access.ok) return failure("not_found", "Chat not found");
    let transcript: SubagentTranscript | null;
    try {
        transcript = await subagentTranscript(args.childId);
    } catch (error) {
        return internalFailure(error);
    }
    if (!transcript || transcript.chatKey !== args.chatId) {
        return failure("not_found", "Subagent not found");
    }
    return ok(transcript);
}
