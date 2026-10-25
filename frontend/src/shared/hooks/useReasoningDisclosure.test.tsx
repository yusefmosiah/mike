import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReasoningDisclosure } from "./useReasoningDisclosure";

function Harness({ text = "Reasoning" }) {
    const { isContentOpen, toggleContent } = useReasoningDisclosure();
    return <>
        <button aria-expanded={isContentOpen} onClick={toggleContent}>Thought process</button>
        {isContentOpen && <div>{text}</div>}
    </>;
}

const toggle = () => screen.getByRole("button", { name: "Thought process" });

describe("reasoning disclosure", () => {
    it("starts closed until the reader opens it, and closes again", () => {
        render(<Harness />);
        expect(toggle()).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        fireEvent.click(toggle());
        expect(toggle()).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        fireEvent.click(toggle());
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    });

    it("keeps the reader's choice as the text grows", () => {
        const view = render(<Harness />);
        fireEvent.click(toggle());
        view.rerender(<Harness text="Reasoning, and more" />);
        expect(screen.getByText("Reasoning, and more")).toBeInTheDocument();
    });

    it("opens each thought on its own", () => {
        const first = render(<Harness />);
        fireEvent.click(toggle());
        first.unmount();
        render(<Harness />);
        expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });
});
