import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageFile } from "../shared/types";
import type { ChatInputHandle } from "./ChatInput";
import { ChatThread, type ChatThreadProps } from "./ChatThread";

vi.mock("./CodeApprovalRequests", () => ({
    CodeApprovalRequests: ({
        isHost,
        watching,
    }: {
        isHost: boolean;
        watching: boolean;
    }) => (
        <div
            data-testid="code-approvals"
            data-host={String(isHost)}
            data-watching={String(watching)}
        />
    ),
}));
vi.mock("./ChatInputPrompt", () => ({
    ChatInputPrompt: ({
        children,
        onSubmit,
    }: {
        children: React.ReactNode;
        onSubmit: (response: unknown, content: string, files: unknown) => void;
    }) => (
        <>
            <button
                type="button"
                onClick={() => onSubmit({ type: "ask_inputs_response" }, "Answer", [])}
            >
                Answer prompt
            </button>
            {children}
        </>
    ),
}));
vi.mock("./ChatInput", () => ({
    ChatInput: (props: {
        canStop?: boolean;
        isLoading: boolean;
        projectId?: string;
        enableGlobalFileDrop?: boolean;
        dropUploadsToProject?: boolean;
        editTarget?: { content: string } | null;
        onEditSubmit?: (edited: { content: string; files: MessageFile[] }) => void;
    }) => (
        <div
            data-testid="chat-input"
            data-editing={props.editTarget?.content}
            data-can-stop={String(props.canStop)}
            data-loading={String(props.isLoading)}
            data-project-id={props.projectId}
            data-global-drop={String(props.enableGlobalFileDrop)}
            data-drop-to-project={String(props.dropUploadsToProject)}
        >
            {props.editTarget && (
                <button
                    type="button"
                    onClick={() =>
                        props.onEditSubmit?.({ content: "Edited", files: [] })
                    }
                >
                    Send edit
                </button>
            )}
        </div>
    ),
}));
vi.mock("./UserMessage", () => ({
    UserMessage: (props: {
        content: string;
        error?: string;
        editDisabled?: boolean;
        onEdit?: () => void;
        onNavigateSibling?: (dir: -1 | 1) => void;
        onWorkflowClick?: (workflow: { id: string; title: string }) => void;
        onFileClick?: (file: MessageFile) => void;
        files?: MessageFile[];
        workflow?: { id: string; title: string };
        authorLabel?: string | null;
    }) => (
        <div data-testid="user-message" data-error={props.error}>
            <p>{props.content}</p>
            {props.authorLabel && <span>{props.authorLabel}</span>}
            {props.onEdit && (
                <button
                    type="button"
                    disabled={props.editDisabled}
                    onClick={() => props.onEdit?.()}
                >
                    Edit {props.content}
                </button>
            )}
            {props.onNavigateSibling && (
                <button type="button" onClick={() => props.onNavigateSibling?.(1)}>
                    Next {props.content}
                </button>
            )}
            {props.workflow && (
                <button
                    type="button"
                    onClick={() => props.onWorkflowClick?.(props.workflow!)}
                >
                    Workflow {props.workflow.title}
                </button>
            )}
            {props.files?.map((file) => (
                <button
                    key={file.filename}
                    type="button"
                    onClick={() => props.onFileClick?.(file)}
                >
                    File {file.filename}
                </button>
            ))}
        </div>
    ),
}));
vi.mock("./AssistantMessage", () => ({
    AssistantMessage: (props: {
        events?: Array<{ type: string; text?: string }>;
        errorMessage?: string;
        isStreaming?: boolean;
        minHeight?: string;
        onRegenerate?: () => void;
        onBranchIntoNewThread?: () => void;
        onWorkflowClick?: (id: string) => void;
        onLoadSubagentTranscript?: unknown;
    }) => (
        <div
            data-testid="assistant-message"
            data-streaming={String(props.isStreaming)}
            data-error={props.errorMessage}
            data-subagents={String(!!props.onLoadSubagentTranscript)}
            style={{ minHeight: props.minHeight }}
        >
            {props.events?.map((event) => event.text).join("")}
            {props.onRegenerate && (
                <button type="button" onClick={props.onRegenerate}>
                    Regenerate
                </button>
            )}
            {props.onBranchIntoNewThread && (
                <button type="button" onClick={props.onBranchIntoNewThread}>
                    Branch
                </button>
            )}
            <button type="button" onClick={() => props.onWorkflowClick?.("wf-2")}>
                Assistant workflow
            </button>
        </div>
    ),
}));

const resizeCallbacks: (() => void)[] = [];

class ResizeObserverMock {
    constructor(callback: () => void) {
        resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
}

const conversation: Message[] = [
    {
        id: "u1",
        role: "user",
        content: "First question",
        workflow: { id: "wf-1", title: "Review" },
        files: [
            {
                filename: "Draft.docx",
                document_id: "doc-1",
                version_id: "v-3",
                version_number: 3,
            },
            { filename: "Loose.txt" },
        ],
    },
    {
        id: "a1",
        role: "assistant",
        content: "",
        events: [{ type: "content", text: "First answer" }],
    },
];

function props(overrides: Partial<ChatThreadProps> = {}): ChatThreadProps {
    return {
        chatId: "chat-1",
        messages: conversation,
        isResponseLoading: false,
        viewerId: "me",
        isHost: true,
        chatInputRef: createRef<ChatInputHandle>(),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
        onWorkflowClick: vi.fn(),
        activeCitation: null,
        onCitationClick: vi.fn(),
        onOpenCitationSource: vi.fn(),
        onCaseClick: vi.fn(),
        onEditViewClick: vi.fn(),
        onOpenDocument: vi.fn(),
        onEditResolveStart: vi.fn(),
        onEditResolved: vi.fn(),
        onEditError: vi.fn(),
        isDocReloading: () => false,
        isEditReloading: () => false,
        resolvedEditStatuses: {},
        ...overrides,
    };
}

function renderThread(overrides: Partial<ChatThreadProps> = {}) {
    const all = props(overrides);
    const view = render(
        <div className="relative flex flex-col">
            <ChatThread {...all} />
        </div>,
    );
    return { ...view, props: all };
}

beforeEach(() => {
    resizeCallbacks.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Element.prototype.scrollTo = vi.fn();
});

describe("ChatThread layout", () => {
    it("docks the composer in the slots the phone styles and keyboard glide target", () => {
        renderThread({ variant: "pane" });
        for (const slot of [
            "chat-messages-scroller",
            "chat-messages-content",
            "chat-composer-fade",
            "chat-composer-dock",
            "chat-composer",
        ]) {
            expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
        }
        const dock = document.querySelector('[data-slot="chat-composer-dock"]')!;
        expect(dock.className).toContain("pb-[var(--chat-composer-gap)]");
    });

    it("centres a page thread and fills a pane", () => {
        const { unmount } = renderThread({ variant: "page" });
        const page = document.querySelector<HTMLElement>(
            '[data-slot="chat-messages-content"]',
        )!;
        expect(page.className).toContain("max-w-4xl");
        expect(page.style.paddingTop).toContain("safe-area-inset-top");
        unmount();

        renderThread({ variant: "pane" });
        const pane = document.querySelector<HTMLElement>(
            '[data-slot="chat-messages-content"]',
        )!;
        expect(pane.className).not.toContain("max-w-4xl");
        expect(pane.className).toContain("md:pt-20");
        expect(pane.style.paddingTop).toBe("");
        expect(
            document.querySelector('[data-slot="chat-composer"]')!.className,
        ).toContain("px-3");
    });

    it("pushes the thread up as the composer grows instead of covering it", () => {
        renderThread();
        const composer = document.querySelector<HTMLElement>(
            '[data-slot="chat-composer"]',
        )!;
        const content = document.querySelector<HTMLElement>(
            '[data-slot="chat-messages-content"]',
        )!;
        const scroller = document.querySelector<HTMLElement>(
            '[data-slot="chat-messages-scroller"]',
        )!;
        let composerHeight = 0;
        Object.defineProperty(composer, "offsetHeight", {
            get: () => composerHeight,
        });
        // Scrolled to the end of a 1000px thread in a 400px viewport.
        Object.defineProperty(scroller, "clientHeight", { value: 400 });
        let scrollHeight = 1000;
        Object.defineProperty(scroller, "scrollHeight", {
            get: () => scrollHeight,
        });
        scroller.scrollTop = 600;
        const resize = (height: number) =>
            act(() => {
                composerHeight = height;
                for (const callback of resizeCallbacks) callback();
            });
        const scrollTo = vi.mocked(Element.prototype.scrollTo);

        resize(100);
        expect(content.style.paddingBottom).toContain("116px");

        scrollTo.mockClear();
        scrollHeight = 1000;
        resize(220);
        expect(content.style.paddingBottom).toContain("236px");
        expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "auto" });

        // Shrinking back restores the resting padding and scrolls nothing.
        scrollTo.mockClear();
        resize(100);
        expect(content.style.paddingBottom).toContain("116px");
        expect(scrollTo).not.toHaveBeenCalled();

        // A reader further up the thread is not moved.
        scroller.scrollTop = 100;
        resize(220);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it("leaves the composer out until access resolves", () => {
        renderThread({ accessResolved: false });
        expect(document.querySelector('[data-slot="chat-composer-dock"]')).toBeNull();
        expect(screen.queryByTestId("chat-input")).toBeNull();
    });
});

describe("ChatThread loading and empty states", () => {
    it.each(["page", "pane"] as const)(
        "shows the %s skeleton while the history loads, then reveals the thread",
        (variant) => {
            const { rerender, props: all } = renderThread({
                variant,
                messages: [],
                chatLoading: true,
            });
            expect(document.querySelector(".theme-shimmer")).not.toBeNull();
            rerender(
                <div className="relative flex flex-col">
                    <ChatThread {...all} messages={conversation} chatLoading={false} />
                </div>,
            );
            expect(document.querySelector(".theme-shimmer")).toBeNull();
            expect(
                document.querySelector(
                    '[data-slot="chat-messages-content"] .transition-opacity',
                ),
            ).toHaveStyle({ opacity: "1" });
        },
    );

    it("shows the empty state for a loaded chat without messages", () => {
        renderThread({
            variant: "pane",
            messages: [],
            emptyState: <p>Hi there</p>,
        });
        expect(screen.getByText("Hi there")).toBeVisible();
        expect(document.querySelector(".theme-shimmer")).toBeNull();
    });

    it("keeps the skeleton rather than the empty state while loading", () => {
        renderThread({
            messages: [],
            chatLoading: true,
            emptyState: <p>Hi there</p>,
        });
        expect(screen.queryByText("Hi there")).toBeNull();
        expect(document.querySelector(".theme-shimmer")).not.toBeNull();
    });
});

describe("ChatThread messages", () => {
    it("opens a prompt's attached file at the version it was sent with", () => {
        const { props: all } = renderThread();
        fireEvent.click(screen.getByRole("button", { name: "File Draft.docx" }));
        expect(all.onOpenDocument).toHaveBeenCalledWith({
            documentId: "doc-1",
            filename: "Draft.docx",
            versionId: "v-3",
            versionNumber: 3,
        });
        // A file without a stored document has nothing to open.
        fireEvent.click(screen.getByRole("button", { name: "File Loose.txt" }));
        expect(all.onOpenDocument).toHaveBeenCalledTimes(1);
    });

    it("opens workflow chips from prompts and answers", () => {
        const { props: all } = renderThread();
        fireEvent.click(screen.getByRole("button", { name: "Workflow Review" }));
        fireEvent.click(screen.getByRole("button", { name: "Assistant workflow" }));
        expect(all.onWorkflowClick).toHaveBeenNthCalledWith(1, "wf-1");
        expect(all.onWorkflowClick).toHaveBeenNthCalledWith(2, "wf-2");
    });

    it("passes each message's error through", () => {
        renderThread({
            messages: [
                { id: "u1", role: "user", content: "Hi", error: "Not saved" },
                { id: "a1", role: "assistant", content: "", error: "Provider failed" },
            ],
        });
        expect(screen.getByTestId("user-message")).toHaveAttribute(
            "data-error",
            "Not saved",
        );
        expect(screen.getByTestId("assistant-message")).toHaveAttribute(
            "data-error",
            "Provider failed",
        );
    });

    it("disables editing while an answer streams, and hides the branch actions", () => {
        renderThread({
            isResponseLoading: true,
            onEditBranch: vi.fn().mockResolvedValue(undefined),
            onNavigateSibling: vi.fn(),
            onRegenerate: vi.fn(),
            onBranchIntoNewThread: vi.fn(),
        });
        expect(
            screen.getByRole("button", { name: "Edit First question" }),
        ).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Next First question" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Branch" })).toBeNull();
        expect(screen.getByTestId("assistant-message")).toHaveAttribute(
            "data-streaming",
            "true",
        );
    });

    it("routes the branch actions to the host once the answer is in", () => {
        const onEditBranch = vi.fn().mockResolvedValue(undefined);
        const onNavigateSibling = vi.fn();
        const onRegenerate = vi.fn();
        const onBranchIntoNewThread = vi.fn();
        const messages: Message[] = [
            {
                ...conversation[0],
                sibling: { index: 1, total: 2, ids: ["u0", "u1"] },
            },
            conversation[1],
        ];
        renderThread({
            messages,
            onEditBranch,
            onNavigateSibling,
            onRegenerate,
            onBranchIntoNewThread,
            onLoadSubagentTranscript: vi.fn(),
        });
        fireEvent.click(screen.getByRole("button", { name: "Edit First question" }));
        expect(screen.getByTestId("chat-input")).toHaveAttribute(
            "data-editing",
            "First question",
        );
        fireEvent.click(screen.getByRole("button", { name: "Send edit" }));
        fireEvent.click(screen.getByRole("button", { name: "Next First question" }));
        fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
        fireEvent.click(screen.getByRole("button", { name: "Branch" }));
        expect(onEditBranch).toHaveBeenCalledWith(messages[0], {
            content: "Edited",
            files: [],
        });
        expect(onNavigateSibling).toHaveBeenCalledWith(messages[0], ["u0", "u1"], 1);
        expect(onRegenerate).toHaveBeenCalledWith(messages[1], messages[0]);
        expect(onBranchIntoNewThread).toHaveBeenCalledWith(messages[1]);
        expect(screen.getByTestId("assistant-message")).toHaveAttribute(
            "data-subagents",
            "true",
        );
    });

    it("offers no edit or transcript before the chat has an id", () => {
        renderThread({
            chatId: null,
            onEditBranch: vi.fn(),
            onLoadSubagentTranscript: vi.fn(),
        });
        expect(screen.queryByRole("button", { name: "Edit First question" })).toBeNull();
        expect(screen.getByTestId("assistant-message")).toHaveAttribute(
            "data-subagents",
            "false",
        );
    });

    it("names the sender once someone else has written", () => {
        renderThread({
            messages: [
                {
                    id: "u1",
                    role: "user",
                    content: "Hi",
                    author: { id: "colleague", name: "Ada", email: null },
                },
            ],
        });
        expect(screen.getByText(/Ada/)).toBeVisible();
    });
});

describe("ChatThread composer", () => {
    it("lets only the turn's owner stop a colleague's answer", () => {
        const { unmount } = renderThread({
            isResponseLoading: true,
            generatingBy: { id: "colleague", name: "Ada", email: null },
        });
        expect(screen.getByTestId("chat-input")).toHaveAttribute(
            "data-can-stop",
            "false",
        );
        expect(screen.getByRole("status")).toBeVisible();
        expect(screen.getByTestId("code-approvals")).toHaveAttribute(
            "data-watching",
            "true",
        );
        unmount();

        renderThread({
            isResponseLoading: true,
            generatingBy: { id: "me", name: "Me", email: null },
        });
        expect(screen.getByTestId("chat-input")).toHaveAttribute(
            "data-can-stop",
            "true",
        );
        // The reader's own turn needs no notice.
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("passes the host's composer settings through", () => {
        renderThread({
            chatInputProps: {
                projectId: "p1",
                enableGlobalFileDrop: false,
                dropUploadsToProject: false,
            },
        });
        const input = screen.getByTestId("chat-input");
        expect(input).toHaveAttribute("data-project-id", "p1");
        expect(input).toHaveAttribute("data-global-drop", "false");
        expect(input).toHaveAttribute("data-drop-to-project", "false");
    });

    it("sends an ask-input answer through the same submit as the composer", () => {
        const { props: all } = renderThread();
        fireEvent.click(screen.getByRole("button", { name: "Answer prompt" }));
        expect(all.onSubmit).toHaveBeenCalledWith(
            { role: "user", content: "Answer", files: [] },
            { askInputsResponse: { type: "ask_inputs_response" } },
        );
    });
});

describe("ChatThread scrolling", () => {
    it("reserves room under the newest answer only while it arrives", () => {
        // A tall scroll viewport, so the reservation has something to fill.
        const clientHeight = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(800);
        try {
            const view = renderThread({ variant: "pane", isResponseLoading: true });
            act(() => resizeCallbacks.forEach((callback) => callback()));
            const reserved = () =>
                screen.getByTestId("assistant-message").style.minHeight;
            expect(parseFloat(reserved())).toBeGreaterThan(0);

            view.rerender(
                <div className="relative flex flex-col">
                    <ChatThread {...props({ variant: "pane", isResponseLoading: false })} />
                </div>,
            );
            expect(reserved()).toBe("0px");
        } finally {
            clientHeight.mockRestore();
        }
    });

    it("shows the scroll button away from the end and follows back to it", () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        const flush = () =>
            act(() => {
                while (frames.length) frames.shift()!(0);
            });
        renderThread({ variant: "pane" });
        const scroller = document.querySelector<HTMLElement>(
            '[data-slot="chat-messages-scroller"]',
        )!;
        Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
        Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        flush();
        const button = screen.getByRole("button", { name: "Scroll to bottom" });
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        fireEvent.click(button);
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });

        scroller.scrollTop = 1500;
        fireEvent.scroll(scroller);
        flush();
        expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
    });
});

describe("ChatThread background subagent reports", () => {
    const rawPrompt =
        "[Background subagents] This message comes from the application, not from the user.";
    const withReport: Message[] = [
        ...conversation,
        {
            id: "u2",
            role: "user",
            content: rawPrompt,
            origin: {
                kind: "agent_messages",
                messages: [
                    {
                        from: "research-1",
                        child_id: "7",
                        agent_type: "document_review",
                        kind: "report",
                        status: "done",
                        body: "Governed by Delaware law.",
                    },
                ],
            },
        },
        {
            id: "a2",
            role: "assistant",
            content: "",
            events: [{ type: "content", text: "Thanks, noted." }],
        },
    ];

    it("shows the report as a card, never as a prompt bubble or its raw text", () => {
        renderThread({
            messages: withReport,
            onEditBranch: vi.fn(),
            onRegenerate: vi.fn(),
        });
        expect(screen.getByText("research-1")).toBeInTheDocument();
        expect(screen.getByText("Governed by Delaware law.")).toBeInTheDocument();
        expect(screen.queryByText(rawPrompt)).not.toBeInTheDocument();
        // Only the person's own prompt is a user bubble.
        expect(screen.getAllByTestId("user-message")).toHaveLength(1);
    });

    it("offers no regenerate on the answer to a report, but keeps it on a prompt's", () => {
        renderThread({
            messages: withReport,
            onRegenerate: vi.fn(),
        });
        expect(screen.getAllByRole("button", { name: "Regenerate" })).toHaveLength(1);
    });
});
