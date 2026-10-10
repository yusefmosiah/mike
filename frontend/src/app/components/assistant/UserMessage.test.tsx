import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMessage } from "./UserMessage";

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

    it("saves an inline edit as a sibling branch", async () => {
        const user = userEvent.setup();
        const onEditBranch = vi.fn();
        render(
            <UserMessage
                content="Original wording"
                messageId="message-1"
                onEditBranch={onEditBranch}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Edit prompt" }),
        );
        const editor = screen.getByRole("textbox", { name: "Edit message" });
        expect(editor).toHaveValue("Original wording");

        await user.clear(editor);
        await user.type(editor, "Revised wording");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(onEditBranch).toHaveBeenCalledWith("Revised wording");
        await waitFor(() =>
            expect(
                screen.queryByRole("textbox", { name: "Edit message" }),
            ).not.toBeInTheDocument(),
        );
    });

    it("cancels the inline editor without emitting an edit", async () => {
        const user = userEvent.setup();
        const onEditBranch = vi.fn();
        render(
            <UserMessage
                content="Original wording"
                messageId="message-1"
                onEditBranch={onEditBranch}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Edit prompt" }),
        );
        await user.type(
            screen.getByRole("textbox", { name: "Edit message" }),
            " and more",
        );
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onEditBranch).not.toHaveBeenCalled();
        expect(screen.getByText("Original wording")).toBeVisible();
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
});
