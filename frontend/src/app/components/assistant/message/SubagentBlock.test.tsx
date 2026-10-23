import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantEvent } from "@/app/components/shared/types";
import type { SubagentTranscript } from "@/app/lib/mikeApi";
import { delegatedTurnCost, SubagentBlock } from "./SubagentBlock";

const event: Extract<AssistantEvent, { type: "subagent" }> = {
    type: "subagent",
    call_id: "call-1",
    child_id: "7",
    address: "turn/a1/document_review-1",
    agent_type: "document_review",
    model: "opencode-go/a-model-with-an-unusually-long-identifier-that-must-wrap",
    task: "Find the governing law",
    status: "done",
    report_preview: "Governed by Delaware law.",
    usage: { input: 1200, output: 300, cost: 0.004 },
};

const transcript: SubagentTranscript = {
    childId: "7",
    chatKey: "chat-1",
    turnKey: "a1",
    callId: "call-1",
    address: "turn/a1/document_review-1",
    type: "document_review",
    model: event.model,
    status: "done",
    startedAt: 1,
    finishedAt: 2,
    usage: event.usage!,
    envelopes: [],
    entries: [
        { kind: "task", text: "Find the governing law" },
        { kind: "assistant", text: "", toolCalls: [{ name: "read_document", input: { doc_id: "doc-0" } }] },
        { kind: "tool_result", name: "read_document", text: "Clause 12: Delaware.", isError: false },
        { kind: "assistant", text: "Governed by Delaware law (clause 12).", toolCalls: [] },
    ],
};

const toggle = () => screen.getByRole("button", { name: /Document review subagent/ });

describe("SubagentBlock", () => {
    it("shows what was delegated, on which model, and what it cost, closed", () => {
        render(<SubagentBlock event={event} />);
        expect(toggle()).toHaveAttribute("aria-expanded", "false");
        // A long model id wraps rather than being cut off.
        expect(screen.getByText(event.model)).toHaveClass("break-words");
        expect(screen.getByText("Done · 1,500 tokens · under $0.01")).toBeInTheDocument();
        expect(screen.queryByText("Find the governing law")).not.toBeInTheDocument();
    });

    it("loads the child's steps and report when opened", async () => {
        const load = vi.fn(async () => transcript);
        render(<SubagentBlock event={event} onLoadTranscript={load} />);
        fireEvent.click(toggle());

        expect(toggle()).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("status", { name: "Loading the subagent's work" })).toBeInTheDocument();
        expect(await screen.findByText("Governed by Delaware law (clause 12).")).toBeInTheDocument();
        expect(load).toHaveBeenCalledWith("7");
        expect(screen.getByText("Find the governing law")).toBeInTheDocument();
        expect(screen.getByText("Called read_document")).toBeInTheDocument();
        expect(screen.getByText("Result of read_document")).toBeInTheDocument();
        expect(screen.getByText("Report")).toBeInTheDocument();
    });

    it("says so, without the server's words, when the work cannot be loaded", async () => {
        const load = vi.fn(async () => {
            throw new Error("relation pi_conversations does not exist");
        });
        render(<SubagentBlock event={event} onLoadTranscript={load} />);
        fireEvent.click(toggle());
        expect(await screen.findByText("The subagent's work could not be loaded.")).toBeInTheDocument();
        expect(screen.queryByText(/pi_conversations/)).not.toBeInTheDocument();
    });

    it("loads again when a child it is showing finishes", async () => {
        const load = vi.fn(async () => transcript);
        const running = { ...event, status: "running" as const, usage: undefined };
        const { rerender } = render(<SubagentBlock event={running} onLoadTranscript={load} />);
        expect(screen.getByText("Working")).toBeInTheDocument();
        fireEvent.click(toggle());
        await screen.findByText("Called read_document");
        rerender(<SubagentBlock event={event} onLoadTranscript={load} />);
        await screen.findByText("Called read_document");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("without a loader, opens to the task and the start of the report", () => {
        render(<SubagentBlock event={{ ...event, status: "timed_out" }} />);
        expect(screen.getByText(/^Ran out of time/)).toBeInTheDocument();
        fireEvent.click(toggle());
        expect(screen.getByText("Find the governing law")).toBeInTheDocument();
        expect(screen.getByText("Governed by Delaware law.")).toBeInTheDocument();
    });
});

describe("SubagentBlock in the background", () => {
    it("names the subagent and says its report will arrive in the chat while it works", () => {
        render(
            <SubagentBlock
                event={{ ...event, status: "running", usage: undefined, background: true, name: "research-1" }}
            />,
        );
        expect(
            screen.getByRole("button", { name: /research-1 · Document review subagent/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/In the background · its report will arrive in the chat when it finishes/),
        ).toBeInTheDocument();
    });

    it("says it ran in the background once it has ended", () => {
        render(<SubagentBlock event={{ ...event, background: true, name: "research-1" }} />);
        expect(screen.getByText("In the background · Done · 1,500 tokens · under $0.01")).toBeInTheDocument();
    });

    it("shows nothing extra for an ordinary subagent", () => {
        render(<SubagentBlock event={event} />);
        expect(screen.queryByText(/In the background/)).not.toBeInTheDocument();
    });

    it("shows work given to it after its task in the transcript", async () => {
        const withMessage: SubagentTranscript = {
            ...transcript,
            background: true,
            name: "research-1",
            entries: [
                { kind: "task", text: "Find the governing law" },
                { kind: "assistant", text: "First pass done.", toolCalls: [] },
                { kind: "message", text: "Now check the exhibits too." },
                { kind: "assistant", text: "Exhibits agree.", toolCalls: [] },
            ],
        };
        render(<SubagentBlock event={event} onLoadTranscript={async () => withMessage} />);
        fireEvent.click(toggle());
        expect(await screen.findByText("Now check the exhibits too.")).toBeInTheDocument();
        expect(screen.getByText("Message")).toBeInTheDocument();
        expect(screen.getByText("Exhibits agree.")).toBeInTheDocument();
    });
});

describe("delegatedTurnCost", () => {
    const own = { type: "turn_usage" as const, input: 5000, output: 700, cost: 0.0123 };

    it("adds the answer's own spend to its subagents' together", () => {
        expect(
            delegatedTurnCost([
                own,
                event,
                { ...event, child_id: "8", usage: { input: 800, output: 200, cost: 0.02 } },
            ]),
        ).toBe("This answer: 5,700 tokens · $0.01. 2 subagents: 2,500 tokens · $0.02.");
    });

    it("counts a subagent that ended without usage as nothing spent", () => {
        expect(delegatedTurnCost([own, { ...event, usage: undefined }])).toBe(
            "This answer: 5,700 tokens · $0.01. 1 subagent: 0 tokens.",
        );
    });

    it("leaves out a background subagent that was still working when the answer ended", () => {
        const background = { ...event, child_id: "9", background: true, name: "general-1", status: "running" as const, usage: undefined };
        expect(delegatedTurnCost([own, background])).toBeNull();
        expect(delegatedTurnCost([own, event, background])).toBe(
            "This answer: 5,700 tokens · $0.01. 1 subagent: 1,500 tokens · under $0.01.",
        );
    });

    it("shows nothing for an answer that delegated nothing, or before its own usage is known", () => {
        expect(delegatedTurnCost([own])).toBeNull();
        expect(delegatedTurnCost([event])).toBeNull();
        expect(delegatedTurnCost(undefined)).toBeNull();
    });
});

describe("SubagentBlock label", () => {
    it.each([
        ["general", "General subagent"],
        ["citation_check", "Citation check subagent"],
    ])("names a %s child by its type", (agentType, label) => {
        render(<SubagentBlock event={{ ...event, agent_type: agentType }} />);
        expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    });
});
