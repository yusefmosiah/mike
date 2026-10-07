import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type * as ModelToggleModule from "./ModelToggle";
import { ChatInput } from "./ChatInput";

const { transcribeAudio } = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocuments: vi.fn(),
    uploadStandaloneDocuments: vi.fn(),
    transcribeAudio,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: vi.fn(),
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof ModelToggleModule>()),
    ModelToggle: () => null,
}));
vi.mock("./UploadOverlay", () => ({
    UploadOverlay: ({ warning }: { warning?: string | null }) =>
        warning ? <div role="alert">{warning}</div> : null,
}));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: vi.fn(() => null),
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: vi.fn(() => null),
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

/** MediaRecorder double mirroring the dataavailable-then-stop event order. */
class MockMediaRecorder {
    static isTypeSupported = () => true;

    state: "inactive" | "recording" = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType ?? "";
    }

    start() {
        this.state = "recording";
    }

    stop() {
        this.state = "inactive";
        this.ondataavailable?.({
            data: new Blob(["clip"], { type: this.mimeType || "audio/webm" }),
        });
        this.onstop?.();
    }
}

const stopTrack = vi.fn();
const getUserMedia = vi.fn<() => Promise<MediaStream>>();
const fakeStream = () =>
    ({
        getTracks: () => [{ stop: stopTrack }],
    }) as unknown as MediaStream;

function renderInput(
    props: Partial<ComponentProps<typeof ChatInput>> = {},
) {
    return render(
        <ChatInput
            onSubmit={vi.fn()}
            onCancel={vi.fn()}
            isLoading={false}
            canSend
            {...props}
        />,
    );
}

describe("ChatInput dictation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.stubGlobal("MediaRecorder", MockMediaRecorder);
        getUserMedia.mockResolvedValue(fakeStream());
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia },
        });
        transcribeAudio.mockResolvedValue({ text: "contract" });
        // ChatInput reads only these fields; the provider is mocked here.
        vi.mocked(useUserProfile).mockReturnValue({
            profile: {
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: [],
                apiKeys: {},
            },
            loading: false,
            apiKeysDegraded: false,
        } as never);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(navigator, "mediaDevices");
    });

    it("offers dictation beside the message controls", () => {
        renderInput();

        expect(
            screen.getByRole("button", { name: "Dictate prompt" }),
        ).toBeEnabled();
    });

    it("closes dictation while a response is loading", () => {
        renderInput({ isLoading: true });

        expect(
            screen.getByRole("button", { name: "Dictate prompt" }),
        ).toBeDisabled();
    });

    it("hides dictation on a read-only composer", () => {
        renderInput({ canSend: false });

        expect(
            screen.queryByRole("button", { name: "Dictate prompt" }),
        ).toBeNull();
    });

    it("inserts the finished transcript at the caret without submitting", async () => {
        const onSubmit = vi.fn();
        renderInput({ onSubmit });
        const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "Summarize the ." } });
        textarea.setSelectionRange(14, 14);

        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Dictate prompt" }),
            );
        });

        const stopButton = await screen.findByRole("button", {
            name: "Stop dictation",
        });
        expect(screen.getByLabelText("Dictation time")).toHaveTextContent(
            "00:00",
        );

        await act(async () => {
            fireEvent.click(stopButton);
        });

        await waitFor(() =>
            expect(textarea).toHaveValue("Summarize the contract."),
        );
        expect(transcribeAudio).toHaveBeenCalledTimes(1);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(textarea).not.toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Stop dictation" }),
        ).toBeNull();
    });

    it("shows a denied microphone through the composer warning surface", async () => {
        getUserMedia.mockRejectedValue(
            new DOMException("Permission denied", "NotAllowedError"),
        );
        renderInput();

        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Dictate prompt" }),
            );
        });

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Microphone access denied",
            ),
        );
        expect(screen.getByRole("combobox")).toHaveValue("");
        expect(transcribeAudio).not.toHaveBeenCalled();
    });
});
