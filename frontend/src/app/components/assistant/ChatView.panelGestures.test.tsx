import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message } from "@/app/components/shared/types";
import { ChatView } from "./ChatView";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

// On a phone a swipe left opens the document panel and a swipe right closes
// it, mirroring the sidebar. The panel opens on the chat's own documents as
// tabs, or on the document picker when the chat has none.

const { listDocumentVersions, sidebar } = vi.hoisted(() => ({
    listDocumentVersions: vi.fn(),
    sidebar: { isSidebarOpen: false },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listDocumentVersions: (...args: unknown[]) => listDocumentVersions(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn(), isSidebarOpen: sidebar.isSidebarOpen }),
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
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AssistantMessage", () => ({ AssistantMessage: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("./ChatAccessModal", () => ({ ChatAccessModal: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({ inline }: { inline?: boolean }) =>
        inline ? <div>Inline picker</div> : null,
}));
vi.mock("./AssistantSidePanel", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./AssistantSidePanel")>()),
    AssistantSidePanel: ({
        tabs,
        activeTabId,
        loading,
        picker,
    }: {
        tabs: { id: string }[];
        activeTabId: string | null;
        loading?: boolean;
        picker?: React.ReactNode;
    }) => (
        <div data-testid="panel" data-active={activeTabId} data-loading={String(!!loading)}>
            {tabs.map((tab) => tab.id).join(",")}
            {tabs.length === 0 && !loading ? picker : null}
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
    title: "Drafting",
    created_at: new Date().toISOString(),
    is_owner: true,
    access_role: "owner",
};

const withDocuments: Message[] = [
    {
        id: "m1",
        role: "assistant",
        content: "done",
        events: [
            { type: "doc_created", filename: "nda.docx", download_url: "/x", document_id: "d1", version_id: "v1" },
            { type: "doc_created", filename: "memo.docx", download_url: "/x", document_id: "d2", version_id: "v1" },
        ],
    },
];

// Without a version id the panel has to look the document up first.
const unversioned: Message[] = [
    {
        id: "m2",
        role: "assistant",
        content: "done",
        events: [{ type: "doc_created", filename: "nda.docx", download_url: "/x", document_id: "d1" }],
    },
];

function renderView(messages: Message[]) {
    render(
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView
                chatId="chat-1"
                chat={chat}
                messages={messages}
                isResponseLoading={false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={vi.fn()}
                onNewChat={vi.fn()}
                canSend
            />
        </PageChromeContext.Provider>,
    );
}

function touch(target: EventTarget, type: string, points: Array<[number, number]>) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    });
    act(() => {
        target.dispatchEvent(event);
    });
}
function swipe(target: EventTarget, from: number, to: number) {
    touch(target, "touchstart", [[from, 300]]);
    touch(target, "touchmove", [[to, 302]]);
    touch(target, "touchend", []);
}
const swipeLeft = (target: EventTarget) => swipe(target, 300, 150);
const swipeRight = (target: EventTarget) => swipe(target, 100, 250);

beforeEach(() => {
    vi.clearAllMocks();
    sidebar.isSidebarOpen = false;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    listDocumentVersions.mockImplementation(async (documentId: string) => ({
        current_version_id: "v1",
        versions: [
            { id: "v1", version_number: 1, source: "upload", created_at: "2026-08-18T00:00:00Z", filename: `${documentId}.docx` },
        ],
    }));
});
afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

describe("ChatView document panel gestures", () => {
    it("opens on the chat's documents as tabs, the most recent selected", async () => {
        renderView(withDocuments);

        swipeLeft(screen.getByText("Chat input"));

        const panel = await screen.findByTestId("panel");
        await waitFor(() => expect(panel).toHaveTextContent("d1,d2"));
        expect(panel).toHaveAttribute("data-active", "d2");
        expect(panel).toHaveAttribute("data-loading", "false");
    });

    it("shows the loading layout while the documents open", async () => {
        let release: (value: unknown) => void = () => {};
        listDocumentVersions.mockImplementation(
            () => new Promise((resolve) => (release = resolve)),
        );
        renderView(unversioned);

        swipeLeft(screen.getByText("Chat input"));

        expect(await screen.findByTestId("panel")).toHaveAttribute("data-loading", "true");
        await act(async () => {
            release({
                current_version_id: "v1",
                versions: [{ id: "v1", version_number: 1, source: "upload", created_at: "2026-08-18T00:00:00Z", filename: "x.docx" }],
            });
        });
        await waitFor(() => expect(screen.getByTestId("panel")).toHaveAttribute("data-loading", "false"));
    });

    it("opens on the document picker when the chat has no documents", async () => {
        renderView([{ id: "m1", role: "assistant", content: "hello" }]);

        swipeLeft(screen.getByText("Chat input"));

        expect(await screen.findByText("Inline picker")).toBeInTheDocument();
        expect(listDocumentVersions).not.toHaveBeenCalled();
    });

    it("falls back to the picker when none of the documents can be opened", async () => {
        listDocumentVersions.mockRejectedValue(new Error("network"));
        renderView(unversioned);

        swipeLeft(screen.getByText("Chat input"));

        expect(await screen.findByText("Inline picker")).toBeInTheDocument();
        expect(screen.queryByText("Document unavailable")).not.toBeInTheDocument();
    });

    it("leaves a left swipe to the sidebar while it is open", () => {
        sidebar.isSidebarOpen = true;
        renderView(withDocuments);

        swipeLeft(screen.getByText("Chat input"));

        expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
    });

    it("does nothing at desktop widths", () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
        renderView(withDocuments);

        swipeLeft(screen.getByText("Chat input"));

        expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
    });

    it("closes on a swipe right, keeping the tabs for the next open", async () => {
        renderView(withDocuments);
        swipeLeft(screen.getByText("Chat input"));
        const panel = await screen.findByTestId("panel");
        await waitFor(() => expect(panel).toHaveTextContent("d1,d2"));
        await waitFor(() => expect(panel.parentElement).toHaveClass("translate-x-0"));
        expect(panel.parentElement).toHaveFocus();

        await waitFor(() => {
            swipeRight(panel);
            expect(panel.parentElement).toHaveClass("translate-x-full");
        });
        await waitFor(() => expect(screen.queryByTestId("panel")).not.toBeInTheDocument());

        listDocumentVersions.mockClear();
        swipeLeft(screen.getByText("Chat input"));
        await waitFor(() => expect(screen.getByTestId("panel")).toHaveTextContent("d1,d2"));
    });

    it("closes on a swipe that starts in the left edge zone, over a sideways scroller", async () => {
        renderView(withDocuments);
        swipeLeft(screen.getByText("Chat input"));
        const panel = await screen.findByTestId("panel");
        await waitFor(() => expect(panel.parentElement).toHaveClass("translate-x-0"));
        // Focus moves in after the swipe watchers attach: the panel is ready.
        await waitFor(() => expect(panel.parentElement).toHaveFocus());

        panel.style.overflowX = "auto";
        Object.defineProperties(panel, {
            scrollWidth: { value: 900 },
            clientWidth: { value: 300 },
            scrollLeft: { value: 200 },
        });
        swipeRight(panel);
        expect(panel.parentElement).toHaveClass("translate-x-0");

        // The edge strip's watcher attaches in its own effect; a swipe before
        // that is lost, so swipe until it lands (a closed panel ignores more).
        const edge = panel.parentElement!.querySelector("[data-swipe-edge]")!;
        await waitFor(() => {
            swipeRight(edge);
            expect(panel.parentElement).toHaveClass("translate-x-full");
        });
    });
});
