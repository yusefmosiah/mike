import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    Chat,
    Message,
    MessageSibling,
} from "@/app/components/shared/types";
import { ChatView } from "./ChatView";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

const branchApi = vi.hoisted(() => ({
    createBranch: vi.fn(),
    setChatLeaf: vi.fn(),
    fetchSiblings: vi.fn(),
}));
// What each edit control's save returned: the real row awaits it to decide
// whether to close the editor or keep the draft.
const editSaves = vi.hoisted(() => [] as Array<void | Promise<void>>);

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
        ...original,
        createBranch: branchApi.createBranch,
        setChatLeaf: branchApi.setChatLeaf,
        fetchSiblings: branchApi.fetchSiblings,
    };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [],
        renameChat: vi.fn(),
        deleteChat: vi.fn(),
        setCurrentChatId: vi.fn(),
        setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div>Chat input</div> }));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./ChatAccessModal", () => ({ ChatAccessModal: () => null }));
vi.mock("./QuickActionsModal", () => ({ QuickActionsModal: () => null }));
vi.mock("./AssistantSidePanel", async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, AssistantSidePanel: () => null };
});

// Stand-ins for the message rows: they expose the branch callbacks ChatView
// wires and report the branch data it passes through.
vi.mock("./UserMessage", () => ({
    UserMessage: ({
        content,
        messageId,
        sibling,
        onEditBranch,
        onNavigateSibling,
    }: {
        content: string;
        messageId?: string;
        sibling?: { index: number; total: number } | null;
        onEditBranch?: (content: string) => void | Promise<void>;
        onNavigateSibling?: (dir: -1 | 1) => void;
    }) => (
        <div data-testid={`user-${messageId}`}>
            <span>{content}</span>
            {sibling && sibling.total > 1 && (
                <span data-testid={`user-sibling-${messageId}`}>
                    {sibling.index}/{sibling.total}
                </span>
            )}
            {onEditBranch && (
                <button
                    type="button"
                    onClick={() => {
                        const save = onEditBranch("edited content");
                        editSaves.push(save);
                        if (save) save.catch(() => {});
                    }}
                >
                    edit {messageId}
                </button>
            )}
            {onNavigateSibling && (
                <button
                    type="button"
                    onClick={() => onNavigateSibling(1)}
                >
                    next {messageId}
                </button>
            )}
        </div>
    ),
}));
vi.mock("./AssistantMessage", () => ({
    AssistantMessage: ({
        messageId,
        sibling,
        onRegenerate,
        onBranchIntoNewThread,
        onNavigateSibling,
    }: {
        messageId?: string;
        sibling?: { index: number; total: number } | null;
        onRegenerate?: () => void;
        onBranchIntoNewThread?: () => void;
        onNavigateSibling?: (dir: -1 | 1) => void;
    }) => (
        <div data-testid={`assistant-${messageId}`}>
            {sibling && sibling.total > 1 && (
                <span data-testid={`assistant-sibling-${messageId}`}>
                    {sibling.index}/{sibling.total}
                </span>
            )}
            {onRegenerate && (
                <button type="button" onClick={onRegenerate}>
                    regenerate {messageId}
                </button>
            )}
            {onBranchIntoNewThread && (
                <button type="button" onClick={onBranchIntoNewThread}>
                    branch {messageId}
                </button>
            )}
            {onNavigateSibling && (
                <button
                    type="button"
                    onClick={() => onNavigateSibling(-1)}
                >
                    previous {messageId}
                </button>
            )}
        </div>
    ),
}));

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const chat: Chat = {
    id: "chat-1",
    project_id: null,
    user_id: "user-1",
    title: "Quarterly filing",
    created_at: "2026-01-01T00:00:00.000Z",
    is_owner: true,
    access_role: "owner",
};

function renderView(
    messages: Message[],
    extra: {
        onBranchChange?: () => void;
        onRegenerate?: (args: {
            assistant: Message;
            parentUser: Message | null;
        }) => void | Promise<void>;
        onEditPrompt?: (args: {
            message: Message;
            content: string;
        }) => void | Promise<void>;
        onBranchIntoNewThread?: (message: Message) => Promise<void>;
        siblingById?: Record<string, MessageSibling>;
        isResponseLoading?: boolean;
    } = {},
) {
    render(
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView
                chatId="chat-1"
                chat={chat}
                messages={messages}
                isResponseLoading={extra.isResponseLoading ?? false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={vi.fn()}
                onNewChat={vi.fn()}
                onBranchChange={extra.onBranchChange}
                onRegenerate={extra.onRegenerate}
                onEditPrompt={extra.onEditPrompt}
                onBranchIntoNewThread={extra.onBranchIntoNewThread}
                siblingById={extra.siblingById}
            />
        </PageChromeContext.Provider>,
    );
}

describe("ChatView branch controls", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editSaves.length = 0;
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        Object.defineProperty(HTMLElement.prototype, "scrollTo", {
            configurable: true,
            value: vi.fn(),
        });
    });

    it("saves an edited message as a sibling and reloads the path", async () => {
        const user = userEvent.setup();
        const onBranchChange = vi.fn();
        renderView(
            [
                {
                    id: "user-1",
                    role: "user",
                    content: "Original question",
                    sibling: { index: 1, total: 2, ids: ["user-1", "user-2"] },
                },
            ],
            { onBranchChange },
        );

        await user.click(
            screen.getByRole("button", { name: "edit user-1" }),
        );

        await waitFor(() => {
            expect(branchApi.createBranch).toHaveBeenCalledWith(
                "chat-1",
                expect.objectContaining({
                    from_message_id: "user-1",
                    content: "edited content",
                }),
            );
            expect(onBranchChange).toHaveBeenCalledTimes(1);
        });
    });

    it("hands an edited prompt to the host when the host wires it", async () => {
        const user = userEvent.setup();
        const onEditPrompt = vi.fn();
        renderView(
            [{ id: "user-1", role: "user", content: "Original question" }],
            { onEditPrompt },
        );

        await user.click(
            screen.getByRole("button", { name: "edit user-1" }),
        );

        await waitFor(() =>
            expect(onEditPrompt).toHaveBeenCalledWith({
                message: expect.objectContaining({ id: "user-1" }),
                content: "edited content",
            }),
        );
        expect(branchApi.createBranch).not.toHaveBeenCalled();
    });

    it("switches the active leaf when stepping to a sibling", async () => {
        const user = userEvent.setup();
        const onBranchChange = vi.fn();
        renderView(
            [
                {
                    id: "user-1",
                    role: "user",
                    content: "Original question",
                    sibling: {
                        index: 1,
                        total: 2,
                        ids: ["user-1", "user-2"],
                    },
                },
                {
                    id: "answer-1",
                    role: "assistant",
                    content: "Answer",
                },
            ],
            { onBranchChange },
        );

        expect(screen.getByTestId("user-sibling-user-1")).toHaveTextContent(
            "1/2",
        );

        await user.click(
            screen.getByRole("button", { name: "next user-1" }),
        );

        await waitFor(() => {
            expect(branchApi.setChatLeaf).toHaveBeenCalledWith(
                "chat-1",
                "user-2",
            );
            expect(onBranchChange).toHaveBeenCalledTimes(1);
        });
        expect(branchApi.fetchSiblings).not.toHaveBeenCalled();
    });

    it("hands a regenerate to the host, with the prompt that asked", async () => {
        const user = userEvent.setup();
        const onRegenerate = vi.fn();
        const prompt: Message = { id: "user-1", role: "user", content: "Question" };
        const answer: Message = {
            id: "answer-1",
            role: "assistant",
            content: "Answer",
            sibling: { index: 1, total: 2, ids: ["answer-1", "answer-2"] },
        };
        renderView([prompt, answer], { onRegenerate });

        await user.click(
            screen.getByRole("button", { name: "regenerate answer-1" }),
        );

        await waitFor(() =>
            expect(onRegenerate).toHaveBeenCalledWith({
                assistant: answer,
                parentUser: prompt,
            }),
        );
        // Regenerating never parks the leaf on the prompt.
        expect(branchApi.setChatLeaf).not.toHaveBeenCalled();
    });

    it("offers regenerate and new-thread only when the host can carry them out", () => {
        renderView([
            { id: "user-1", role: "user", content: "Question" },
            { id: "answer-1", role: "assistant", content: "Answer" },
        ]);
        expect(
            screen.queryByRole("button", { name: "regenerate answer-1" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "branch answer-1" }),
        ).toBeNull();
    });

    it("hands branching into a new thread to the host", async () => {
        const user = userEvent.setup();
        const onBranchIntoNewThread = vi.fn().mockResolvedValue(undefined);
        renderView(
            [
                { id: "user-1", role: "user", content: "Question" },
                { id: "answer-1", role: "assistant", content: "Answer" },
            ],
            { onBranchIntoNewThread },
        );

        await user.click(
            screen.getByRole("button", { name: "branch answer-1" }),
        );

        await waitFor(() =>
            expect(onBranchIntoNewThread).toHaveBeenCalledWith(
                expect.objectContaining({ id: "answer-1" }),
            ),
        );
        expect(branchApi.setChatLeaf).not.toHaveBeenCalled();
    });

    it("keeps the edit open when saving fails, and says why", async () => {
        const user = userEvent.setup();
        const onEditPrompt = vi.fn().mockRejectedValue(new Error("offline"));
        renderView(
            [{ id: "user-1", role: "user", content: "Original question" }],
            { onEditPrompt },
        );

        await user.click(
            screen.getByRole("button", { name: "edit user-1" }),
        );

        // The row's save rejects, which is what keeps its draft open.
        expect(editSaves).toHaveLength(1);
        await expect(editSaves[0]).rejects.toThrow("offline");
        expect(
            await screen.findByText("Could not save the edit"),
        ).toBeInTheDocument();
    });

    it("asks the branch API for sibling order when the view has none", async () => {
        const user = userEvent.setup();
        const onBranchChange = vi.fn();
        branchApi.fetchSiblings.mockResolvedValueOnce({
            siblings: [{ id: "user-4" }, { id: "user-5" }],
            index: 1,
            total: 2,
        });
        renderView(
            [
                {
                    id: "user-4",
                    role: "user",
                    content: "Question",
                    sibling: { index: 1, total: 2 },
                },
                { id: "answer-4", role: "assistant", content: "Answer" },
            ],
            { onBranchChange },
        );

        await user.click(
            screen.getByRole("button", { name: "next user-4" }),
        );

        await waitFor(() => {
            expect(branchApi.fetchSiblings).toHaveBeenCalledWith(
                "chat-1",
                "user-4",
            );
            expect(branchApi.setChatLeaf).toHaveBeenCalledWith(
                "chat-1",
                "user-5",
            );
            expect(onBranchChange).toHaveBeenCalledTimes(1);
        });
    });

    it("hands regeneration to the host when the host wires it", async () => {
        const user = userEvent.setup();
        const onRegenerate = vi.fn();
        renderView(
            [
                { id: "user-1", role: "user", content: "Question" },
                { id: "answer-1", role: "assistant", content: "Answer" },
            ],
            { onRegenerate },
        );

        await user.click(
            screen.getByRole("button", { name: "regenerate answer-1" }),
        );

        await waitFor(() =>
            expect(onRegenerate).toHaveBeenCalledWith({
                assistant: expect.objectContaining({ id: "answer-1" }),
                parentUser: expect.objectContaining({ id: "user-1" }),
            }),
        );
        expect(branchApi.setChatLeaf).not.toHaveBeenCalled();
    });

    it("uses siblingById when the messages do not carry branch data", async () => {
        const user = userEvent.setup();
        const onBranchChange = vi.fn();
        renderView(
            [
                { id: "user-7", role: "user", content: "Question" },
                { id: "answer-7", role: "assistant", content: "Answer" },
            ],
            {
                onBranchChange,
                siblingById: {
                    "user-7": { index: 1, total: 3, ids: ["user-7", "user-8", "user-9"] },
                },
            },
        );

        expect(screen.getByTestId("user-sibling-user-7")).toHaveTextContent(
            "1/3",
        );

        await user.click(
            screen.getByRole("button", { name: "next user-7" }),
        );

        await waitFor(() =>
            expect(branchApi.setChatLeaf).toHaveBeenCalledWith(
                "chat-1",
                "user-8",
            ),
        );
    });

    it("hides branch controls while an answer streams", () => {
        renderView(
            [
                {
                    id: "user-1",
                    role: "user",
                    content: "Question",
                    sibling: { index: 1, total: 2, ids: ["user-1", "user-2"] },
                },
                { id: "answer-1", role: "assistant", content: "Answer" },
            ],
            { isResponseLoading: true },
        );

        expect(
            screen.queryByRole("button", { name: "edit user-1" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "regenerate answer-1" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "branch answer-1" }),
        ).not.toBeInTheDocument();
    });
});
