/**
 * `extract`: turns a chat_messages export into the ordered user turns of one
 * branch, with the original answers' metrics and ask_inputs answers.
 */
import {
    addPartsMetrics,
    answerText,
    callMetricsByWindow,
    emptyMetrics,
    reasoningText,
    type DurableEntry,
    type TurnWindow,
} from "./metrics.mts";
import type {
    AskInputResponseItem,
    AssistantEvent,
    ChatMessageRow,
    ExtractedThread,
    ExtractedTurn,
    OriginalAsk,
} from "./types.mts";

const time = (row: Pick<ChatMessageRow, "created_at">) => Date.parse(row.created_at);

function assistantParts(row: ChatMessageRow): AssistantEvent[] {
    if (Array.isArray(row.content)) return row.content;
    if (typeof row.content === "string" && row.content) return [{ type: "content", text: row.content }];
    return [];
}

/**
 * The default leaf: the newest message nobody answers (no row names it as a
 * parent). On a thread with branches this is the branch touched last.
 */
export function defaultLeaf(rows: readonly ChatMessageRow[]): ChatMessageRow {
    const parents = new Set(rows.map((r) => r.parent_message_id).filter(Boolean));
    const leaves = rows.filter((r) => !parents.has(r.id));
    if (leaves.length === 0) throw new Error("the export has no leaf message");
    return leaves.reduce((a, b) => (time(b) > time(a) ? b : a));
}

/** Root-to-leaf rows of the branch ending at `leafId`. */
export function branchPath(rows: readonly ChatMessageRow[], leafId?: string): ChatMessageRow[] {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const leaf = leafId ? byId.get(leafId) : defaultLeaf(rows);
    if (!leaf) throw new Error(`leaf ${leafId} is not in the export`);
    const path: ChatMessageRow[] = [];
    const seen = new Set<string>();
    for (let row: ChatMessageRow | undefined = leaf; row; ) {
        if (seen.has(row.id)) throw new Error(`parent cycle at ${row.id}`);
        seen.add(row.id);
        path.push(row);
        if (!row.parent_message_id) break;
        const parent = byId.get(row.parent_message_id);
        if (!parent) throw new Error(`message ${row.id} names parent ${row.parent_message_id}, which is not in the export`);
        row = parent;
    }
    return path.reverse();
}

/**
 * Every ask_inputs pause in a turn's assistant rows, in order, with the
 * response the thread recorded for it (matched by ask_event_id, wherever in
 * the turn it was stored).
 */
export function collectAsks(assistantRows: readonly ChatMessageRow[]): OriginalAsk[] {
    const responses = new Map<string, AskInputResponseItem[]>();
    for (const row of assistantRows) {
        for (const part of assistantParts(row)) {
            if (part.type === "ask_inputs_response") responses.set(part.ask_event_id, part.responses);
        }
    }
    const asks: OriginalAsk[] = [];
    for (const row of assistantRows) {
        for (const part of assistantParts(row)) {
            if (part.type !== "ask_inputs") continue;
            asks.push({
                assistantMessageId: row.id,
                eventId: part.event_id,
                items: part.items,
                responses: responses.get(part.event_id) ?? null,
            });
        }
    }
    return asks;
}

export function extractThread(
    rows: readonly ChatMessageRow[],
    opts: {
        source: string;
        leafId?: string;
        model?: string | null;
        entries?: DurableEntry[];
        subagentConversations?: ReadonlySet<number>;
    },
): ExtractedThread {
    const path = branchPath(rows, opts.leafId);
    const onPath = new Set(path.map((r) => r.id));
    const userTimes = rows.filter((r) => r.role === "user").map(time).sort((a, b) => a - b);

    const groups: { user: ChatMessageRow; assistants: ChatMessageRow[] }[] = [];
    for (const row of path) {
        if (row.role === "user") groups.push({ user: row, assistants: [] });
        else if (groups.length > 0) groups[groups.length - 1]!.assistants.push(row);
        // An assistant row before the first prompt (a greeting) has no turn.
    }
    if (groups.length === 0) throw new Error("the branch has no user messages");

    const windows: TurnWindow[] = groups.map(({ user, assistants }) => {
        const start = assistants.length > 0 ? Math.min(...assistants.map(time)) : time(user);
        let end: number | null = userTimes.find((t) => t > start) ?? null;
        // A regenerated answer is an off-path sibling under the same prompt;
        // its model calls must not be counted as this answer's.
        for (const sibling of rows) {
            if (sibling.role !== "assistant" || onPath.has(sibling.id)) continue;
            if (sibling.parent_message_id !== user.id) continue;
            const t = time(sibling);
            if (t > start && (end === null || t < end)) end = t;
        }
        return { start, end };
    });
    const calls = opts.entries
        ? callMetricsByWindow(opts.entries, windows, opts.subagentConversations)
        : null;

    const turns: ExtractedTurn[] = groups.map(({ user, assistants }, i) => {
        const parts = assistants.flatMap(assistantParts);
        const metrics = addPartsMetrics(emptyMetrics(), parts);
        if (calls) {
            metrics.calls = calls.metrics[i]!;
            const end = calls.lastCallEnd[i];
            metrics.wallMs = end !== null && end !== undefined ? end - time(user) : null;
        }
        return {
            index: i + 1,
            messageId: user.id,
            createdAt: user.created_at,
            content: typeof user.content === "string" ? user.content : "",
            files: user.files ?? [],
            workflow: user.workflow ?? null,
            assistantMessageId: assistants[0]?.id ?? null,
            asks: collectAsks(assistants),
            answer: answerText(parts),
            reasoning: reasoningText(parts),
            metrics,
        };
    });

    return {
        format: "mike-replay-thread/1",
        source: opts.source,
        leafId: path[path.length - 1]!.id,
        t0: groups[0]!.user.created_at,
        t1: path[path.length - 1]!.created_at,
        offPathMessages: rows.length - path.length,
        model: opts.model ?? null,
        turns,
    };
}
