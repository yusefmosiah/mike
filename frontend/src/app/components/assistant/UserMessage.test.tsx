import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLAPSED_PROMPT_HEIGHT_PX, UserMessage } from "./UserMessage";

describe("UserMessage", () => {
    it("opens a document-backed file pill", async () => {
        const onFileClick = vi.fn();
        const user = userEvent.setup();
        const file = {
            filename: "agreement.docx",
            document_id: "document-1",
        };

        render(
            <UserMessage
                content="Review this"
                files={[file]}
                onFileClick={onFileClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open agreement.docx" }),
        );
        expect(onFileClick).toHaveBeenCalledWith(file);
    });

    it("reveals the workflow behind the pill", async () => {
        const user = userEvent.setup();
        const onWorkflowClick = vi.fn();
        render(
            <UserMessage
                content="Run the diligence review"
                workflow={{ id: "wf-1", title: "Diligence review" }}
                onWorkflowClick={onWorkflowClick}
            />,
        );

        await user.click(
            screen.getByRole("button", {
                name: "Open workflow Diligence review",
            }),
        );

        expect(onWorkflowClick).toHaveBeenCalledWith({
            id: "wf-1",
            title: "Diligence review",
        });
    });

    it("starts an edit in the composer, and marks the prompt being edited", async () => {
        const user = userEvent.setup();
        const onEdit = vi.fn();
        const { rerender } = render(
            <UserMessage content="Original wording" messageId="message-1" onEdit={onEdit} />,
        );

        await user.click(screen.getByRole("button", { name: "Edit prompt" }));
        expect(onEdit).toHaveBeenCalledTimes(1);
        // No editor in the thread: the text and files are edited below.
        expect(screen.queryByRole("textbox")).toBeNull();

        rerender(
            <UserMessage content="Original wording" messageId="message-1" onEdit={onEdit} beingEdited />,
        );
        expect(screen.getByText("Editing below")).toBeInTheDocument();
    });

    it("keeps the edit control while an answer streams, but unusable", () => {
        render(<UserMessage content="Original wording" messageId="m" onEdit={vi.fn()} editDisabled />);
        expect(screen.getByRole("button", { name: "Edit prompt" })).toBeDisabled();
    });

    it("offers no edit control when branching is not wired", () => {
        render(<UserMessage content="Review this" />);

        expect(
            screen.queryByRole("button", { name: "Edit prompt" }),
        ).not.toBeInTheDocument();
    });

    it("steps through sibling branches", async () => {
        const user = userEvent.setup();
        const onNavigateSibling = vi.fn();
        render(
            <UserMessage
                content="Question"
                sibling={{ index: 2, total: 3 }}
                onNavigateSibling={onNavigateSibling}
            />,
        );

        expect(screen.getByText("2/3")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Next branch" }));

        expect(onNavigateSibling).toHaveBeenCalledWith(1);
    });

    it("hides the navigator when the message has no siblings", () => {
        render(
            <UserMessage content="Question" sibling={{ index: 1, total: 1 }} />,
        );

        expect(
            screen.queryByRole("button", { name: "Previous branch" }),
        ).not.toBeInTheDocument();
    });

    it("keeps a /nr message that was not saved on screen, with the reason", () => {
        render(
            <UserMessage
                content="Client called: cap at 1x fees."
                error="Not added. A response is still being generated; send it again once it finishes."
            />,
        );
        expect(screen.getByText("Client called: cap at 1x fees.")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Not added. A response is still being generated; send it again once it finishes.",
        );
    });

    describe("a long prompt", () => {
        afterEach(() => vi.restoreAllMocks());

        function promptHeight(px: number) {
            vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(px);
        }

        it("folds behind Show more, and Show less folds it again from below the text", async () => {
            promptHeight(COLLAPSED_PROMPT_HEIGHT_PX * 3);
            const user = userEvent.setup();
            render(<UserMessage messageId="m1" content={"Line\n".repeat(60)} />);
            const text = document.getElementById("prompt-m1")!;
            const more = screen.getByRole("button", { name: "Show more" });
            expect(more).toHaveAttribute("aria-expanded", "false");
            expect(more).toHaveAttribute("aria-controls", "prompt-m1");
            expect(text).toHaveStyle({ maxHeight: `${COLLAPSED_PROMPT_HEIGHT_PX}px`, overflow: "hidden" });

            await user.click(more);
            const less = screen.getByRole("button", { name: "Show less" });
            expect(less).toHaveAttribute("aria-expanded", "true");
            expect(text.style.maxHeight).toBe("");
            // The control follows the text, at its end.
            expect(text.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

            const scrollIntoView = vi.fn();
            Element.prototype.scrollIntoView = scrollIntoView;
            vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: -500 } as DOMRect);
            await user.click(less);
            expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
            await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" }));
        });

        it("leaves a prompt that fits as it is", () => {
            promptHeight(COLLAPSED_PROMPT_HEIGHT_PX);
            render(<UserMessage messageId="m2" content="Short question" />);
            expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
            expect(document.getElementById("prompt-m2")!.style.maxHeight).toBe("");
        });
    });
});
