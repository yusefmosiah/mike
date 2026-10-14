import { describe, expect, it } from "vitest";
import { branchPath, collectAsks, defaultLeaf, extractThread } from "./extract.mts";
import type { ChatMessageRow } from "./types.mts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 11, 20, minute)).toISOString();

function row(id: string, parent: string | null, role: "user" | "assistant", minute: number, content: ChatMessageRow["content"], extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
    return { id, parent_message_id: parent, role, content, files: null, workflow: null, created_at: at(minute), ...extra };
}

// u1 -> a1 -> u2 -> a2 -> u3a -> a3a      (abandoned branch, older)
//                       \-> u3b -> a3b -> u4 -> a4   (the branch touched last)
const rows: ChatMessageRow[] = [
    row("u1", null, "user", 0, "https://youtu.be/x"),
    row("a1", "u1", "assistant", 0, [{ type: "content", text: "Transcript saved." }, { type: "turn_usage", input: 100, output: 10, cost: 0.01 }]),
    row("u2", "a1", "user", 5, "Review this", { files: [{ filename: "pack.docx", document_id: "d1", version_id: "v1", version_number: 1 }] }),
    row("a2", "u2", "assistant", 5, [
        { type: "code_cell", call_id: "c1", code: "1/0", status: "ok", output: "Traceback (most recent call last):\nZeroDivisionError: division by zero" },
        { type: "code_cell", call_id: "c2", code: "x", status: "failed" },
        { type: "content", text: "Done." },
    ]),
    row("u3a", "a2", "user", 10, "English tea"),
    row("a3a", "u3a", "assistant", 10, [{ type: "content", text: "..." }]),
    row("u3b", "a2", "user", 11, "English translation. Stay in English"),
    row("a3b", "u3b", "assistant", 11, [
        { type: "ask_inputs", event_id: "e1", items: [{ id: "q1", kind: "choice", question: "Format?", options: [{ value: "Doc" }, { value: "Memo" }], allow_other: true, other_label: "Other" }] },
        { type: "ask_inputs_response", assistant_message_id: "a3b", ask_event_id: "e1", responses: [{ id: "q1", kind: "choice", question: "Format?", answer: "Memo" }] },
        { type: "content", text: "Here is the memo." },
    ]),
    row("u4", "a3b", "user", 20, "Thanks"),
    row("a4", "u4", "assistant", 20, [{ type: "error", message: "The response could not be completed." }]),
];

describe("branch extraction", () => {
    it("defaults to the newest unanswered message", () => {
        expect(defaultLeaf(rows).id).toBe("a4");
    });

    it("follows parent_message_id from the leaf back to the root", () => {
        expect(branchPath(rows).map((r) => r.id)).toEqual(["u1", "a1", "u2", "a2", "u3b", "a3b", "u4", "a4"]);
        expect(branchPath(rows, "a3a").map((r) => r.id)).toEqual(["u1", "a1", "u2", "a2", "u3a", "a3a"]);
    });

    it("rejects an unknown leaf, a missing parent and a cycle", () => {
        expect(() => branchPath(rows, "nope")).toThrow(/not in the export/);
        expect(() => branchPath([row("x", "gone", "user", 0, "hi")], "x")).toThrow(/not in the export/);
        expect(() => branchPath([row("p", "q", "user", 0, "a"), row("q", "p", "assistant", 1, [])], "p")).toThrow(/cycle/);
    });

    it("pairs each ask_inputs with the response recorded for it", () => {
        const asks = collectAsks([rows.find((r) => r.id === "a3b")!]);
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ assistantMessageId: "a3b", eventId: "e1", responses: [{ answer: "Memo" }] });
        expect(collectAsks([row("z", null, "assistant", 0, [{ type: "ask_inputs", event_id: "e9", items: [] }])])[0]!.responses).toBeNull();
    });

    it("produces ordered turns with attachments, asks and original metrics", () => {
        const thread = extractThread(rows, { source: "msgs.json" });
        expect(thread.leafId).toBe("a4");
        expect(thread.t0).toBe(at(0));
        expect(thread.offPathMessages).toBe(2);
        expect(thread.turns.map((t) => t.content)).toEqual([
            "https://youtu.be/x",
            "Review this",
            "English translation. Stay in English",
            "Thanks",
        ]);
        const [t1, t2, t3, t4] = thread.turns;
        expect(t1!.metrics.usage).toEqual({ input: 100, output: 10, cost: 0.01, parts: 1 });
        expect(t1!.metrics.calls).toBeNull();
        expect(t2!.files).toEqual([{ filename: "pack.docx", document_id: "d1", version_id: "v1", version_number: 1 }]);
        expect(t2!.metrics.tools).toMatchObject({ codeCells: 2, codeCellsFailed: 1, codeCellsErrorOutput: 1 });
        expect(t3!.asks).toHaveLength(1);
        expect(t3!.answer).toBe("Here is the memo.");
        expect(t4!.metrics.errors).toEqual(["The response could not be completed."]);
        expect(t4!.answer).toBe("");
    });

    it("splits model calls by turn and leaves out the abandoned branch's calls", () => {
        const ms = (minute: number, second = 0) => Date.parse(at(minute)) + second * 1000;
        const call = (id: number, t: number, input: number, extra: Record<string, unknown> = {}) => ({
            id,
            conv: 1,
            r: { id, kind: "pi.assistant", conversationId: 1, model: [{ role: "assistant", model: "m1", timestamp: t, durationMs: 2000, usage: { input, output: 5, cacheRead: 50, reasoning: 1, cost: { total: 0.001 } }, stopReason: "toolUse", ...extra }] },
        });
        const entries = [
            call(1, ms(0, 1), 10),
            call(2, ms(0, 10), 20),
            call(3, ms(5, 1), 30),
            { id: 4, conv: 1, r: { id: 4, kind: "pi.compaction", conversationId: 1, model: "[]" } },
            call(5, ms(10, 5), 999), // "English tea", off the path
            call(6, ms(11, 3), 40),
            call(7, ms(20, 1), 50),
        ];
        return import("./metrics.mts").then(({ normalizeEntries }) => {
            const thread = extractThread(rows, { source: "m", entries: normalizeEntries(entries) });
            const calls = thread.turns.map((t) => t.metrics.calls!);
            expect(calls.map((c) => c.modelCalls)).toEqual([2, 1, 1, 1]);
            expect(calls.map((c) => c.input)).toEqual([30, 30, 40, 50]);
            expect(calls[1]!.compactions).toBe(1);
            expect(calls[0]).toMatchObject({ cacheRead: 100, reasoning: 2, models: ["m1"], stopReasons: { toolUse: 2 } });
            // Prompt at 20:00:00, last call ends at 20:00:12.
            expect(thread.turns[0]!.metrics.wallMs).toBe(12_000);
        });
    });
});
