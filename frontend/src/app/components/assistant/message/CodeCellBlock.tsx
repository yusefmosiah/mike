"use client";

import { useState } from "react";
import type { AssistantEvent } from "@/app/components/shared/types";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

type CodeCellEvent = Extract<AssistantEvent, { type: "code_cell" }>;

const LABEL: Record<CodeCellEvent["status"], string> = {
    running: "Computing",
    ok: "Computed",
    failed: "Computation stopped",
};

function detailText(event: CodeCellEvent): string | null {
    const parts: string[] = [];
    if (event.tool_calls) {
        parts.push(`${event.tool_calls} ${event.tool_calls === 1 ? "step" : "steps"}`);
    }
    if (typeof event.duration_ms === "number") {
        const seconds = event.duration_ms / 1000;
        parts.push(seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`);
    }
    return parts.length ? parts.join(" · ") : null;
}

/**
 * One code-mode cell (run_python). The line says the assistant is computing
 * and, once done, how many steps it took; the steps themselves (documents
 * read, searches) are their own lines below it. Opening it shows the code and
 * what came back, for anyone who wants to check the work.
 */
export function CodeCellBlock({
    event,
    showConnector,
}: {
    event: CodeCellEvent;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const running = event.status === "running";
    const detail = running ? null : detailText(event);
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={running}
            dotColor={event.status === "failed" ? "red" : "green"}
        >
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={LABEL[event.status]}
                detail={detail ? `· ${detail}` : undefined}
                isStreaming={running}
            />
            {open && (
                <div className="mt-2 flex flex-col gap-2">
                    <div>
                        <EventLabel className="text-xs">Code</EventLabel>
                        <TextSlabUI className="mt-1">
                            <pre className="font-mono text-xs text-gray-700 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {event.code}
                            </pre>
                        </TextSlabUI>
                    </div>
                    {event.output !== undefined && (
                        <div>
                            <EventLabel className="text-xs">Result</EventLabel>
                            <TextSlabUI className="mt-1">
                                <pre className="font-mono text-xs text-gray-700 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                    {event.output}
                                </pre>
                            </TextSlabUI>
                        </div>
                    )}
                </div>
            )}
        </EventBlock>
    );
}
