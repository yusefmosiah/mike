/**
 * Pure measurements over stored assistant parts and pi durable entries.
 * Nothing here does I/O; extract, run and report all call into it so the
 * original and the replay are measured by the same code.
 */
import type {
    AskInputItem,
    AssistantEvent,
    CallMetrics,
    TurnMetrics,
} from "./types.mts";

export function emptyMetrics(): TurnMetrics {
    return {
        wallMs: null,
        usage: { input: 0, output: 0, cost: 0, parts: 0 },
        calls: null,
        tools: {
            codeCells: 0,
            codeCellsFailed: 0,
            codeCellsErrorOutput: 0,
            subagents: 0,
            subagentsFailed: 0,
            mcpCalls: 0,
            mcpErrors: 0,
            docReads: 0,
            docCreated: 0,
            docEdited: 0,
            workflowsApplied: 0,
        },
        errors: [],
        asks: 0,
        answerChars: 0,
        reasoningChars: 0,
    };
}

const ERROR_OUTPUT =
    /Traceback \(most recent call last\)|^(?:[A-Za-z_.]*(?:Error|Exception)): |^\{"error":/m;

/** The visible answer: the `content` parts, in order. */
export function answerText(parts: readonly AssistantEvent[]): string {
    return parts
        .filter((p): p is Extract<AssistantEvent, { type: "content" }> => p.type === "content")
        .map((p) => p.text)
        .join("");
}

export function reasoningText(parts: readonly AssistantEvent[]): string {
    return parts
        .filter((p): p is Extract<AssistantEvent, { type: "reasoning" }> => p.type === "reasoning")
        .map((p) => p.text)
        .join("\n");
}

/** Adds one stored assistant message's parts into `into`. */
export function addPartsMetrics(into: TurnMetrics, parts: readonly AssistantEvent[]): TurnMetrics {
    for (const part of parts) {
        switch (part.type) {
            case "turn_usage":
                into.usage.input += part.input ?? 0;
                into.usage.output += part.output ?? 0;
                into.usage.cost += part.cost ?? 0;
                into.usage.parts += 1;
                break;
            case "code_cell":
                into.tools.codeCells += 1;
                if (part.status === "failed") into.tools.codeCellsFailed += 1;
                else if (part.output && ERROR_OUTPUT.test(part.output)) into.tools.codeCellsErrorOutput += 1;
                break;
            case "subagent":
                into.tools.subagents += 1;
                if (part.status !== "done") into.tools.subagentsFailed += 1;
                break;
            case "mcp_tool_call":
                into.tools.mcpCalls += 1;
                if (part.status === "error") into.tools.mcpErrors += 1;
                break;
            case "doc_read":
                into.tools.docReads += 1;
                break;
            case "doc_created":
                into.tools.docCreated += 1;
                break;
            case "doc_edited":
                into.tools.docEdited += 1;
                break;
            case "workflow_applied":
                into.tools.workflowsApplied += 1;
                break;
            case "error":
                into.errors.push(part.message);
                break;
            case "ask_inputs":
                into.asks += 1;
                break;
            case "content":
                into.answerChars += part.text.length;
                break;
            case "reasoning":
                into.reasoningChars += part.text.length;
                break;
            default:
                break;
        }
    }
    into.usage.cost = Math.round(into.usage.cost * 1e8) / 1e8;
    return into;
}

export function metricsFromParts(parts: readonly AssistantEvent[]): TurnMetrics {
    return addPartsMetrics(emptyMetrics(), parts);
}

// ---------------------------------------------------------------------------
// pi durable entries
// ---------------------------------------------------------------------------

type PiMessage = {
    role?: string;
    model?: string;
    timestamp?: number;
    durationMs?: number;
    stopReason?: string;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoning?: number;
        cost?: { total?: number };
    };
};

export type DurableEntry = {
    id: number;
    conversationId: number;
    kind: string;
    model?: PiMessage[] | PiMessage;
};

/**
 * Accepts either the raw `r` objects or the `{id, conv, r}` rows the thread
 * review exported, and returns entries sorted by id.
 */
export function normalizeEntries(rows: unknown[]): DurableEntry[] {
    const out: DurableEntry[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const r = ("r" in row && row.r && typeof row.r === "object" ? row.r : row) as Record<string, unknown>;
        const id = Number(r.id ?? (row as Record<string, unknown>).id);
        const conversationId = Number(r.conversationId ?? (row as Record<string, unknown>).conv);
        const kind = typeof r.kind === "string" ? r.kind : "";
        if (!Number.isFinite(id) || !kind) continue;
        let model = r.model as DurableEntry["model"];
        if (typeof model === "string") {
            try {
                model = JSON.parse(model);
            } catch {
                model = undefined;
            }
        }
        out.push({ id, conversationId, kind, model });
    }
    return out.sort((a, b) => a.id - b.id);
}

function firstMessage(entry: DurableEntry): PiMessage | undefined {
    return Array.isArray(entry.model) ? entry.model[0] : entry.model;
}

export type TurnWindow = { start: number; end: number | null };

/**
 * Splits model calls into turns by time: a call belongs to the window its
 * timestamp falls in. Entries without a timestamp (compactions, tool results)
 * take the previous entry's in the same conversation. `subagentConversations`
 * names the conversations a delegate tool started; their calls are counted
 * separately so the main loop's numbers stay comparable.
 */
export function callMetricsByWindow(
    entries: DurableEntry[],
    windows: TurnWindow[],
    subagentConversations: ReadonlySet<number> = new Set(),
): { metrics: CallMetrics[]; lastCallEnd: (number | null)[] } {
    const metrics: CallMetrics[] = windows.map(() => ({
        modelCalls: 0,
        subagentCalls: 0,
        models: [],
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        cost: 0,
        compactions: 0,
        modelMs: 0,
        stopReasons: {},
    }));
    const lastCallEnd: (number | null)[] = windows.map(() => null);
    const lastTimestamp = new Map<number, number>();
    const windowOf = (t: number) =>
        windows.findIndex((w) => t >= w.start && (w.end === null || t < w.end));
    // A background compaction finishes after its turn has ended, between two
    // turn windows; it belongs to the turn that triggered it.
    const latestStartedBefore = (t: number) => {
        let found = -1;
        windows.forEach((w, i) => {
            if (w.start <= t && (found < 0 || w.start >= windows[found]!.start)) found = i;
        });
        return found;
    };
    for (const entry of entries) {
        const message = firstMessage(entry);
        const own = typeof message?.timestamp === "number" ? message.timestamp : undefined;
        const t = own ?? lastTimestamp.get(entry.conversationId);
        if (own !== undefined) lastTimestamp.set(entry.conversationId, own);
        if (t === undefined) continue;
        const index = entry.kind === "pi.compaction" && windowOf(t) < 0 ? latestStartedBefore(t) : windowOf(t);
        if (index < 0) continue;
        const m = metrics[index]!;
        if (entry.kind === "pi.compaction") {
            m.compactions += 1;
            continue;
        }
        if (entry.kind !== "pi.assistant" || !message) continue;
        if (subagentConversations.has(entry.conversationId)) {
            m.subagentCalls += 1;
            continue;
        }
        m.modelCalls += 1;
        if (message.model && !m.models.includes(message.model)) m.models.push(message.model);
        const usage = message.usage ?? {};
        m.input += usage.input ?? 0;
        m.cacheRead += usage.cacheRead ?? 0;
        m.cacheWrite += usage.cacheWrite ?? 0;
        m.output += usage.output ?? 0;
        m.reasoning += usage.reasoning ?? 0;
        m.cost += usage.cost?.total ?? 0;
        m.modelMs += message.durationMs ?? 0;
        if (message.stopReason) m.stopReasons[message.stopReason] = (m.stopReasons[message.stopReason] ?? 0) + 1;
        const end = (message.timestamp ?? t) + (message.durationMs ?? 0);
        lastCallEnd[index] = Math.max(lastCallEnd[index] ?? 0, end);
    }
    for (const m of metrics) m.cost = Math.round(m.cost * 1e8) / 1e8;
    return { metrics, lastCallEnd };
}

function convRecords(convs: unknown[]): { id: number; ownerConversation: number | null; owned: boolean }[] {
    const out: { id: number; ownerConversation: number | null; owned: boolean }[] = [];
    for (const row of convs) {
        if (!row || typeof row !== "object") continue;
        const r = ("r" in row && row.r && typeof row.r === "object" ? row.r : row) as Record<string, unknown>;
        const id = Number(r.id ?? (row as Record<string, unknown>).id);
        if (!Number.isFinite(id)) continue;
        const owner = r.owner && typeof r.owner === "object" ? (r.owner as Record<string, unknown>) : null;
        const ownerConversation = owner && Number.isFinite(Number(owner.conversationId)) ? Number(owner.conversationId) : null;
        out.push({ id, ownerConversation, owned: !!owner });
    }
    return out;
}

/** Conversations a task owns (subagents), from the convs export's `owner` field. */
export function subagentConversationIds(convs: unknown[]): Set<number> {
    return new Set(convRecords(convs).filter((c) => c.owned).map((c) => c.id));
}

/**
 * A chat's conversations: its lineage (the ids given) plus the subagent
 * conversations their tasks started, transitively. An entries export that
 * spans several chats must be narrowed to one before it is split by time.
 */
export function chatConversationIds(lineage: Iterable<number>, convs: unknown[]): Set<number> {
    const ids = new Set(lineage);
    const records = convRecords(convs);
    for (let grew = true; grew; ) {
        grew = false;
        for (const c of records) {
            if (!ids.has(c.id) && c.ownerConversation !== null && ids.has(c.ownerConversation)) {
                ids.add(c.id);
                grew = true;
            }
        }
    }
    return ids;
}

/**
 * Conversation ids from `--conversations`: a comma list, or a JSON file (a
 * lineage document or any JSON) whose first `conversations` array is used.
 */
export function parseConversationIds(value: string, readFile: (file: string) => string): number[] {
    if (/^\s*\d+(\s*,\s*\d+)*\s*$/.test(value)) return value.split(",").map((s) => Number(s.trim()));
    const find = (node: unknown): number[] | null => {
        if (Array.isArray(node)) {
            if (node.length > 0 && node.every((v) => Number.isFinite(Number(v)) && typeof v !== "object")) return node.map(Number);
            for (const item of node) {
                const hit = find(item);
                if (hit) return hit;
            }
            return null;
        }
        if (!node || typeof node !== "object") return null;
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.conversations)) return record.conversations.map(Number);
        for (const v of Object.values(record)) {
            const parsed = typeof v === "string" && v.trim().startsWith("{") ? safeJson(v) : v;
            const hit = find(parsed);
            if (hit) return hit;
        }
        return null;
    };
    const ids = find(safeJson(readFile(value)));
    if (!ids) throw new Error(`no conversation ids in ${value}`);
    return ids;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Answer quality checks
// ---------------------------------------------------------------------------

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Sections written twice: a markdown heading repeated verbatim, or a long
 * paragraph (>= `minParagraph` characters) repeated verbatim. Code fences are
 * ignored. Returns short previews of each repeat.
 */
export function duplicateSections(
    text: string,
    minParagraph = 120,
): { headings: string[]; paragraphs: string[] } {
    const prose = text.replace(/```[\s\S]*?```/g, "");
    const headingCounts = new Map<string, number>();
    for (const line of prose.split("\n")) {
        const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (!match) continue;
        const key = normalize(match[1]!);
        if (key) headingCounts.set(key, (headingCounts.get(key) ?? 0) + 1);
    }
    const paragraphCounts = new Map<string, number>();
    for (const block of prose.split(/\n\s*\n/)) {
        const key = normalize(block);
        if (key.length < minParagraph) continue;
        paragraphCounts.set(key, (paragraphCounts.get(key) ?? 0) + 1);
    }
    const repeats = (counts: Map<string, number>) =>
        [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k.slice(0, 80)} (x${n})`);
    return { headings: repeats(headingCounts), paragraphs: repeats(paragraphCounts) };
}

const GENERIC_QUESTION = /^(please )?(choose|select|pick) (an|one) option\.?$/i;

/** What is wrong with an ask_inputs prompt, as the user would see it. */
export function askInputIssues(items: readonly AskInputItem[]): string[] {
    const issues: string[] = [];
    if (items.length === 0) return ["no items"];
    const ids = new Set<string>();
    const signatures = new Map<string, number>();
    for (const [index, item] of items.entries()) {
        const at = `item ${index + 1}`;
        if (ids.has(item.id)) issues.push(`${at}: duplicate id ${item.id}`);
        ids.add(item.id);
        if (item.kind === "choice" || item.kind === "multi_choice" || item.kind === "text") {
            if (!item.question.trim()) issues.push(`${at}: empty question`);
            else if (GENERIC_QUESTION.test(item.question.trim())) issues.push(`${at}: generic question "${item.question}"`);
        }
        if (item.kind === "choice" || item.kind === "multi_choice") {
            const values = item.options.map((o) => o.value.trim());
            if (values.some((v) => !v)) issues.push(`${at}: empty option`);
            if (new Set(values.map(normalize)).size !== values.length) issues.push(`${at}: duplicate options`);
            if (values.length < 2) issues.push(`${at}: ${values.length} option(s); nothing to choose between`);
            const signature = `${item.kind}|${normalize(item.question)}|${values.map(normalize).join("|")}`;
            signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
        }
    }
    for (const [signature, count] of signatures) {
        if (count > 1) issues.push(`${count} identical items (${signature.split("|")[1]})`);
    }
    if (items.length > 8) issues.push(`${items.length} items in one prompt`);
    return issues;
}
