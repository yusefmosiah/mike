"use client";

import type { AssistantEvent } from "@/app/components/shared/types";
import { EventBlock } from "./EventBlocks";
import { EventLabel } from "./EventDisclosure";

type CodeApprovalEvent = Extract<AssistantEvent, { type: "code_approval" }>;

/** The line for a command waiting on the thread's starter, then its answer. */
export function codeApprovalText(event: CodeApprovalEvent): string {
    const host = event.host_name || "the person who started this thread";
    const Host = event.host_name || "The person who started this thread";
    switch (event.status) {
        case "waiting":
            return `Waiting for ${host} to allow running code in their workstation`;
        case "allowed":
            return `${Host} allowed running code in their workstation`;
        case "denied":
            return `${Host} did not allow running code in their workstation`;
        default:
            return `${Host} did not answer the request to run code`;
    }
}

/**
 * A guest's command in a shared thread: its code runs in the starter's
 * workstation, so the turn waits here until the starter answers.
 */
export function CodeApprovalBlock({
    event,
    showConnector,
}: {
    event: CodeApprovalEvent;
    showConnector?: boolean;
}) {
    const text = codeApprovalText(event);
    return (
        <div role="status" aria-live="polite">
            <EventBlock
                showConnector={showConnector}
                isStreaming={event.status === "waiting"}
                dotColor={event.status === "allowed" || event.status === "waiting" ? "green" : "gray"}
            >
                <EventLabel>
                    {event.status === "waiting" ? `${text}…` : text}
                </EventLabel>
            </EventBlock>
        </div>
    );
}
