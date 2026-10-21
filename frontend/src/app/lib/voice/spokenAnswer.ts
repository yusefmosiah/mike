import type { AssistantEvent } from "@/app/components/shared/types";

/**
 * The text of an answer to read aloud, and how many of its text pieces are
 * finished. An answer's text arrives in pieces separated by tool calls and
 * thinking; a piece is finished once something else follows it. Each finished
 * piece is spoken at once, so what the model says before it starts working is
 * heard while the work runs (docs/voice-chat.md, "Speaking"). Pieces are
 * joined by a paragraph break so their words never run together. Only grows
 * while the answer streams.
 */
export function spokenAnswer(message: { content: string; events?: AssistantEvent[] }): {
    text: string;
    settled: number;
} {
    const pieces = (message.events ?? []).filter(
        (event): event is Extract<AssistantEvent, { type: "content" }> => event.type === "content",
    );
    if (pieces.length === 0) return { text: message.content, settled: 0 };
    return {
        text: pieces.map((piece) => piece.text).join("\n\n"),
        settled: pieces.filter((piece) => !piece.isStreaming).length,
    };
}
