import { describe, expect, it } from "vitest";
import {
    askInputIssues,
    callMetricsByWindow,
    chatConversationIds,
    duplicateSections,
    metricsFromParts,
    parseConversationIds,
} from "./metrics.mts";
import { buildReport, diffTotals, renderMarkdown, totalsOf } from "./report.mts";
import type { AskInputItem, ExtractedThread, ReplayTurnRecord, TurnMetrics } from "./types.mts";

describe("part metrics", () => {
    it("sums usage across continuations and counts tool outcomes", () => {
        const m = metricsFromParts([
            { type: "turn_usage", input: 10, output: 2, cost: 0.1 },
            { type: "turn_usage", input: 5, output: 1, cost: 0.2 },
            { type: "subagent", call_id: "s", child_id: "c", address: "a", agent_type: "t", model: "m", task: "x", status: "timed_out" },
            { type: "mcp_tool_call", connector_id: "c", connector_name: "n", tool_name: "t", openai_tool_name: "o", status: "error" },
            { type: "code_cell", call_id: "1", code: "", status: "ok", output: 'ValueError: bad' },
            { type: "code_cell", call_id: "2", code: "", status: "ok", output: "fine" },
            { type: "content", text: "abc" },
            { type: "reasoning", text: "hmm" },
        ]);
        expect(m.usage).toEqual({ input: 15, output: 3, cost: 0.3, parts: 2 });
        expect(m.tools).toMatchObject({ subagents: 1, subagentsFailed: 1, mcpCalls: 1, mcpErrors: 1, codeCells: 2, codeCellsErrorOutput: 1 });
        expect(m.answerChars).toBe(3);
        expect(m.reasoningChars).toBe(3);
    });
});

describe("answer checks", () => {
    it("finds repeated headings and paragraphs, not code", () => {
        const para = "This paragraph is long enough to count as a section of the document and it appears twice in the answer, which is the bug.";
        const text = `# Plan\n\n${para}\n\n## Risks\n\n${para}\n\n# plan\n\n\`\`\`\n# Plan\n# Plan\n\`\`\``;
        const d = duplicateSections(text);
        expect(d.headings).toEqual(["plan (x2)"]);
        expect(d.paragraphs).toHaveLength(1);
        expect(duplicateSections("# A\n\n# B")).toEqual({ headings: [], paragraphs: [] });
    });

    it("flags the degenerate ask_inputs the original thread produced", () => {
        const item = (n: number): AskInputItem => ({ id: `choice-${n}`, kind: "choice", options: [{ value: "Continue" }], question: "Please choose an option.", allow_other: true, other_label: "Other" });
        const issues = askInputIssues([1, 2, 3, 4, 5].map(item));
        expect(issues).toContain('item 1: generic question "Please choose an option."');
        expect(issues).toContain("item 1: 1 option(s); nothing to choose between");
        expect(issues.some((i) => i.startsWith("5 identical items"))).toBe(true);
        expect(askInputIssues([])).toEqual(["no items"]);
        expect(askInputIssues([{ id: "a", kind: "choice", question: "Which format?", options: [{ value: "Memo" }, { value: "Doc" }], allow_other: false, other_label: "" }])).toEqual([]);
    });
});

describe("conversation lineage", () => {
    it("adds subagent conversations owned by the lineage, transitively", () => {
        const convs = [
            { id: 1, r: { id: 1 } },
            { id: 2, r: { id: 2, owner: { taskId: 9, conversationId: 1 } } },
            { id: 3, r: { id: 3, owner: { taskId: 8, conversationId: 2 } } },
            { id: 4, r: { id: 4, owner: { taskId: 7, conversationId: 99 } } },
        ];
        expect([...chatConversationIds([1], convs)].sort()).toEqual([1, 2, 3]);
    });

    it("reads ids from a comma list or a lineage document", () => {
        expect(parseConversationIds("985, 1226", () => "")).toEqual([985, 1226]);
        const doc = JSON.stringify([{ record: JSON.stringify({ value: { conversations: [985, 1500], messages: {} } }) }]);
        expect(parseConversationIds("lineage.json", () => doc)).toEqual([985, 1500]);
        expect(() => parseConversationIds("x.json", () => "{}")).toThrow(/no conversation ids/);
    });
});

describe("metrics diff", () => {
    const metrics = (over: Partial<TurnMetrics>): TurnMetrics => ({
        ...metricsFromParts([]),
        ...over,
    });

    it("totals a side and diffs replay minus original, null where unmeasured", () => {
        const calls = { modelCalls: 3, subagentCalls: 0, models: ["m"], input: 100, cacheRead: 50, cacheWrite: 0, output: 10, reasoning: 5, cost: 0.5, compactions: 1, modelMs: 900, stopReasons: {} };
        const side = (m: TurnMetrics) => ({ present: true, status: "ok" as const, metrics: m, empty: false, answerScript: null, reasoningScript: null, duplicates: { headings: [], paragraphs: [] }, askIssues: [] });
        const original = totalsOf([side(metrics({ wallMs: 1000, calls })), side(metrics({ wallMs: 500, calls }))]);
        const replay = totalsOf([side(metrics({ wallMs: 300, calls: { ...calls, modelCalls: 1, compactions: 0 } })), side(metrics({ wallMs: null, calls: null }))]);
        expect(original.wallMs).toBe(1500);
        expect(original.calls?.modelCalls).toBe(6);
        expect(replay.wallMs).toBeNull();
        expect(replay.calls).toBeNull();
        const delta = diffTotals(original, replay);
        expect(delta.wallMs).toBeNull();
        expect(delta["calls.modelCalls"]).toBeNull();
        expect(delta.turns).toBe(0);
        expect(delta["usage.input"]).toBe(0);
    });

    it("builds a report that flags the replay's regressions", () => {
        const base = metricsFromParts([{ type: "content", text: "Fine answer in English." }]);
        const thread: ExtractedThread = {
            format: "mike-replay-thread/1",
            source: "msgs.json",
            leafId: "l",
            t0: "2026-10-11T19:52:37Z",
            t1: "2026-10-11T20:52:37Z",
            offPathMessages: 0,
            model: null,
            turns: [1, 2, 3].map((index) => ({
                index,
                messageId: `u${index}`,
                createdAt: "2026-10-11T19:52:37Z",
                content: "Please review the argument in English.",
                files: [],
                workflow: null,
                assistantMessageId: `a${index}`,
                asks: [],
                answer: "Fine answer in English.",
                reasoning: "",
                metrics: { ...base, wallMs: 1000 },
            })),
        };
        const record = (index: number, content: ReplayTurnRecord["assistantMessages"][number]["content"], status: "ok" | "failed" = "ok", errors: string[] = []): ReplayTurnRecord => ({
            format: "mike-replay-turn/1",
            index,
            prompt: "",
            status,
            startedAt: "",
            endedAt: "",
            wallMs: 2000,
            attempts: [{ kind: "prompt", startedAt: "", endedAt: "", httpStatus: 200, chatId: "c", turnId: "t", assistantMessageId: "a", userMessageId: "u", framesFile: "f", frameCount: 1, errors, reconnects: 0 }],
            asks: [],
            droppedFiles: [],
            assistantMessages: [{ id: `r${index}`, content }],
        });
        const report = buildReport({
            thread,
            replay: [
                record(1, [{ type: "content", text: "用户正在利用一名 AI 助手作为批评性思维伙伴和分析引擎。" }]),
                record(2, [], "failed", ["stream error: boom"]),
            ],
            run: { chatId: "c", model: "m", reasoning: "high" },
        });
        expect(report.totals.original.turns).toBe(2);
        expect(report.totals.replay.turns).toBe(2);
        expect(report.totals.replay.failedTurns).toBe(1);
        expect(report.totals.replay.scriptMismatches).toBe(1);
        expect(report.turns[2]!.replay.status).toBe("not run");
        expect(report.findings.join("\n")).toMatch(/turn 1 replay: answer script cjk/);
        expect(report.findings.join("\n")).toMatch(/turn 2 replay: failed \(stream error: boom\)/);
        expect(report.findings.join("\n")).toMatch(/turn 2 replay: empty answer/);
        const md = renderMarkdown(report);
        expect(md).toContain("| Failed turns | 0 | 1 |");
        expect(md).toContain("not run");
    });
});

describe("model calls by turn window", () => {
    it("counts a background compaction that finished after its turn ended", () => {
        const call = (id: number, timestamp: number) => ({
            id,
            conversationId: 1,
            kind: "pi.assistant",
            model: [{ role: "assistant", timestamp, usage: { input: 10 } }],
        });
        const { metrics } = callMetricsByWindow(
            [
                call(1, 150),
                // No timestamp of its own: it takes the last call's, then runs past the turn's end.
                { id: 2, conversationId: 1, kind: "pi.compaction", model: [{ role: "user" }] },
                { id: 3, conversationId: 1, kind: "pi.compaction", model: [{ role: "user", timestamp: 260 }] },
                call(4, 320),
            ],
            [
                { start: 100, end: 200 },
                { start: 300, end: 400 },
            ],
        );
        expect(metrics.map((m) => [m.modelCalls, m.compactions])).toEqual([
            [1, 2],
            [1, 0],
        ]);
    });
});
