"use client";

import { useState, type ReactNode } from "react";
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
        // Only a run long enough to notice is worth saying.
        if (event.duration_ms >= 10_000) {
            parts.push(`${Math.round(event.duration_ms / 1000)} s`);
        }
    }
    return parts.length ? parts.join(" · ") : null;
}

/**
 * One code-mode cell (run_python): one step of the work. The line says what
 * the cell does (its summary, else that the assistant is computing) and,
 * once done, how many calls it made. Under it, always visible, are the
 * sources those calls touched: documents read, searches, pages, cases.
 * It starts closed; opening it shows the code and what came back, for
 * anyone who wants to check the work.
 */
export function CodeCellBlock({
    event,
    showConnector,
    sources,
}: {
    event: CodeCellEvent;
    showConnector?: boolean;
    /** The sources the cell's calls touched, rendered under its line. */
    sources?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const toggle = () => setOpen(!open);
    const running = event.status === "running";
    const detail = running ? null : detailText(event);
    const summary = event.summary?.text.trim();
    // With a summary, the line says what the cell does in the model's words
    // (or its first comment); the status moves into the detail.
    const label = summary ? (
        <span className="whitespace-pre-line font-normal text-gray-600">{summary}</span>
    ) : (
        LABEL[event.status]
    );
    const detailParts = [
        summary && event.status === "failed" ? LABEL.failed : null,
        detail,
    ].filter(Boolean);
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={running}
            dotColor={event.status === "failed" ? "red" : "green"}
        >
            <EventDisclosureButton
                open={open}
                onToggle={toggle}
                label={label}
                detail={detailParts.length ? `· ${detailParts.join(" · ")}` : undefined}
                isStreaming={running}
            />
            {sources ? (
                <div className="mt-2 flex flex-col gap-2" role="group" aria-label="Sources this step used">
                    {sources}
                </div>
            ) : null}
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
