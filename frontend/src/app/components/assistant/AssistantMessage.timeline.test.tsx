import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

const approvalRequest: AssistantEvent = {
    type: "ask_inputs",
    event_id: "ask-1",
    items: [
        {
            id: "approve-1",
            kind: "approval",
            connector_name: "Gmail",
            tool_name: "gmail_send",
            title: "Send email",
            arguments: { to: ["a@example.com"], subject: "Hi", body: "Body" },
            binding: { type: "google", provider: "gmail", grant_id: "g1" },
        },
    ],
};

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
    });
    afterEach(() => vi.unstubAllGlobals());
    it("hides the copy button while it waits for input or approval", () => {
        const { rerender } = render(
            <AssistantMessage events={[approvalRequest]} awaitingInput />,
        );

        // Nothing has been delivered yet, so there is nothing to copy.
        expect(
            screen.queryByRole("button", { name: "Copy response" }),
        ).toBeNull();

        // Once the request is settled the message is an ordinary one again.
        rerender(<AssistantMessage events={[approvalRequest]} />);
        expect(
            screen.getByRole("button", { name: "Copy response" }),
        ).toBeInTheDocument();
    });

    it("folds a run of reasoning events into one thinking block", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("First I check the parties."),
                    reasoning("Then the termination clause."),
                    reasoning("Finally the governing law."),
                ]}
            />,
        );

        // One block, not three stacked on the timeline.
        const toggles = screen.getAllByRole("button", {
            name: /Thought process/,
        });
        expect(toggles).toHaveLength(1);

        // Thinking starts closed; opened, all of it shows.
        expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText(/First I check the parties/)).toBeNull();
        fireEvent.click(toggles[0]);
        expect(screen.getByText(/First I check the parties/)).toBeVisible();
        expect(screen.getByText(/Then the termination clause/)).toBeVisible();
        expect(screen.getByText(/Finally the governing law/)).toBeVisible();
    });

    it("keeps reasoning separated by other work in its own blocks", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("Before the search."),
                    {
                        type: "doc_read",
                        filename: "lease.pdf",
                        document_id: "d1",
                        version_id: "v1",
                        version_number: 1,
                    },
                    reasoning("After the search."),
                ]}
            />,
        );

        expect(
            screen.getAllByRole("button", { name: /Thought process/ }),
        ).toHaveLength(2);
    });

    it("shows a thought's summary on its line, and the run summary under the run's line", () => {
        const long = "Weighing the notice period. ".repeat(20);
        const said = (text: string) => ({ text, source: "side_model" as const });
        render(
            <AssistantMessage
                events={[
                    { type: "reasoning", text: long, id: "reasoning-1", summary: said("Checked notice.") },
                    { type: "reasoning", text: "And the deed.", id: "reasoning-2" },
                    {
                        type: "doc_read",
                        filename: "lease.pdf",
                        document_id: "d1",
                        version_id: "v1",
                        version_number: 1,
                    },
                    { type: "content", text: "They agree." },
                    { type: "run_summary", summary: said("Compared the lease and the deed."), steps: 3 },
                ]}
            />,
        );
        // Visible with the run closed: it is what the reader sees first.
        expect(screen.getByText("Compared the lease and the deed.")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: /Completed in 2 steps/ }));
        // The two thoughts read as one, so their summaries do too.
        const thought = screen.getByRole("button", { name: /Checked notice\.\s+And the deed\./ });
        expect(thought).toBeInTheDocument();
        expect(thought).not.toHaveTextContent(/thought process/i);
        // Opening it shows the full text, with no second level of buttons.
        fireEvent.click(thought);
        expect(thought).toHaveAttribute("aria-expanded", "true");
        expect(screen.queryByRole("button", { name: /show (more|less)|thought process/i })).toBeNull();
    });

    it("leaves the run summary off when the turn has more than one run", () => {
        const read = (filename: string): AssistantEvent => ({
            type: "doc_read",
            filename,
            document_id: filename,
            version_id: "v1",
            version_number: 1,
        });
        render(
            <AssistantMessage
                events={[
                    read("lease.pdf"),
                    { type: "content", text: "First." },
                    read("deed.pdf"),
                    { type: "content", text: "Second." },
                    { type: "run_summary", summary: { text: "Read both.", source: "side_model" }, steps: 3 },
                ]}
            />,
        );
        expect(screen.queryByText("Read both.")).not.toBeInTheDocument();
    });

    it("keeps steps separated only by blank text in one card", () => {
        const read = (filename: string): AssistantEvent => ({
            type: "doc_read",
            filename,
            document_id: filename,
            version_id: "v1",
            version_number: 1,
        });
        render(
            <AssistantMessage
                events={[
                    read("lease.pdf"),
                    { type: "content", text: "\n\n" },
                    read("deed.pdf"),
                    { type: "content", text: " \n" },
                    read("survey.pdf"),
                    { type: "content", text: "All three agree." },
                    read("title.pdf"),
                ]}
            />,
        );

        // Blank chunks between tool calls do not split the run; prose does.
        expect(
            screen.getAllByRole("button", { name: /Completed in/ }).map((b) => b.textContent),
        ).toEqual(["Completed in 3 steps · 3 documents", "Completed in 1 step · 1 document"]);
        expect(screen.getByText("All three agree.")).toBeInTheDocument();
    });

    it("does not mark the response failed when a single tool call fails", () => {
        const { container } = render(
            <AssistantMessage
                events={[
                    {
                        type: "mcp_tool_call",
                        connector_id: "c1",
                        connector_name: "Drive",
                        tool_name: "search",
                        openai_tool_name: "drive_search",
                        status: "error",
                        error: "Connector unavailable",
                    },
                    { type: "content", text: "Here is what I found anyway." },
                ]}
            />,
        );

        // The response is not branded an error…
        expect(
            screen.queryByText("Sorry, something went wrong."),
        ).not.toBeInTheDocument();

        // …while the failed step still reports itself once the steps are open.
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-red-400")).not.toBeNull();
        expect(screen.getByText("Connector unavailable")).toBeInTheDocument();
    });

    it("marks a successful connector call green and a failed one red", () => {
        const call = (status: "ok" | "error"): AssistantEvent => ({
            type: "mcp_tool_call",
            connector_id: "c1",
            connector_name: "Drive",
            tool_name: "search",
            openai_tool_name: "drive_search",
            status,
            ...(status === "error" ? { error: "Connector unavailable" } : {}),
        });
        const { container, unmount } = render(
            <AssistantMessage
                events={[call("ok"), { type: "content", text: "Found it." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step · 1 connector call" }),
        );
        expect(container.querySelector(".bg-green-400")).not.toBeNull();
        expect(container.querySelector(".bg-red-400")).toBeNull();
        expect(container.querySelector(".bg-gray-500")).toBeNull();
        unmount();

        const failed = render(
            <AssistantMessage
                events={[call("error"), { type: "content", text: "Sorry." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(failed.container.querySelector(".bg-red-400")).not.toBeNull();
        expect(failed.container.querySelector(".bg-green-400")).toBeNull();
    });

    it("keeps a pending connector approval open in the assistant flow", () => {
        render(<AssistantMessage events={[approvalRequest]} />);

        expect(screen.getByText("Asking for approval")).toBeVisible();
        expect(screen.getByText("Gmail: Send email")).toBeVisible();
    });

    it("records the decision and the approved action's result", () => {
        render(
            <AssistantMessage
                events={[
                    approvalRequest,
                    {
                        type: "ask_inputs_response",
                        assistant_message_id: "m1",
                        ask_event_id: "ask-1",
                        responses: [
                            {
                                id: "approve-1",
                                kind: "approval",
                                decision: "approve",
                            },
                        ],
                    },
                    {
                        type: "mcp_tool_call",
                        connector_id: "gmail-native",
                        connector_name: "Gmail",
                        tool_name: "gmail_send",
                        openai_tool_name: "gmail_send",
                        status: "ok",
                        approval_id: "approve-1",
                    },
                    { type: "content", text: "Sent." },
                ]}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 2 steps · 1 connector call" }),
        );
        fireEvent.click(screen.getByText("Asked for approval"));
        expect(screen.getByText("Approved")).toBeVisible();
        expect(screen.getByText("Gmail: gmail_send")).toBeVisible();
    });

    it("marks the response failed for a top-level error event", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "error",
                        message: "The response was interrupted.",
                        safe_to_display: true,
                    } as AssistantEvent,
                ]}
            />,
        );

        expect(
            screen.getByText("The response was interrupted."),
        ).toBeInTheDocument();
    });
    it("shows a delegated answer's subagent and what both cost, without a usage line in the timeline", () => {
        const load = vi.fn(async () => {
            throw new Error("not opened in this test");
        });
        render(
            <AssistantMessage
                events={[
                    {
                        type: "subagent",
                        call_id: "call-1",
                        child_id: "7",
                        address: "turn/a1/document_review-1",
                        agent_type: "document_review",
                        model: "opencode-go/glm-5",
                        task: "Find the governing law",
                        status: "done",
                        usage: { input: 1200, output: 300, cost: 0.004 },
                    },
                    { type: "content", text: "Delaware law governs." },
                    { type: "turn_usage", input: 5000, output: 700, cost: 0.0123 },
                ]}
                onLoadSubagentTranscript={load}
            />,
        );
        // Like other work before the answer, it folds away once the answer is written.
        fireEvent.click(screen.getByRole("button", { name: /Completed in 1 step/ }));
        expect(screen.getByRole("button", { name: /Document review subagent/ })).toBeInTheDocument();
        expect(
            screen.getByText("This answer: 5,700 tokens · $0.01. 1 subagent: 1,500 tokens · under $0.01."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/turn_usage/)).not.toBeInTheDocument();
        expect(load).not.toHaveBeenCalled();
    });
});
