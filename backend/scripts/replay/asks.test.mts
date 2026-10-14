import { describe, expect, it } from "vitest";
import { askResponseContent, mapAskResponse, mapItem, pendingAsk } from "./asks.mts";
import type { AskInputItem, OriginalAsk } from "./types.mts";

const choice = (id: string, options: string[], allowOther = false): AskInputItem => ({
    id,
    kind: "choice",
    question: `Pick ${id}`,
    options: options.map((value) => ({ value })),
    allow_other: allowOther,
    other_label: "Other",
});

describe("ask_inputs mapping", () => {
    it("keeps a choice answer that is still an option, matching case-insensitively", () => {
        expect(mapItem(choice("a", ["Memo", "Doc"]), { id: "x", kind: "choice", question: "old", answer: "memo" })).toEqual({
            id: "a",
            kind: "choice",
            question: "Pick a",
            answer: "Memo",
        });
    });

    it("sends a vanished choice as 'other' only where the item allows it", () => {
        const original = { id: "x", kind: "choice" as const, question: "old", answer: "Slides" };
        expect(mapItem(choice("a", ["Memo"], true), original)).toMatchObject({ answer: "Slides" });
        expect(mapItem(choice("a", ["Memo"], false), original)).toMatchObject({ skipped: true });
    });

    it("skips on a kind mismatch, a skipped original, or no original", () => {
        const text: AskInputItem = { id: "t", kind: "text", question: "Why?" };
        expect(mapItem(text, { id: "x", kind: "choice", question: "q", answer: "A" })).toEqual({ id: "t", kind: "text", question: "Why?", skipped: true });
        expect(mapItem(text, { id: "x", kind: "text", question: "q", skipped: true })).toMatchObject({ skipped: true });
        expect(mapItem(text, undefined)).toMatchObject({ skipped: true });
        expect(mapItem(text, { id: "x", kind: "text", question: "q", answer: "Because" })).toMatchObject({ answer: "Because" });
    });

    it("filters multi-choice answers to the new options", () => {
        const item: AskInputItem = { id: "m", kind: "multi_choice", question: "Which?", options: [{ value: "A" }, { value: "B" }], allow_other: false, other_label: "Other" };
        expect(mapItem(item, { id: "x", kind: "multi_choice", question: "q", answers: ["a", "C"] })).toMatchObject({ answers: ["A"] });
        expect(mapItem(item, { id: "x", kind: "multi_choice", question: "q", answers: ["C"] })).toMatchObject({ skipped: true });
    });

    it("attaches documents only when every file was seeded, and never approves by default", () => {
        const docs: AskInputItem = { id: "d", kind: "documents", document_types: ["docx"] };
        const original = { id: "x", kind: "documents" as const, filenames: ["a.docx"] };
        expect(mapItem(docs, original, new Set(["a.docx"]))).toEqual({ id: "d", kind: "documents", filenames: ["a.docx"] });
        expect(mapItem(docs, original, new Set())).toMatchObject({ skipped: true, filenames: [] });
        const approval = { id: "p", kind: "approval", connector_name: "c", tool_name: "t", title: "Send", arguments: {}, binding: { type: "mcp", connector_id: "c", tool_id: "t" } } as AskInputItem;
        expect(mapItem(approval, undefined)).toEqual({ id: "p", kind: "approval", decision: "reject" });
        expect(mapItem(approval, { id: "x", kind: "approval", decision: "approve" })).toEqual({ id: "p", kind: "approval", decision: "approve" });
    });

    it("maps by position and skips everything without an answered original", () => {
        const items = [choice("n1", ["Yes", "No"]), choice("n2", ["Left", "Right"])];
        const original: OriginalAsk = {
            assistantMessageId: "m",
            eventId: "e",
            items: [choice("o1", ["Yes", "No"]), choice("o2", ["Left", "Right"])],
            responses: [
                { id: "o1", kind: "choice", question: "Pick o1", answer: "No" },
                { id: "o2", kind: "choice", question: "Pick o2", skipped: true },
            ],
        };
        const mapped = mapAskResponse(items, original);
        expect(mapped.mappedFrom).toBe("original");
        expect(mapped.responses.map((r) => ("answer" in r ? r.answer : "skipped" in r && r.skipped ? "-" : "?"))).toEqual(["No", "-"]);
        expect(mapAskResponse(items, undefined)).toEqual({
            mappedFrom: "skipped",
            responses: [
                { id: "n1", kind: "choice", question: "Pick n1", skipped: true },
                { id: "n2", kind: "choice", question: "Pick n2", skipped: true },
            ],
        });
        expect(mapAskResponse(items, { ...original, responses: null }).mappedFrom).toBe("skipped");
        // More new items than original answers: the extra ones are skipped.
        expect(mapAskResponse([...items, choice("n3", ["x", "y"])], original).responses[2]).toMatchObject({ skipped: true });
    });

    it("writes the same user text as the web app's prompt", () => {
        const items = [choice("a", ["Memo"])];
        expect(askResponseContent(items, [{ id: "a", kind: "choice", question: "Format?", answer: "Memo" }, { id: "b", kind: "text", question: "Why?", skipped: true }])).toBe(
            "Responses to your questions:\n1. Format?\nMemo\n\n2. Skipped: Why?",
        );
        expect(askResponseContent([], [{ id: "p", kind: "approval", decision: "reject" }])).toBe(
            "Decisions on the requested actions:\n1. Rejected: Connector action",
        );
    });

    it("finds the last unanswered pause", () => {
        const ask = { type: "ask_inputs" as const, event_id: "e1", items: [] };
        expect(pendingAsk([{ type: "content", text: "hi" }, ask])).toBe(ask);
        expect(pendingAsk([ask, { type: "ask_inputs_response", assistant_message_id: "m", ask_event_id: "e1", responses: [] }])).toBeNull();
        expect(pendingAsk([{ type: "content", text: "hi" }])).toBeNull();
    });
});
