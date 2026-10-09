"use client";

import { useEffect, useState } from "react";
import type { AssistantEvent } from "@/app/components/shared/types";
import type { SubagentTranscript } from "@/app/lib/mikeApi";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

type SubagentEvent = Extract<AssistantEvent, { type: "subagent" }>;

export type LoadSubagentTranscript = (
    childId: string,
) => Promise<SubagentTranscript>;

const STATUS_TEXT: Record<SubagentEvent["status"], string> = {
    running: "Working",
    done: "Done",
    failed: "Failed",
    timed_out: "Ran out of time",
    stopped: "Stopped",
};

/** "document_review" reads as "Document review". */
function typeLabel(type: string): string {
    const words = type.replace(/_/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : "Subagent";
}

function usageText(usage: SubagentEvent["usage"]): string | null {
    if (!usage) return null;
    const tokens = `${(usage.input + usage.output).toLocaleString()} tokens`;
    if (usage.cost <= 0) return tokens;
    const cost = usage.cost < 0.01 ? "under $0.01" : `$${usage.cost.toFixed(2)}`;
    return `${tokens} · ${cost}`;
}

/**
 * What an answer that delegated cost: its own model responses, then its
 * subagents together. Null for an answer without subagents, or before its
 * own usage is known; answers that delegated nothing show no cost line.
 */
export function delegatedTurnCost(events: AssistantEvent[] | undefined): string | null {
    const children = (events ?? []).filter(
        (event): event is SubagentEvent => event.type === "subagent",
    );
    const own = (events ?? []).find(
        (event): event is Extract<AssistantEvent, { type: "turn_usage" }> =>
            event.type === "turn_usage",
    );
    if (children.length === 0 || !own) return null;
    const total = { input: 0, output: 0, cost: 0 };
    for (const child of children) {
        total.input += child.usage?.input ?? 0;
        total.output += child.usage?.output ?? 0;
        total.cost += child.usage?.cost ?? 0;
    }
    const label = children.length === 1 ? "1 subagent" : `${children.length} subagents`;
    return `This answer: ${usageText(own)}. ${label}: ${usageText(total)}.`;
}

function inputText(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    return Object.entries(input as Record<string, unknown>)
        .map(([key, value]) =>
            `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
        .join(", ");
}

/**
 * A subagent the turn delegated to. Its work is not part of the chat's
 * thread: the line says what it was asked and how it ended, and opening it
 * loads the child's own transcript (its task, each step and its report).
 */
export function SubagentBlock({
    event,
    showConnector,
    onLoadTranscript,
}: {
    event: SubagentEvent;
    showConnector?: boolean;
    /** Absent where the transcript cannot be reached; the line then shows the report's start. */
    onLoadTranscript?: LoadSubagentTranscript;
}) {
    const [open, setOpen] = useState(false);
    // Keyed by the status it was loaded for, so a child that finishes while
    // open is loaded again rather than showing its half-done work.
    const [loaded, setLoaded] = useState<
        | { status: string; transcript: SubagentTranscript }
        | { status: string; failed: true }
        | null
    >(null);
    const running = event.status === "running";
    const failed = event.status === "failed" || event.status === "timed_out";

    useEffect(() => {
        if (!open || !onLoadTranscript) return;
        let cancelled = false;
        onLoadTranscript(event.child_id).then(
            (transcript) => {
                if (!cancelled) setLoaded({ status: event.status, transcript });
            },
            () => {
                if (!cancelled) setLoaded({ status: event.status, failed: true });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [open, onLoadTranscript, event.child_id, event.status]);

    const current = loaded?.status === event.status ? loaded : null;
    const usage = usageText(event.usage);

    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={running}
            dotColor={failed ? "red" : event.status === "stopped" ? "gray" : "green"}
        >
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={`${typeLabel(event.agent_type)} subagent`}
                isStreaming={running}
            />
            <p className="text-xs break-words">{event.model}</p>
            <p className="text-xs">
                {STATUS_TEXT[event.status]}
                {usage ? ` · ${usage}` : null}
            </p>
            {open && (
                <div className="mt-2 flex flex-col gap-2 text-sm">
                    <div>
                        <EventLabel>Task</EventLabel>
                        <p className="whitespace-pre-wrap break-words">{event.task}</p>
                    </div>
                    {!onLoadTranscript ? (
                        event.report_preview ? (
                            <div>
                                <EventLabel>Report</EventLabel>
                                <p className="whitespace-pre-wrap break-words">
                                    {event.report_preview}
                                </p>
                            </div>
                        ) : null
                    ) : !current ? (
                        <div
                            className="flex flex-col gap-1.5 animate-pulse"
                            aria-label="Loading the subagent's work"
                            role="status"
                        >
                            <div className="h-3 w-3/4 rounded bg-gray-200" />
                            <div className="h-3 w-1/2 rounded bg-gray-200" />
                        </div>
                    ) : "failed" in current ? (
                        <p className="text-red-600">
                            The subagent&apos;s work could not be loaded.
                        </p>
                    ) : (
                        <SubagentSteps transcript={current.transcript} />
                    )}
                </div>
            )}
        </EventBlock>
    );
}

function SubagentSteps({ transcript }: { transcript: SubagentTranscript }) {
    // The task is already shown above; the last assistant text is the report.
    const steps = transcript.entries.filter((entry) => entry.kind !== "task");
    if (steps.length === 0) {
        return <p>No steps yet.</p>;
    }
    return (
        <ol className="flex flex-col gap-1.5">
            {steps.map((entry, index) => {
                if (entry.kind === "tool_result") {
                    return (
                        <li key={index}>
                            <details>
                                <summary className="cursor-pointer rounded-sm hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400">
                                    {entry.isError ? "Error from " : "Result of "}
                                    {entry.name}
                                </summary>
                                <p
                                    className={`mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs ${entry.isError ? "text-red-600" : ""}`}
                                >
                                    {entry.text}
                                </p>
                            </details>
                        </li>
                    );
                }
                const isReport = index === steps.length - 1 && entry.toolCalls.length === 0;
                return (
                    <li key={index} className="flex flex-col gap-0.5">
                        {entry.text ? (
                            <>
                                {isReport ? <EventLabel>Report</EventLabel> : null}
                                <p className="whitespace-pre-wrap break-words text-gray-700">
                                    {entry.text}
                                </p>
                            </>
                        ) : null}
                        {entry.toolCalls.map((call, callIndex) => (
                            <p key={callIndex} className="break-words">
                                <EventLabel>Called {call.name}</EventLabel>
                                {inputText(call.input) ? ` (${inputText(call.input)})` : null}
                            </p>
                        ))}
                    </li>
                );
            })}
        </ol>
    );
}
