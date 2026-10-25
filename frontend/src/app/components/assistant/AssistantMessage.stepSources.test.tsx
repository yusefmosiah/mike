import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

// Each code cell is one step: its summary on the line, and under it the
// sources its calls touched, instead of a separate line per call.

describe("AssistantMessage step sources", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    const events: AssistantEvent[] = [
        {
            type: "code_cell",
            call_id: "c1",
            code: "lease = docs[0]",
            status: "ok",
            tool_calls: 2,
            summary: { text: "Read the lease and searched for case law on break clauses", source: "model" },
        },
        { type: "doc_read", filename: "lease.docx", document_id: "d1", call_id: "c1.docs" },
        {
            type: "web_search",
            call_id: "c1.1",
            query: "break clause notice",
            results: [
                { url: "https://law.example/break", title: "Break clauses explained" },
                { url: "javascript:alert(1)", title: "Not a link" },
            ],
        },
        { type: "web_fetch", call_id: "c1.2", url: "https://law.example/break", title: "Break clauses explained" },
        { type: "content", text: "The notice period is six months." },
    ];

    it("shows the cell's summary and its sources under it, as one step", () => {
        render(<AssistantMessage events={events} />);
        const run = screen.getByRole("button", { name: /Completed in 1 step/ });
        expect(run).toHaveTextContent("Completed in 1 step · 1 document, 1 web page, 1 web search");
        fireEvent.click(run);

        const step = screen.getByRole("button", { name: /Read the lease and searched for case law/ });
        expect(step).toHaveAttribute("aria-expanded", "false");
        const sources = screen.getByRole("group", { name: "Sources this step used" });
        expect(within(sources).getByText("lease.docx")).toBeInTheDocument();
        expect(within(sources).getByText(/break clause notice/)).toBeInTheDocument();
        expect(within(sources).getByRole("link", { name: "Break clauses explained" })).toHaveAttribute(
            "href",
            "https://law.example/break",
        );
    });

    it("never links a result whose address is not a web page", () => {
        render(<AssistantMessage events={events} />);
        fireEvent.click(screen.getByRole("button", { name: /Completed in 1 step/ }));
        fireEvent.click(screen.getByRole("button", { name: /Searched the web/ }));
        expect(screen.getByText("Not a link").closest("a")).toBeNull();
    });

    it("falls back to the plain label for a cell without a summary", () => {
        render(<AssistantMessage events={[{ type: "code_cell", call_id: "c9", code: "1+1", status: "ok" }]} />);
        expect(screen.getByRole("button", { name: /Computed/ })).toBeInTheDocument();
    });
});
