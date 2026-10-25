import type { AssistantEvent } from "@/app/components/shared/types";

/**
 * Step sources on the timeline: each event a tool call produced names the
 * call (`call_id`), and a call made from a code cell is named
 * `<cell call_id>.<n>` (or `<cell call_id>.docs` for a read through `docs`).
 * So a cell's sources can be shown under the cell instead of as separate
 * lines, and a run can say what it read. See
 * docs/reports/step-summaries-2026-10-24.md.
 */

export type TimelineStep = {
    event: AssistantEvent;
    index: number;
    /** For a code cell: the events its calls produced, in order. */
    sources: { event: AssistantEvent; index: number }[];
};

function callIdOf(event: AssistantEvent): string | undefined {
    if (event.type === "code_cell") return undefined;
    const callId = (event as { call_id?: unknown }).call_id;
    return typeof callId === "string" ? callId : undefined;
}

/**
 * The group's events as steps: each code cell carries the events its calls
 * produced, and those events are not steps of their own. Anything that names
 * no cell in the group stays a step.
 */
export function nestCellSources(
    events: AssistantEvent[],
    indices: number[],
): TimelineStep[] {
    const steps: TimelineStep[] = [];
    const cells = new Map<string, TimelineStep>();
    events.forEach((event, position) => {
        const index = indices[position] ?? position;
        const callId = callIdOf(event);
        if (callId) {
            const dot = callId.indexOf(".");
            const cell = dot > 0 ? cells.get(callId.slice(0, dot)) : undefined;
            if (cell) {
                cell.sources.push({ event, index });
                return;
            }
        }
        const step: TimelineStep = { event, index, sources: [] };
        if (event.type === "code_cell") cells.set(event.call_id, step);
        steps.push(step);
    });
    return steps;
}

type SourceKind = "document" | "web page" | "web search" | "case" | "connector call";

const PLURALS: Record<SourceKind, string> = {
    document: "documents",
    "web page": "web pages",
    "web search": "web searches",
    case: "cases",
    "connector call": "connector calls",
};

/** What a set of events read, as distinct sources per kind. */
export function sourceCounts(events: AssistantEvent[]): Map<SourceKind, number> {
    const seen: Record<SourceKind, Set<string>> = {
        document: new Set(),
        "web page": new Set(),
        "web search": new Set(),
        case: new Set(),
        "connector call": new Set(),
    };
    for (const event of events) {
        switch (event.type) {
            case "doc_read":
            case "doc_find":
                seen.document.add(event.document_id ?? event.filename);
                break;
            case "web_fetch":
                if (!event.error) seen["web page"].add(event.url);
                break;
            case "web_search":
                if (!event.error) seen["web search"].add(event.query);
                break;
            case "courtlistener_read_case":
                if (event.cluster_id !== null) seen.case.add(String(event.cluster_id));
                break;
            case "courtlistener_get_cases":
                for (const item of event.cases ?? []) seen.case.add(String(item.cluster_id));
                break;
            case "mcp_tool_call":
                if (!event.isStreaming && event.status !== "error") {
                    seen["connector call"].add(
                        event.call_id ?? `${event.connector_name}:${event.tool_name}:${seen["connector call"].size}`,
                    );
                }
                break;
        }
    }
    const counts = new Map<SourceKind, number>();
    for (const kind of Object.keys(seen) as SourceKind[]) {
        if (seen[kind].size) counts.set(kind, seen[kind].size);
    }
    return counts;
}

/** "3 documents, 2 web pages" for the run line, or null when nothing was read. */
export function sourceSummary(events: AssistantEvent[]): string | null {
    const parts = [...sourceCounts(events)].map(
        ([kind, count]) => `${count} ${count === 1 ? kind : PLURALS[kind]}`,
    );
    return parts.length ? parts.join(", ") : null;
}
