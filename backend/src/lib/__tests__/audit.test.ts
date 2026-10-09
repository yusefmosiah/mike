import { describe, it, expect } from "vitest";
import { chatTurnAuditEvents, recordChatTurn } from "../audit";

type Insert = Record<string, unknown>;

/**
 * Minimal database mock that captures every audit_events insert so tests can
 * assert on the exact rows recordChatTurn mines from a turn's events.
 */
function makeDb() {
    const inserts: Insert[] = [];
    const db = {
        from(_table: string) {
            return {
                insert(row: Insert) {
                    inserts.push(row);
                    return Promise.resolve({ error: null });
                },
            };
        },
    };
    return { db: db as any, inserts };
}

const base = {
    userId: "u1",
    userEmail: "u1@example.com",
    chatId: "chat1",
    projectId: null,
    title: "My chat",
    model: "claude-x",
};

describe("recordChatTurn attested receipts", () => {
    it("fans drained receipts into content-free inference.attested rows", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [], [
            {
                id: "receipt-1",
                at: "2026-10-07T12:00:00.000Z",
                endpointId: "endpoint-1",
                modelId: "dgx-attested",
                measurement: "measurement-1",
                verifierVersion: "v3",
                requestId: "request-1",
            },
        ]);

        expect(inserts.map((r) => r.action)).toEqual([
            "chat.message",
            "inference.attested",
        ]);
        // Identity fields only: no prompt, response, or system text may
        // ever ride a receipt row.
        expect(inserts[1]).toMatchObject({
            model: "dgx-attested",
            detail: {
                receipt_id: "receipt-1",
                endpoint_id: "endpoint-1",
                measurement: "measurement-1",
                verifier_version: "v3",
                request_id: "request-1",
            },
        });
        expect(Object.keys(inserts[1].detail)).toHaveLength(6);
    });

    it("emits no receipt rows when the turn produced none", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, []);

        expect(inserts.map((r) => r.action)).toEqual(["chat.message"]);
    });
});

describe("recordChatTurn artifact mining", () => {
    it("records a chat.message row plus mined artifact rows", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            { type: "doc_created", filename: "brief.docx", document_id: "d1" },
            { type: "doc_edited", filename: "memo.docx", document_id: "d2" },
            { type: "workflow_applied", workflow_id: "wf1", title: "Cleanup" },
        ]);

        expect(inserts.map((r) => r.action)).toEqual([
            "chat.message",
            "document.generated",
            "document.edited",
            "workflow.applied",
        ]);
        expect(inserts[1]).toMatchObject({ title: "brief.docx", document_id: "d1" });
        expect(inserts[3]).toMatchObject({
            action: "workflow.applied",
            detail: { workflow_id: "wf1" },
        });
    });

    it("mines doc_replicated from its copies, not the source filename/id", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            {
                type: "doc_replicated",
                filename: "source-template.docx", // the SOURCE, not a produced copy
                count: 2,
                copies: [
                    { new_filename: "copy-a.docx", document_id: "da", version_id: "va" },
                    { new_filename: "copy-b.docx", document_id: "db", version_id: "vb" },
                ],
            },
        ]);

        // chat.message + one document.generated per copy.
        const artifacts = inserts.filter((r) => r.action === "document.generated");
        expect(artifacts).toHaveLength(2);
        expect(artifacts.map((r) => r.title)).toEqual(["copy-a.docx", "copy-b.docx"]);
        expect(artifacts.map((r) => r.document_id)).toEqual(["da", "db"]);
        // The source filename must never leak in as a title, and the (absent)
        // top-level document_id must never produce a null-id row.
        expect(inserts.some((r) => r.title === "source-template.docx")).toBe(false);
    });

    it("emits no artifact rows for a doc_replicated with empty copies", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            { type: "doc_replicated", filename: "src.docx", count: 0, copies: [] },
        ]);
        expect(inserts.map((r) => r.action)).toEqual(["chat.message"]);
    });
});

describe("chatTurnAuditEvents surface", () => {
    it("derives assistant/project from projectId when no surface is given", () => {
        expect(chatTurnAuditEvents(base, [])[0].surface).toBe("assistant");
        expect(
            chatTurnAuditEvents({ ...base, projectId: "p1" }, [])[0].surface,
        ).toBe("project");
    });

    it("lets an explicit surface override the derivation, on every row", () => {
        const rows = chatTurnAuditEvents({ ...base, surface: "word" }, [
            { type: "doc_created", filename: "brief.docx", document_id: "d1" },
        ]);
        // Both the chat.message row and the mined artifact row must carry it,
        // or the history feed would show a Word turn with an assistant
        // artifact hanging off it.
        expect(rows.map((r) => r.surface)).toEqual(["word", "word"]);
    });

    it("wins over projectId rather than being overridden by it", () => {
        const rows = chatTurnAuditEvents(
            { ...base, projectId: "p1", surface: "word" },
            [],
        );
        expect(rows[0].surface).toBe("word");
        expect(rows[0].projectId).toBe("p1");
    });
});

describe("chatTurnAuditEvents subagents", () => {
    const subagent = {
        type: "subagent",
        call_id: "call-1",
        child_id: "7",
        address: "turn/a1/document_review-1",
        agent_type: "document_review",
        model: "opencode-go/glm-5",
        task: "Find the governing law",
        status: "done",
        usage: { input: 1200, output: 300, cost: 0.004 },
    };

    it("records each child on its own model, with what it spent", () => {
        const rows = chatTurnAuditEvents(base, [subagent]);
        expect(rows[1]).toEqual({
            userId: "u1",
            userEmail: "u1@example.com",
            action: "subagent.run",
            status: "completed",
            title: "document_review",
            surface: "assistant",
            projectId: null,
            chatId: "chat1",
            model: "opencode-go/glm-5",
            detail: {
                child_id: "7",
                address: "turn/a1/document_review-1",
                outcome: "done",
                input_tokens: 1200,
                output_tokens: 300,
                cost_usd: 0.004,
            },
        });
        // The task is the user's matter: the audit row never copies it.
        expect(JSON.stringify(rows[1])).not.toContain("governing law");
    });

    it.each([
        ["stopped", "cancelled"],
        ["running", "cancelled"],
        ["failed", "failed"],
        ["timed_out", "failed"],
    ])("maps a child that ended %s to %s", (status, expected) => {
        const rows = chatTurnAuditEvents(base, [{ ...subagent, status, usage: undefined }]);
        expect(rows[1].status).toBe(expected);
        expect(rows[1].detail).toMatchObject({ outcome: status, cost_usd: null });
    });
});

describe("chatTurnAuditEvents turn usage", () => {
    it("puts the turn's own spend on its chat.message row, beside any flags", () => {
        const rows = chatTurnAuditEvents({ ...base, flags: { auto_mode: true } }, [
            { type: "turn_usage", input: 5000, output: 700, cost: 0.012 },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].detail).toEqual({
            auto_mode: true,
            input_tokens: 5000,
            output_tokens: 700,
            cost_usd: 0.012,
        });
    });

    it("leaves the detail empty for a turn with neither flags nor usage", () => {
        expect(chatTurnAuditEvents(base, [])[0].detail).toBeNull();
    });
});
