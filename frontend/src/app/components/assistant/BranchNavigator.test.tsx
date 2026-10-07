import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchNavigator } from "./BranchNavigator";

describe("BranchNavigator", () => {
    it("shows the active position as plain text", () => {
        render(
            <BranchNavigator index={2} total={3} onPrev={vi.fn()} onNext={vi.fn()} />,
        );

        expect(screen.getByText("2/3")).toBeVisible();
    });

    it("renders nothing when the message has no siblings", () => {
        render(<BranchNavigator index={1} total={1} />);

        expect(
            screen.queryByRole("button", { name: "Previous branch" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Next branch" }),
        ).not.toBeInTheDocument();
    });

    it("steps to the previous and next sibling", async () => {
        const user = userEvent.setup();
        const onPrev = vi.fn();
        const onNext = vi.fn();
        render(
            <BranchNavigator index={2} total={3} onPrev={onPrev} onNext={onNext} />,
        );

        await user.click(
            screen.getByRole("button", { name: "Previous branch" }),
        );
        await user.click(screen.getByRole("button", { name: "Next branch" }));

        expect(onPrev).toHaveBeenCalledTimes(1);
        expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("disables the arrows at the ends of the sibling list", () => {
        const onPrev = vi.fn();
        const onNext = vi.fn();
        const { rerender } = render(
            <BranchNavigator index={1} total={3} onPrev={onPrev} onNext={onNext} />,
        );

        expect(
            screen.getByRole("button", { name: "Previous branch" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Next branch" }),
        ).toBeEnabled();

        rerender(
            <BranchNavigator index={3} total={3} onPrev={onPrev} onNext={onNext} />,
        );

        expect(
            screen.getByRole("button", { name: "Previous branch" }),
        ).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Next branch" }),
        ).toBeDisabled();
    });

    it("disables both arrows when navigation is not wired", () => {
        render(<BranchNavigator index={2} total={3} />);

        expect(
            screen.getByRole("button", { name: "Previous branch" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Next branch" }),
        ).toBeDisabled();
    });

    it("uses the label as the accessible group name", () => {
        render(
            <BranchNavigator
                index={1}
                total={2}
                onPrev={vi.fn()}
                onNext={vi.fn()}
                label="Response branches"
            />,
        );

        expect(
            screen.getByRole("group", { name: "Response branches" }),
        ).toBeVisible();
    });
});
