// Who wrote what in a shared thread, and who is generating in it now
// (goals/mission-5-firm-thread-handoff.md). A chat read carries both, so a
// partner, an associate and a third reader see the same attribution and the
// same "generating" state whichever replica serves them.
import type { Db } from "../../lib/db";
import { currentTurnHolder } from "../../lib/turnClaims";

export type ThreadPerson = { name: string | null; email: string | null };

export type ThreadPresence = {
    /** Display details for each author on the transcript, by user id. */
    authors: Record<string, ThreadPerson>;
    /** The person whose turn is generating now, from the database claim. */
    generating: { user_id: string | null; since: string | null } | null;
};

/** Never fails the chat read: without it the transcript still renders, unattributed. */
export async function threadPresence(
    db: Db,
    chatId: string,
    messages: ReadonlyArray<Record<string, unknown>>,
): Promise<ThreadPresence> {
    try {
        return await readPresence(db, chatId, messages);
    } catch {
        return { authors: {}, generating: null };
    }
}

async function readPresence(
    db: Db,
    chatId: string,
    messages: ReadonlyArray<Record<string, unknown>>,
): Promise<ThreadPresence> {
    const holder = await currentTurnHolder(db, "chat", chatId);
    const ids = new Set<string>();
    for (const message of messages) {
        if (typeof message.author_user_id === "string") ids.add(message.author_user_id);
    }
    if (holder?.actorUserId) ids.add(holder.actorUserId);

    const authors: Record<string, ThreadPerson> = {};
    if (ids.size > 0) {
        const { data } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("user_id", [...ids]);
        for (const row of (Array.isArray(data) ? data : []) as Array<{ user_id: string; email: string | null; display_name: string | null }>) {
            authors[row.user_id] = { name: row.display_name?.trim() || null, email: row.email ?? null };
        }
    }
    return {
        authors,
        generating: holder ? { user_id: holder.actorUserId, since: holder.claimedAt } : null,
    };
}
