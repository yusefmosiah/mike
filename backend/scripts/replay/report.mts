/**
 * `report`: the original thread and its replay side by side, per turn and in
 * total, with the checks that found the harness bugs (language switches,
 * empty answers, broken ask_inputs prompts, repeated sections, tool and
 * stream errors) and the final workstation file-tree diff.
 */
import {
    addPartsMetrics,
    answerText,
    askInputIssues,
    duplicateSections,
    emptyMetrics,
    reasoningText,
} from "./metrics.mts";
import { scriptMismatch, scriptProfile, type ScriptMismatch } from "./script.mts";
import type { TreeDiff } from "./files.mts";
import type {
    AssistantEvent,
    CallMetrics,
    ExtractedThread,
    ReplayTurnRecord,
    TurnMetrics,
} from "./types.mts";

export type SideReport = {
    present: boolean;
    status: "ok" | "failed" | "not run" | "original";
    metrics: TurnMetrics;
    empty: boolean;
    answerScript: ScriptMismatch | null;
    reasoningScript: ScriptMismatch | null;
    duplicates: { headings: string[]; paragraphs: string[] };
    askIssues: string[];
};

export type TurnReport = {
    index: number;
    prompt: string;
    promptScript: string | null;
    original: SideReport;
    replay: SideReport;
    replayNotes: string[];
};

export type Totals = {
    turns: number;
    wallMs: number | null;
    usage: { input: number; output: number; cost: number };
    calls: Omit<CallMetrics, "models" | "stopReasons"> & { models: string[] } | null;
    codeCells: number;
    codeCellsFailed: number;
    codeCellsErrorOutput: number;
    subagentsFailed: number;
    mcpErrors: number;
    errors: number;
    asks: number;
    emptyAnswers: number;
    scriptMismatches: number;
    duplicateSections: number;
    askIssues: number;
    failedTurns: number;
};

export type Report = {
    format: "mike-replay-report/1";
    generatedAt: string;
    thread: { source: string; leafId: string; t0: string; turns: number };
    replay: { chatId: string | null; model: string | null; reasoning: string | null };
    totals: { original: Totals; replay: Totals; delta: Record<string, number | null> };
    turns: TurnReport[];
    findings: string[];
    tree: TreeDiff | null;
    documents: { side: "original" | "replay"; file: string; headings: string[]; paragraphs: string[] }[];
};

function side(
    prompt: string,
    parts: readonly AssistantEvent[] | null,
    metrics: TurnMetrics,
    status: SideReport["status"],
    answer?: string,
    reasoning?: string,
): SideReport {
    const text = answer ?? (parts ? answerText(parts) : "");
    const thoughts = reasoning ?? (parts ? reasoningText(parts) : "");
    const asks = (parts ?? []).flatMap((p) => (p.type === "ask_inputs" ? [p] : []));
    return {
        present: status !== "not run",
        status,
        metrics,
        empty: status !== "not run" && text.trim() === "" && metrics.asks === 0,
        answerScript: scriptMismatch(prompt, text),
        reasoningScript: scriptMismatch(prompt, thoughts),
        duplicates: duplicateSections(text),
        askIssues: asks.flatMap((a, i) => askInputIssues(a.items).map((issue) => `ask ${i + 1}: ${issue}`)),
    };
}

/** Sums a side's turns; `null` totals where any turn was not measured. */
export function totalsOf(sides: readonly SideReport[]): Totals {
    const present = sides.filter((s) => s.present);
    const ms = present.map((s) => s.metrics);
    const sum = (f: (m: TurnMetrics) => number) => ms.reduce((a, m) => a + f(m), 0);
    const walls = ms.map((m) => m.wallMs);
    const calls = ms.map((m) => m.calls);
    let callTotals: Totals["calls"] = null;
    if (calls.length > 0 && calls.every((c): c is CallMetrics => c !== null)) {
        const add = (f: (c: CallMetrics) => number) => calls.reduce((a, c) => a + f(c), 0);
        callTotals = {
            modelCalls: add((c) => c.modelCalls),
            subagentCalls: add((c) => c.subagentCalls),
            input: add((c) => c.input),
            cacheRead: add((c) => c.cacheRead),
            cacheWrite: add((c) => c.cacheWrite),
            output: add((c) => c.output),
            reasoning: add((c) => c.reasoning),
            cost: Math.round(add((c) => c.cost) * 1e6) / 1e6,
            compactions: add((c) => c.compactions),
            modelMs: add((c) => c.modelMs),
            models: [...new Set(calls.flatMap((c) => c.models))],
        };
    }
    return {
        turns: present.length,
        wallMs: walls.length > 0 && walls.every((w) => w !== null) ? walls.reduce((a, w) => a + (w ?? 0), 0) : null,
        usage: {
            input: sum((m) => m.usage.input),
            output: sum((m) => m.usage.output),
            cost: Math.round(sum((m) => m.usage.cost) * 1e6) / 1e6,
        },
        calls: callTotals,
        codeCells: sum((m) => m.tools.codeCells),
        codeCellsFailed: sum((m) => m.tools.codeCellsFailed),
        codeCellsErrorOutput: sum((m) => m.tools.codeCellsErrorOutput),
        subagentsFailed: sum((m) => m.tools.subagentsFailed),
        mcpErrors: sum((m) => m.tools.mcpErrors),
        errors: sum((m) => m.errors.length),
        asks: sum((m) => m.asks),
        emptyAnswers: present.filter((s) => s.empty).length,
        scriptMismatches: present.filter((s) => s.answerScript || s.reasoningScript).length,
        duplicateSections: present.filter((s) => s.duplicates.headings.length + s.duplicates.paragraphs.length > 0).length,
        askIssues: present.reduce((a, s) => a + s.askIssues.length, 0),
        failedTurns: present.filter((s) => s.status === "failed").length,
    };
}

/** replay - original for every numeric total both sides measured. */
export function diffTotals(original: Totals, replay: Totals): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    const walk = (prefix: string, a: unknown, b: unknown) => {
        if (typeof a === "number" || typeof b === "number") {
            out[prefix] = typeof a === "number" && typeof b === "number" ? Math.round((b - a) * 1e6) / 1e6 : null;
            return;
        }
        if (a === null || b === null) {
            if (a && typeof a === "object") for (const k of Object.keys(a)) walk(`${prefix}.${k}`, (a as Record<string, unknown>)[k], null);
            else if (b && typeof b === "object") for (const k of Object.keys(b)) walk(`${prefix}.${k}`, null, (b as Record<string, unknown>)[k]);
            else out[prefix] = null;
            return;
        }
        if (typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
            for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
                walk(prefix ? `${prefix}.${k}` : k, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
            }
        }
    };
    walk("", original, replay);
    return out;
}

export function replayMetrics(record: ReplayTurnRecord, calls: CallMetrics | null): TurnMetrics {
    const metrics = emptyMetrics();
    for (const message of record.assistantMessages) addPartsMetrics(metrics, message.content);
    metrics.wallMs = record.wallMs;
    metrics.calls = calls;
    for (const attempt of record.attempts) {
        for (const error of attempt.errors) if (!metrics.errors.includes(error)) metrics.errors.push(error);
    }
    return metrics;
}

export function buildReport(args: {
    thread: ExtractedThread;
    replay: ReplayTurnRecord[];
    replayCalls?: (CallMetrics | null)[];
    run: { chatId: string | null; model: string | null; reasoning: string | null };
    tree?: TreeDiff | null;
    documents?: Report["documents"];
}): Report {
    const byIndex = new Map(args.replay.map((r, i) => [r.index, { record: r, calls: args.replayCalls?.[i] ?? null }]));
    const turns: TurnReport[] = args.thread.turns.map((turn) => {
        const original = side(turn.content, null, turn.metrics, "original", turn.answer, turn.reasoning);
        original.askIssues = turn.asks.flatMap((a, i) => askInputIssues(a.items).map((issue) => `ask ${i + 1}: ${issue}`));
        const hit = byIndex.get(turn.index);
        const replayParts = hit ? hit.record.assistantMessages.flatMap((m) => m.content) : null;
        const replay = hit
            ? side(turn.content, replayParts, replayMetrics(hit.record, hit.calls), hit.record.status)
            : side(turn.content, null, emptyMetrics(), "not run");
        const notes: string[] = [];
        if (hit?.record.droppedFiles.length) notes.push(`attachments not seeded: ${hit.record.droppedFiles.map((f) => f.filename).join(", ")}`);
        for (const ask of hit?.record.asks ?? []) notes.push(`ask_inputs answered from ${ask.mappedFrom}`);
        const retries = hit?.record.attempts.filter((a) => a.kind === "retry").length ?? 0;
        if (retries) notes.push(`retried ${retries}x`);
        const reconnects = hit?.record.attempts.reduce((a, b) => a + b.reconnects, 0) ?? 0;
        if (reconnects) notes.push(`stream reconnects: ${reconnects}`);
        return {
            index: turn.index,
            prompt: turn.content,
            promptScript: scriptProfile(turn.content).dominant,
            original,
            replay,
            replayNotes: notes,
        };
    });

    const originalTotals = totalsOf(turns.filter((t) => t.replay.present || args.replay.length === 0).map((t) => t.original));
    const replayTotals = totalsOf(turns.map((t) => t.replay));
    const findings: string[] = [];
    for (const t of turns) {
        for (const [name, s] of [["original", t.original], ["replay", t.replay]] as const) {
            if (!s.present) continue;
            const where = `turn ${t.index} ${name}`;
            if (s.status === "failed") findings.push(`${where}: failed (${s.metrics.errors.join("; ").slice(0, 200)})`);
            else if (s.metrics.errors.length) findings.push(`${where}: ${s.metrics.errors.length} error(s): ${s.metrics.errors.join("; ").slice(0, 200)}`);
            if (s.empty) findings.push(`${where}: empty answer`);
            if (s.answerScript) findings.push(`${where}: answer script ${describe(s.answerScript)}`);
            if (s.reasoningScript) findings.push(`${where}: reasoning script ${describe(s.reasoningScript)}`);
            const dupes = [...s.duplicates.headings, ...s.duplicates.paragraphs];
            if (dupes.length) findings.push(`${where}: repeated sections: ${dupes.slice(0, 3).join(" | ")}`);
            for (const issue of s.askIssues) findings.push(`${where}: ${issue}`);
            if (s.metrics.tools.codeCellsFailed) findings.push(`${where}: ${s.metrics.tools.codeCellsFailed} failed code cell(s)`);
            if (s.metrics.tools.codeCellsErrorOutput) findings.push(`${where}: ${s.metrics.tools.codeCellsErrorOutput} code cell(s) printed an error`);
            if (s.metrics.calls?.compactions) findings.push(`${where}: ${s.metrics.calls.compactions} compaction(s)`);
        }
    }
    for (const d of args.documents ?? []) {
        findings.push(`${d.side} document ${d.file}: repeated sections: ${[...d.headings, ...d.paragraphs].slice(0, 3).join(" | ")}`);
    }

    return {
        format: "mike-replay-report/1",
        generatedAt: new Date().toISOString(),
        thread: { source: args.thread.source, leafId: args.thread.leafId, t0: args.thread.t0, turns: args.thread.turns.length },
        replay: args.run,
        totals: { original: originalTotals, replay: replayTotals, delta: diffTotals(originalTotals, replayTotals) },
        turns,
        findings,
        tree: args.tree ?? null,
        documents: args.documents ?? [],
    };
}

function describe(m: ScriptMismatch): string {
    const foreign = m.foreign.map((f) => `${f.script} ${(f.share * 100).toFixed(0)}%`).join(", ");
    return `${m.dominant ?? "none"} (prompt ${m.expected}${foreign ? `; ${foreign}` : ""})`;
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString("en-US"));
const secs = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`);
const pair = (a: string, b: string) => (a === b ? a : `${a} → ${b}`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function flags(s: SideReport): string {
    if (!s.present) return "not run";
    const out: string[] = [];
    if (s.status === "failed") out.push("FAILED");
    if (s.metrics.errors.length) out.push(`${s.metrics.errors.length} err`);
    if (s.empty) out.push("empty");
    if (s.answerScript) out.push(`script:${s.answerScript.dominant}`);
    if (s.reasoningScript) out.push(`reasoning:${s.reasoningScript.dominant}`);
    if (s.duplicates.headings.length + s.duplicates.paragraphs.length) out.push("dup");
    if (s.askIssues.length) out.push("ask");
    return out.join(", ") || "ok";
}

export function renderMarkdown(r: Report, opts: { treeLimit?: number } = {}): string {
    const o = r.totals.original;
    const p = r.totals.replay;
    const lines: string[] = [];
    lines.push(`# Thread replay report`, ``);
    lines.push(`- Thread: \`${r.thread.source}\`, leaf \`${r.thread.leafId}\`, ${r.thread.turns} prompts from ${r.thread.t0}`);
    lines.push(`- Replay: chat \`${r.replay.chatId ?? "?"}\`, model ${r.replay.model ?? "default"}, reasoning ${r.replay.reasoning ?? "default"}`);
    lines.push(`- Compared: ${p.turns} replayed turns against the same ${o.turns} original turns`, ``);
    lines.push(`## Totals`, ``, `| | Original | Replay |`, `|---|---:|---:|`);
    const row = (label: string, a: string, b: string) => lines.push(`| ${label} | ${a} | ${b} |`);
    row("Wall time", secs(o.wallMs), secs(p.wallMs));
    row("Model calls", n(o.calls?.modelCalls), n(p.calls?.modelCalls));
    row("Subagent calls", n(o.calls?.subagentCalls), n(p.calls?.subagentCalls));
    row("Input tokens (calls)", n(o.calls?.input), n(p.calls?.input));
    row("Cached input tokens", n(o.calls?.cacheRead), n(p.calls?.cacheRead));
    row("Output tokens (calls)", n(o.calls?.output), n(p.calls?.output));
    row("Reasoning tokens", n(o.calls?.reasoning), n(p.calls?.reasoning));
    row("Compactions", n(o.calls?.compactions), n(p.calls?.compactions));
    row("turn_usage input / output", `${n(o.usage.input)} / ${n(o.usage.output)}`, `${n(p.usage.input)} / ${n(p.usage.output)}`);
    row("Cost (USD)", o.usage.cost.toFixed(4), p.usage.cost.toFixed(4));
    row("Models", o.calls?.models.join(", ") || "–", p.calls?.models.join(", ") || "–");
    row("Code cells (failed / printed error)", `${o.codeCells} (${o.codeCellsFailed} / ${o.codeCellsErrorOutput})`, `${p.codeCells} (${p.codeCellsFailed} / ${p.codeCellsErrorOutput})`);
    row("Failed subagents / MCP errors", `${o.subagentsFailed} / ${o.mcpErrors}`, `${p.subagentsFailed} / ${p.mcpErrors}`);
    row("Error parts / stream errors", n(o.errors), n(p.errors));
    row("Failed turns", n(o.failedTurns), n(p.failedTurns));
    row("Empty answers", n(o.emptyAnswers), n(p.emptyAnswers));
    row("Script mismatches (answer or reasoning)", n(o.scriptMismatches), n(p.scriptMismatches));
    row("Turns with repeated sections", n(o.duplicateSections), n(p.duplicateSections));
    row("ask_inputs prompts / issues", `${o.asks} / ${o.askIssues}`, `${p.asks} / ${p.askIssues}`);
    row("Cost of model calls (USD)", o.calls ? o.calls.cost.toFixed(4) : "–", p.calls ? p.calls.cost.toFixed(4) : "–");
    lines.push(``, `Model-call rows need the pi durable entries exports (\`extract --entries\` for the original, \`report --replay-entries\` for the replay); "–" means not measured. Wall time of an original turn runs from its prompt to the end of its last model call, so it includes the user's time answering ask_inputs.`, ``);

    lines.push(`## Per turn`, ``);
    lines.push(`| # | Prompt | Wall | Calls | In / cached / out | Cells (fail) | Original | Replay | Notes |`);
    lines.push(`|---:|---|---|---|---|---|---|---|---|`);
    for (const t of r.turns) {
        const om = t.original.metrics;
        const rm = t.replay.metrics;
        const tokens = (m: TurnMetrics) => (m.calls ? `${n(m.calls.input)} / ${n(m.calls.cacheRead)} / ${n(m.calls.output)}` : `${n(m.usage.input)} / – / ${n(m.usage.output)}`);
        lines.push(
            `| ${t.index} | ${cell(t.prompt.slice(0, 60))}${t.prompt.length > 60 ? "…" : ""} | ${pair(secs(om.wallMs), t.replay.present ? secs(rm.wallMs) : "–")} | ${pair(n(om.calls?.modelCalls), t.replay.present ? n(rm.calls?.modelCalls) : "–")} | ${tokens(om)} → ${t.replay.present ? tokens(rm) : "–"} | ${om.tools.codeCells} (${om.tools.codeCellsFailed}) → ${t.replay.present ? `${rm.tools.codeCells} (${rm.tools.codeCellsFailed})` : "–"} | ${flags(t.original)} | ${flags(t.replay)} | ${cell(t.replayNotes.join("; "))} |`,
        );
    }
    lines.push(``, `## Findings`, ``);
    if (r.findings.length === 0) lines.push(`None.`);
    for (const f of r.findings) lines.push(`- ${f}`);

    if (r.tree) {
        const limit = opts.treeLimit ?? 50;
        const t = r.tree;
        lines.push(``, `## Workstation files at the end`, ``);
        lines.push(`- Original: ${t.totals.originalFiles} files, ${n(t.totals.originalBytes)} bytes; replay: ${t.totals.replayFiles} files, ${n(t.totals.replayBytes)} bytes`);
        lines.push(`- Same path and size: ${t.same}; only in original: ${t.onlyOriginal.length}; only in replay: ${t.onlyReplay.length}; size differs: ${t.sizeChanged.length}`, ``);
        const list = (title: string, items: string[]) => {
            if (items.length === 0) return;
            lines.push(`### ${title}`, ``, "```");
            lines.push(...items.slice(0, limit));
            if (items.length > limit) lines.push(`… ${items.length - limit} more (see report.json)`);
            lines.push("```", ``);
        };
        list("Only in the original", t.onlyOriginal.map((e) => `${String(e.size).padStart(10)}  ${e.path}`));
        list("Only in the replay", t.onlyReplay.map((e) => `${String(e.size).padStart(10)}  ${e.path}`));
        list("Size differs (original → replay)", t.sizeChanged.map((e) => `${e.original} → ${e.replay}  ${e.path}`));
    }
    return `${lines.join("\n")}\n`;
}
