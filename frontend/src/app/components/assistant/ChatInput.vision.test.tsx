/**
 * An attached image goes into the message itself, so the composer will not
 * send one to a model that cannot see. It says why, and a `/nr` note, which
 * needs no model, still goes.
 */
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { Document } from "@/app/components/shared/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

const vision = vi.hoisted(() => ({ answers: {} as Record<string, boolean> }));

vi.mock("@/app/lib/mikeApi", () => ({ listWorkflows: vi.fn(async () => []) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({ useConfiguredModels: () => [] }));
vi.mock("@/app/hooks/useModelVision", () => ({
    useModelVision: (ids: readonly string[]) =>
        Object.fromEntries(ids.filter((id) => id in vision.answers).map((id) => [id, vision.answers[id]])),
}));
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
}

const photo = { id: "d1", filename: "site.jpg", file_type: "jpg" } as Document;
const lease = { id: "d2", filename: "lease.pdf", file_type: "pdf" } as Document;

function renderComposer(model: string, attach: Document) {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            lastSelectedChatModel: model,
            lastSelectedReasoningLevel: "high",
            apiKeys: undefined,
        },
        loading: false,
        apiKeysDegraded: false,
        persistChatModelSelection: vi.fn(async () => true),
        persistChatReasoningSelection: vi.fn(async () => true),
    } as unknown as ReturnType<typeof useUserProfile>);
    const ref = createRef<ChatInputHandle>();
    const onSubmit = vi.fn();
    render(<ChatInput ref={ref} chatKey="c1" chatModel={model} onSubmit={onSubmit} onCancel={vi.fn()} isLoading={false} />);
    act(() => ref.current!.addDoc(attach));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "What is this?" } });
    return { onSubmit };
}

const sendButton = () => screen.getByRole("button", { name: "Send message" });

describe("ChatInput with an image attached", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vision.answers = { "gpt-5.6-luna": false, "gpt-5.6-sol": true };
    });

    it("blocks a model that cannot see, and says what to do", () => {
        const { onSubmit } = renderComposer("gpt-5.6-luna", photo);

        expect(screen.getByRole("status")).toHaveTextContent(/can.t see images/);
        expect(screen.getByRole("status")).toHaveTextContent(/Sees images/);
        expect(sendButton()).toBeDisabled();
        fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("still sends a /nr note, which needs no model", () => {
        const { onSubmit } = renderComposer("gpt-5.6-luna", photo);
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "/nr the site photo" } });

        expect(sendButton()).toBeEnabled();
        fireEvent.click(sendButton());
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ noResponse: true }));
    });

    it("sends to a model that can see", () => {
        const { onSubmit } = renderComposer("gpt-5.6-sol", photo);

        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        fireEvent.click(sendButton());
        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ files: [expect.objectContaining({ filename: "site.jpg" })] }),
        );
    });

    it("says nothing while the answer is unknown, or with no image attached", () => {
        vision.answers = {};
        renderComposer("gpt-5.6-luna", photo);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(sendButton()).toBeEnabled();
    });

    it("ignores the model's vision for a document attachment", () => {
        renderComposer("gpt-5.6-luna", lease);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(sendButton()).toBeEnabled();
    });
});
