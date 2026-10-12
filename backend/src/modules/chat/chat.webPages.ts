import type { Db } from "../../lib/db";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getAccessibleChat } from "./chat.access";

/** A saved copy of a page a web citation in the chat cites. */
export type ChatWebPage = {
    id: string;
    url: string;
    /** The plain text the citation's quotes were checked against. */
    text: string;
    /** The page's main content as Markdown, when it could be extracted. */
    markdown: string | null;
    retrieved_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function citesSnapshot(citations: unknown, snapshotId: string): boolean {
    return (
        Array.isArray(citations) &&
        citations.some(
            (citation) =>
                !!citation &&
                typeof citation === "object" &&
                (citation as Record<string, unknown>).kind === "web" &&
                (citation as Record<string, unknown>).snapshot_id === snapshotId,
        )
    );
}

/**
 * A saved web page, for anyone who may read the chat, and only when one of
 * the chat's messages cites it: a snapshot id from another chat is "not
 * found", like a chat the caller cannot see.
 */
export async function getChatWebPage(
    db: Db,
    args: { chatId: string; snapshotId: string; userId: string; userEmail: string | null | undefined },
): Promise<ServiceResult<ChatWebPage>> {
    const access = await getAccessibleChat(db, args);
    if (!access.ok) return failure("not_found", "Chat not found");
    if (!UUID.test(args.snapshotId)) return failure("not_found", "Page not found");

    const { data: messages, error: messagesError } = await db
        .from("chat_messages")
        .select("citations")
        .eq("chat_id", args.chatId)
        .eq("role", "assistant");
    if (messagesError) return internalFailure(messagesError);
    const cited = ((messages ?? []) as { citations: unknown }[]).some((message) =>
        citesSnapshot(message.citations, args.snapshotId),
    );
    if (!cited) return failure("not_found", "Page not found");

    const { data: snapshot, error } = await db
        .from("citation_snapshots")
        .select("id, url, content, reader_markdown, retrieved_at")
        .eq("id", args.snapshotId)
        .eq("source_kind", "web")
        .maybeSingle();
    if (error) return internalFailure(error);
    if (!snapshot) return failure("not_found", "Page not found");
    const row = snapshot as {
        id: string;
        url: string | null;
        content: string;
        reader_markdown: string | null;
        retrieved_at: string | Date;
    };
    return ok({
        id: row.id,
        url: row.url ?? "",
        text: row.content,
        markdown: row.reader_markdown,
        retrieved_at: new Date(row.retrieved_at).toISOString(),
    });
}
