import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageOrigin } from "@mike/contracts";
import {
    AgentReportMessage,
    COLLAPSED_REPORT_HEIGHT_PX,
} from "./AgentReportMessage";

const origin: MessageOrigin = {
    kind: "agent_messages",
    messages: [
        {
            from: "research-1",
            child_id: "7",
            agent_type: "document_review",
            kind: "report",
            status: "done",
            body: "Governed by **Delaware** law.",
        },
        {
            from: "research-2",
            child_id: "8",
            agent_type: "research",
            kind: "message",
            body: "Still reading the exhibits.",
        },
        {
            from: "research-3",
            child_id: "9",
            agent_type: "research",
            kind: "report",
            status: "timed_out",
            body: "Ran out of time.",
        },
    ],
};

describe("AgentReportMessage", () => {
    afterEach(() => vi.restoreAllMocks());

    it("shows each sender, type, kind, status and body, as coming from the subagents", () => {
        render(<AgentReportMessage origin={origin} messageId="m1" />);
        expect(
            screen.getByRole("region", {
                name: "Messages from background subagents",
            }),
        ).toHaveAttribute("data-message-id", "m1");
        expect(screen.getByText("From background subagents")).toBeInTheDocument();

        expect(screen.getByText("research-1")).toBeInTheDocument();
        expect(screen.getByText("Document review · Report · Done")).toBeInTheDocument();
        // The body is rendered as markdown.
        expect(screen.getByText("Delaware").tagName).toBe("STRONG");

        expect(screen.getByText("research-2")).toBeInTheDocument();
        // A message has no status of its own.
        expect(screen.getByText("Research · Message")).toBeInTheDocument();
        expect(screen.getByText("Still reading the exhibits.")).toBeInTheDocument();

        expect(screen.getByText("Research · Report · Ran out of time")).toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    it("carries no author, edit, copy or branch controls", () => {
        render(<AgentReportMessage origin={origin} />);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("folds a long body behind an expandable Show more", () => {
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
            COLLAPSED_REPORT_HEIGHT_PX + 400,
        );
        render(
            <AgentReportMessage
                origin={{ kind: "agent_messages", messages: [origin.messages[0]] }}
            />,
        );
        const toggle = screen.getByRole("button", { name: "Show more" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveStyle({
            maxHeight: `${COLLAPSED_REPORT_HEIGHT_PX}px`,
        });

        fireEvent.click(toggle);
        const open = screen.getByRole("button", { name: "Show less" });
        expect(open).toHaveAttribute("aria-expanded", "true");
        expect(document.getElementById(open.getAttribute("aria-controls")!)).not.toHaveStyle({
            maxHeight: `${COLLAPSED_REPORT_HEIGHT_PX}px`,
        });
    });

    it("does not offer to fold a short body", () => {
        render(
            <AgentReportMessage
                origin={{ kind: "agent_messages", messages: [origin.messages[1]] }}
            />,
        );
        expect(screen.queryByRole("button", { name: /Show/ })).not.toBeInTheDocument();
    });
});
