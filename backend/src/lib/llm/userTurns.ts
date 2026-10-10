import type { LlmMessage } from "./types";

// Back-to-back user messages, which a thread gets from `/nr` (a message
// added without asking for a reply) or from two people writing in a shared
// thread, reach the model as one user turn. Hosted providers accept
// consecutive user turns, but some local chat templates (Gemma, Mistral)
// refuse anything that does not alternate, so they are joined here, once,
// for every provider. The separator keeps the messages visibly apart.

export const USER_TURN_SEPARATOR = "\n\n---\n\n";

export function mergeConsecutiveUserTurns(messages: LlmMessage[]): LlmMessage[] {
    const merged: LlmMessage[] = [];
    for (const message of messages) {
        const previous = merged[merged.length - 1];
        if (message.role !== "user" || previous?.role !== "user") {
            merged.push(message);
            continue;
        }
        const before = previous.content;
        const after = message.content;
        merged[merged.length - 1] = {
            role: "user",
            content:
                typeof before === "string" && typeof after === "string"
                    ? `${before}${USER_TURN_SEPARATOR}${after}`
                    : [
                          ...(typeof before === "string" ? [{ type: "text" as const, text: before }] : before),
                          { type: "text" as const, text: USER_TURN_SEPARATOR.trim() },
                          ...(typeof after === "string" ? [{ type: "text" as const, text: after }] : after),
                      ],
        };
    }
    return merged;
}
