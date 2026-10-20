import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type * as ModelToggleModule from "./ModelToggle";
import type { LiveDictationEvent } from "@/app/lib/voice/deviceSpeech";
import { VOICE_PREFERENCES_KEY } from "@/app/lib/voice/preferences";
import { ChatInput } from "./ChatInput";

const phone = vi.hoisted(() => ({
    liveDictationAvailable: vi.fn(async () => true),
    startLiveDictation: vi.fn(async (..._args: unknown[]) => undefined),
    stopLiveDictation: vi.fn(async () => "final words"),
    cancelLiveDictation: vi.fn(),
    fluidSpeechMiniAvailable: vi.fn(async () => true),
    prepareFluidSpeechMini: vi.fn(),
}));
const { transcribeAudio } = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));

import type * as DeviceSpeechModule from "@/app/lib/voice/deviceSpeech";
vi.mock("@/app/lib/voice/deviceSpeech", async (importOriginal) => ({
    ...(await importOriginal<typeof DeviceSpeechModule>()),
    ...phone,
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocuments: vi.fn(),
    uploadStandaloneDocuments: vi.fn(),
    transcribeAudio,
    getDictationVocabulary: vi.fn(async () => ({ terms: [] })),
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

let send: (event: LiveDictationEvent) => void;

function renderInput() {
    return render(<ChatInput onSubmit={vi.fn()} onCancel={vi.fn()} isLoading={false} canSend />);
}

async function startDictation() {
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Dictate prompt" }));
    });
    await screen.findByRole("button", { name: "Stop dictation" });
}

const text = (confirmed: string, volatile = "") =>
    act(() => send({ kind: "text", confirmed, volatile, ended: false }));

describe("ChatInput live dictation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        window.localStorage.setItem(
            VOICE_PREFERENCES_KEY,
            JSON.stringify({
                transcription: { engine: "device", language: "en-US" },
                speech: { engine: "operator" },
            }),
        );
        phone.liveDictationAvailable.mockResolvedValue(true);
        phone.stopLiveDictation.mockResolvedValue("final words");
        phone.startLiveDictation.mockImplementation(async (...args: unknown[]) => {
            send = args[0] as typeof send;
        });
        vi.mocked(useUserProfile).mockReturnValue({
            profile: { openRouterModels: [], vercelModels: [], openCodeGoModels: [], apiKeys: {} },
            loading: false,
            apiKeysDegraded: false,
        } as never);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        window.localStorage.clear();
    });

    it("streams the words into the read-only composer at the caret and replaces them on stop", async () => {
        renderInput();
        const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "Summarize . Thanks" } });
        textarea.setSelectionRange(10, 10);
        await startDictation();

        expect(textarea).toHaveAttribute("placeholder", "Listening…");
        expect(textarea).toHaveAttribute("readonly");
        expect(document.querySelector("[data-slot='live-dictation-text']")).toBeNull();

        await text("the contract", "and");
        expect(textarea).toHaveValue("Summarize the contract and. Thanks");
        expect(document.querySelector("[aria-live='polite']")).toHaveTextContent("the contract");

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
        });
        await waitFor(() => expect(textarea).toHaveValue("Summarize final words. Thanks"));
        expect(textarea).not.toHaveAttribute("readonly");
        expect(textarea.selectionStart).toBe("Summarize final words".length);
        expect(phone.stopLiveDictation).toHaveBeenCalledTimes(1);
    });

    it("shows the placeholder only while nothing has been heard", async () => {
        renderInput();
        const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
        await startDictation();
        expect(textarea).toHaveValue("");
        await text("", "hel");
        expect(textarea).toHaveValue("hel");
    });

    it("returns the composer exactly as it was on cancel", async () => {
        renderInput();
        const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "keep me" } });
        await startDictation();
        await text("something else");
        expect(textarea).toHaveValue("keep me something else");

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
        });
        await waitFor(() => expect(textarea).toHaveValue("keep me"));
        expect(textarea).not.toHaveAttribute("readonly");
        expect(phone.cancelLiveDictation).toHaveBeenCalled();
    });

    it("restores the text and editability when stopping fails", async () => {
        phone.stopLiveDictation.mockRejectedValue(new Error("boom"));
        renderInput();
        const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "draft" } });
        await startDictation();
        await text("heard");
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
        });
        await waitFor(() => expect(textarea).toHaveValue("draft"));
        expect(textarea).not.toHaveAttribute("readonly");
    });
});
