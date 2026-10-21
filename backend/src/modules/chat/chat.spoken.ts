// chat spoken answers — what a person heard of an answer read aloud.
//
// In hands-free voice chat (docs/voice-chat.md, "The conversation layer") the
// person can interrupt an answer by speaking while it is read out. Each
// assistant message then keeps two things: its full text (`content`, the
// record and what the screen shows, never changed here) and the spoken prefix
// (`spoken_text`) with `interrupted_at`. The next turn's model history
// replays the interrupted answer as its spoken prefix and a marker, so the
// model knows what the person actually heard.
import { type Db } from "../../lib/db";
import { can } from "../../lib/permissions";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { getAccessibleChat } from "./chat.access";
import { isMessageId } from "./chat.branches";
import { walkActivePath } from "./chat.tree";
import type { ChatMessage } from "./engine/index";

/** The longest spoken prefix accepted: far beyond any answer read aloud. */
export const MAX_SPOKEN_TEXT_CHARS = 20_000;

/** Follows the spoken prefix in the model's history. */
export const INTERRUPTED_MARKER =
    "[The person interrupted here; they did not hear the rest.]";

/** What the model sees in place of an interrupted answer. */
export function heardAnswerText(spokenText: string): string {
    const heard = spokenText.trim();
    return heard ? `${heard}\n\n${INTERRUPTED_MARKER}` : INTERRUPTED_MARKER;
}

/** Validate a `{ spokenText }` body. An empty string is valid: nothing was heard. */
export function parseSpokenText(
    body: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
    const value =
        body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>).spokenText
            : undefined;
    if (typeof value !== "string")
        return { ok: false, detail: "spokenText must be a string" };
    if (value.length > MAX_SPOKEN_TEXT_CHARS)
        return {
            ok: false,
            detail: `spokenText must be at most ${MAX_SPOKEN_TEXT_CHARS} characters`,
        };
    return { ok: true, value };
}

/**
 * Record that an assistant answer was interrupted and what the person heard.
 * The standing is the one stopping that turn needs: the thread's creator or a
 * project editor, and the person who generated the answer. A chat or message
 * the caller cannot see, or a message that is not an assistant answer in that
 * chat, is not found.
 */
export async function recordSpokenAnswer(
    db: Db,
    args: {
        chatId: string;
        messageId: string;
        userId: string;
        userEmail: string | null | undefined;
        spokenText: string;
    },
): Promise<ServiceResult<null>> {
    const access = await getAccessibleChat(db, {
        chatId: args.chatId,
        userId: args.userId,
        userEmail: args.userEmail,
    });
    if (!access.ok) return failure("not_found", "Chat not found");
    if (!access.isCreator && !can(access.projectRole, "content.edit")) {
        return failure(
            "forbidden",
            "Only the chat's creator or a project editor can record what was heard.",
            "chat_write_forbidden",
        );
    }
    if (!isMessageId(args.messageId))
        return failure("not_found", "Message not found");
    const { data, error } = await db
        .from("chat_messages")
        .select("id, role, author_user_id")
        .eq("id", args.messageId)
        .eq("chat_id", args.chatId)
        .maybeSingle();
    if (error) return internalFailure(error);
    const row = data as
        | { id: string; role: string; author_user_id: string | null }
        | null;
    if (!row || row.role !== "assistant")
        return failure("not_found", "Message not found");
    // As with stopping a turn, only the person it was generated for: in a
    // shared thread a colleague's answer was not read aloud to the caller.
    if (row.author_user_id !== args.userId) {
        return failure(
            "forbidden",
            "Only the person this answer was generated for can record what was heard.",
            "turn_not_yours",
        );
    }
    const { error: updateError } = await db
        .from("chat_messages")
        .update({
            spoken_text: args.spokenText,
            interrupted_at: new Date().toISOString(),
        })
        .eq("id", args.messageId)
        .eq("chat_id", args.chatId);
    if (updateError) return internalFailure(updateError);
    return ok(null);
}

type InterruptedRow = { id: string; spoken_text: string | null };

/** A stored answer's prose: its content events' text, as a client shows it. */
export function answerProse(content: unknown): string {
    return Array.isArray(content)
        ? (content as Array<{ type?: unknown; text?: unknown }>)
              .filter((event) => event?.type === "content" && typeof event.text === "string")
              .map((event) => event.text as string)
              .join("")
        : "";
}

const comparable = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Replay interrupted answers in the history a turn sends the model.
 *
 * `parentHeard` is set when the turn's tree parent is an interrupted answer:
 * the runtime, which keeps its own transcript, continues from a copy whose
 * answer is that text (lib/llm/pi/runtime.mts). `messages` is the request's
 * history with interrupted answers on the turn's path replaced the same way,
 * for history the runtime never stored.
 *
 * The request's history carries no ids, and it need not line up with the
 * stored path one for one (a row the client never received, a colleague's
 * turn in a shared thread), so answers are never paired by position. A
 * history answer is replaced only when its text is the text of an
 * interrupted answer on the path, and of no answer on the path that was not
 * interrupted the same way; anything ambiguous is left whole. Nothing is read
 * beyond one indexed query unless the chat has an interrupted answer.
 */
export async function replayInterruptedAnswers(
    db: Db,
    args: {
        chatId: string;
        parentMessageId: string | null;
        messages: ChatMessage[];
        messageTable?: string;
    },
): Promise<{ messages: ChatMessage[]; parentHeard?: string }> {
    const { chatId, parentMessageId, messages } = args;
    if (!parentMessageId) return { messages };
    const { data, error } = await db
        .from(args.messageTable ?? "chat_messages")
        .select("id, spoken_text")
        .eq("chat_id", chatId)
        .eq("role", "assistant")
        .not("interrupted_at", "is", null);
    // Replay is a refinement: the turn still runs on the full history.
    if (error || !Array.isArray(data) || data.length === 0) return { messages };
    const heardById = new Map(
        (data as InterruptedRow[]).map((row) => [
            row.id,
            heardAnswerText(row.spoken_text ?? ""),
        ]),
    );
    const parentHeard = heardById.get(parentMessageId);

    // Each answer text on the path, and what replaces it: the heard text when
    // every answer with that text was interrupted alike, else null (keep it).
    const path = await walkActivePath(db, chatId, parentMessageId);
    const replacement = new Map<string, string | null>();
    for (const row of path) {
        if (row.role !== "assistant") continue;
        const prose = comparable(answerProse(row.content));
        if (!prose) continue;
        const heard = heardById.get(row.id) ?? null;
        replacement.set(
            prose,
            replacement.has(prose) && replacement.get(prose) !== heard ? null : heard,
        );
    }
    const replayed = messages.map((message) => {
        if (message.role !== "assistant" || typeof message.content !== "string")
            return message;
        const heard = replacement.get(comparable(message.content));
        return heard ? { ...message, content: heard } : message;
    });
    return parentHeard !== undefined
        ? { messages: replayed, parentHeard }
        : { messages: replayed };
}
