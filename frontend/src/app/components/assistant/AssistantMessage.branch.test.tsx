import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage branching controls", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            unobserve() {}
            disconnect() {}
        });
    });

    it("regenerates the response from the action row", async () => {
        const user = userEvent.setup();
        const onRegenerate = vi.fn();
        render(
            <AssistantMessage
                events={[]}
                messageId="answer-1"
                onRegenerate={onRegenerate}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Regenerate response" }),
        );

        expect(onRegenerate).toHaveBeenCalledTimes(1);
    });

    it("hides the regenerate control while the response streams", () => {
        render(
            <AssistantMessage
                events={[]}
                isStreaming
                onRegenerate={vi.fn()}
            />,
        );

        expect(
            screen.queryByRole("button", { name: "Regenerate response" }),
        ).not.toBeInTheDocument();
    });

    it("offers no regenerate control when the host did not wire one", () => {
        render(<AssistantMessage events={[]} />);

        expect(
            screen.queryByRole("button", { name: "Regenerate response" }),
        ).not.toBeInTheDocument();
    });

    it("branches this response into a new thread", async () => {
        const user = userEvent.setup();
        const onBranchIntoNewThread = vi.fn();
        render(
            <AssistantMessage
                events={[]}
                messageId="answer-1"
                onBranchIntoNewThread={onBranchIntoNewThread}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Branch into new thread" }),
        );

        expect(onBranchIntoNewThread).toHaveBeenCalledTimes(1);
    });

    it("hides the branch control while the response streams", () => {
        render(
            <AssistantMessage
                events={[]}
                isStreaming
                onBranchIntoNewThread={vi.fn()}
            />,
        );

        expect(
            screen.queryByRole("button", { name: "Branch into new thread" }),
        ).not.toBeInTheDocument();
    });

    it("offers no branch control when the host did not wire one", () => {
        render(<AssistantMessage events={[]} />);

        expect(
            screen.queryByRole("button", { name: "Branch into new thread" }),
        ).not.toBeInTheDocument();
    });

    it("steps through sibling responses", async () => {
        const user = userEvent.setup();
        const onNavigateSibling = vi.fn();
        render(
            <AssistantMessage
                events={[]}
                sibling={{ index: 1, total: 2 }}
                onNavigateSibling={onNavigateSibling}
            />,
        );

        expect(screen.getByText("1/2")).toBeVisible();
        const prev = screen.getByRole("button", { name: "Previous branch" });
        expect(prev).toBeDisabled();

        await user.click(
            screen.getByRole("button", { name: "Next branch" }),
        );

        expect(onNavigateSibling).toHaveBeenCalledWith(1);
    });

    it("keeps the copy control alongside the branch controls", () => {
        render(
            <AssistantMessage
                events={[]}
                sibling={{ index: 2, total: 2 }}
                onRegenerate={vi.fn()}
                onBranchIntoNewThread={vi.fn()}
                onNavigateSibling={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Copy response" }),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Regenerate response" }),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Branch into new thread" }),
        ).toBeVisible();
        expect(screen.getByText("2/2")).toBeVisible();
    });
});
