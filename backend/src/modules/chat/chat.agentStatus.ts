// Where a chat's background subagents stand, on the cards that started them.
//
// A background subagent (lib/llm/pi/runtime.mts) works on after the answer
// that started it, and that answer's stored card shows it as it was when the
// answer ended: working, as a rule. A transcript shows where each stands now:
// its status, what it has spent, and the start of its latest report.
import type { SubagentEvent } from "@mike/contracts";
import { backgroundAgentStatuses } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import { REPORT_PREVIEW_CHARS } from "./engine/subagents/subagentHost";

function isBackgroundCard(event: unknown): event is SubagentEvent {
    return (
        !!event &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "subagent" &&
        (event as { background?: unknown }).background === true &&
        typeof (event as { child_id?: unknown }).child_id === "string"
    );
}

/** The transcript's messages, their background subagents' cards brought up to date. */
export async function withBackgroundAgentStatus(
    chatId: string,
    messages: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
    const childIds = messages.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
            ? message.content.filter(isBackgroundCard).map((event) => event.child_id)
            : [],
    );
    if (!childIds.length) return messages;
    let statuses: Awaited<ReturnType<typeof backgroundAgentStatuses>>;
    try {
        statuses = await backgroundAgentStatuses(chatId, childIds);
    } catch (error) {
        // The cards as stored: right as of the answer, and only stale.
        console.error("[chat/agents] could not read background subagents' status", safeError(error));
        return messages;
    }
    return messages.map((message) => {
        if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
        if (!message.content.some(isBackgroundCard)) return message;
        return {
            ...message,
            content: message.content.map((event: unknown) => {
                if (!isBackgroundCard(event)) return event;
                const now = statuses[event.child_id];
                if (!now) return event;
                return {
                    ...event,
                    status: now.status,
                    ...(now.usage ? { usage: now.usage } : {}),
                    ...(now.report !== null ? { report_preview: now.report.slice(0, REPORT_PREVIEW_CHARS) } : {}),
                };
            }),
        };
    });
}
