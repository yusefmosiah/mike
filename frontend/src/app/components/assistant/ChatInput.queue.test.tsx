import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ChatQueueController } from "./useChatQueue";
import type { ChatQueueEntry } from "@/app/lib/chatQueue";
import { ChatInput, type ChatInputHandle, type ChatInputProps } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({ listWorkflows: vi.fn(async () => []) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({ useConfiguredModels: () => [] }));
vi.mock("@/app/hooks/useModelVision", () => ({ useModelVision: () => ({}) }));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));
vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({ ApiKeyMissingPopup: () => null }));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const entry = (overrides: Partial<ChatQueueEntry> = {}): ChatQueueEntry => ({
    id: "q1",
    text: "What about the notice period?",
    docs: [],
    workflow: null,
    model: "claude-sonnet-5",
    effort: "high",
    stampedAt: 1,
    status: "queued",
    ...overrides,
});

function queueController(
    entries: ChatQueueEntry[] = [],
    paused: ChatQueueController["paused"] = null,
): ChatQueueController {
    return {
        entries,
        paused,
        enqueue: vi.fn(),
        remove: vi.fn(),
        reorder: vi.fn(),
        clear: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
    };
}

function renderComposer(props: Partial<ChatInputProps> = {}) {
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const base: ChatInputProps = {
        chatKey: "c1",
        chatModel: "gpt-5.6-sol",
        chatReasoningLevel: "high",
        onSubmit,
        onCancel,
        isLoading: false,
        canSend: true,
    };
    const view = render(<ChatInput ref={ref} {...base} {...props} />);
    const rerender = (next: Partial<ChatInputProps>) =>
        view.rerender(<ChatInput ref={ref} {...base} {...next} />);
    return { ref, onSubmit, onCancel, rerender, unmount: view.unmount };
}

const textbox = () => screen.getByRole("combobox");

function type(text: string) {
    fireEvent.change(textbox(), { target: { value: text } });
}

function submit() {
    fireEvent.keyDown(textbox(), { key: "Enter", metaKey: true });
}

describe("composer message queue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.mocked(useUserProfile).mockReturnValue({
            profile: {
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: [],
                lastSelectedChatModel: "gpt-5.6-sol",
                lastSelectedReasoningLevel: "high",
                apiKeys: undefined,
            },
            loading: false,
            apiKeysDegraded: false,
            persistChatModelSelection: vi.fn(async () => true),
            persistChatReasoningSelection: vi.fn(async () => true),
        } as unknown as ReturnType<typeof useUserProfile>);
    });

    it("queues the written message while a turn runs instead of sending it", async () => {
        const queue = queueController();
        const { onSubmit } = renderComposer({ isLoading: true, queue });
        type("  and the break clause?  ");

        await act(async () => submit());

        expect(queue.enqueue).toHaveBeenCalledWith({
            text: "and the break clause?",
            docs: [],
            workflow: null,
            model: "gpt-5.6-sol",
            effort: "high",
        });
        expect(onSubmit).not.toHaveBeenCalled();
        expect(textbox()).toHaveValue("");
    });

    it("keeps refusing a send during a turn when no queue is wired", async () => {
        const { onSubmit } = renderComposer({ isLoading: true });
        type("cannot go anywhere");

        await act(async () => submit());

        expect(onSubmit).not.toHaveBeenCalled();
        expect(textbox()).toHaveValue("cannot go anywhere");
    });

    it("stamps attachments that finished uploading before the message was queued", async () => {
        const queue = queueController();
        const { ref } = renderComposer({ isLoading: true, queue });
        const document = {
            id: "d1",
            filename: "Lease.pdf",
            file_type: "pdf",
            project_id: null,
            storage_path: null,
            pdf_storage_path: null,
            size_bytes: null,
            page_count: null,
            structure_tree: null,
            status: "ready" as const,
            created_at: null,
            current_version_id: "v1",
            active_version_number: 2,
            confidential: false,
        };
        act(() => ref.current?.addDoc(document));
        type("Check the notice period");

        await act(async () => submit());

        expect(queue.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                text: "Check the notice period",
                docs: [document],
            }),
        );
    });

    it("shows each entry's text and attachment count without model labels, and offers reorder and delete", () => {
        const doc = {
            id: "d1",
            filename: "Lease.pdf",
            file_type: "pdf",
            project_id: null,
            storage_path: null,
            pdf_storage_path: null,
            size_bytes: null,
            page_count: null,
            structure_tree: null,
            status: "ready" as const,
            created_at: null,
            current_version_id: "v1",
            active_version_number: 2,
            confidential: false,
        };
        const first = entry({
            id: "q1",
            text: "First question",
            docs: [doc],
            model: "claude-sonnet-5",
            effort: "high",
        });
        const second = entry({ id: "q2", text: "Second question", model: "gpt-5.6-sol", effort: "low" });
        const queue = queueController([first, second]);
        renderComposer({ queue });

        expect(screen.getByText("2 queued messages")).toBeInTheDocument();
        expect(screen.getByText("First question")).toBeInTheDocument();
        expect(screen.getByText("1 attachment")).toBeInTheDocument();
        expect(screen.queryByText(/Claude Sonnet 5/)).toBeNull();
        expect(screen.queryByText(/GPT 5\.6 Sol/)).toBeNull();
        expect(screen.queryByText(/effort/i)).toBeNull();
        expect(
            screen.getByRole("button", { name: "Move queued message 1 up" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Move queued message 2 down" }),
        ).toBeDisabled();

        fireEvent.click(
            screen.getByRole("button", { name: "Move queued message 2 up" }),
        );
        expect(queue.reorder).toHaveBeenCalledWith("q2", -1);

        fireEvent.click(
            screen.getByRole("button", { name: "Move queued message 1 down" }),
        );
        expect(queue.reorder).toHaveBeenCalledWith("q1", 1);

        fireEvent.click(
            screen.getByRole("button", { name: "Delete queued message 1" }),
        );
        expect(queue.remove).toHaveBeenCalledWith("q1");
    });

    it("surfaces a stopped queue and asks keep or discard", () => {
        const queue = queueController([entry()], {
            reason: "stopped",
            at: 1,
        });
        renderComposer({ queue });

        expect(screen.getByText("Queue paused")).toBeInTheDocument();
        expect(
            screen.getByText(/You stopped the response/),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Keep queue" }));
        expect(queue.resume).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        expect(queue.clear).toHaveBeenCalledOnce();
    });

    it("says a branch invalidated the queue rather than firing it", () => {
        const queue = queueController([entry()], {
            reason: "branch",
            at: 1,
        });
        renderComposer({ queue });

        expect(screen.getByText("Queue needs a decision")).toBeInTheDocument();
        expect(
            screen.getByText(/The thread branched after these were written/),
        ).toBeInTheDocument();
    });

    it("pauses the queue when the reader stops the response", () => {
        const queue = queueController([entry()]);
        const { onCancel } = renderComposer({ isLoading: true, queue });

        fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

        expect(queue.pause).toHaveBeenCalledWith("stopped");
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("offers a Queue control while a turn runs, and queues on click", async () => {
        const queue = queueController();
        const { onSubmit } = renderComposer({ isLoading: true, queue });
        type("Second thought");

        expect(
            screen.queryByRole("button", { name: "Queue message" }),
        ).not.toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
        });

        expect(queue.enqueue).toHaveBeenCalledOnce();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not offer a Queue control when the composer is empty or closed", () => {
        const queue = queueController();
        renderComposer({ isLoading: true, queue });
        expect(
            screen.queryByRole("button", { name: "Queue message" }),
        ).toBeNull();
    });

    it("queues a no-reply note while a turn runs", async () => {
        const queue = queueController();
        renderComposer({ isLoading: true, queue });
        type("/nr remember this");

        await act(async () => submit());

        expect(queue.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                text: "remember this",
                noResponse: true,
                workflow: null,
            }),
        );
    });
});
