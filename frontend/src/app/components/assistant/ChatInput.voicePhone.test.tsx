import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type * as MikeApiModule from "@/app/lib/mikeApi";
import type * as ModelToggleModule from "./ModelToggle";
import type { Message } from "../shared/types";
import { VOICE_PREFERENCES_KEY } from "@/app/lib/voice/preferences";
import { useVoiceChat } from "@/app/hooks/useVoiceChat";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof MikeApiModule>()),
    listWorkflows: vi.fn(async () => []),
    getDictationVocabulary: vi.fn(async () => ({ terms: [] })),
    recordSpokenAnswer: vi.fn(async () => undefined),
}));
const web = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/app/lib/voice/web/support", () => ({ webVoiceSupported: () => true }));
vi.mock("@/app/lib/voice/web/prime", () => ({ primeWebAudio: vi.fn() }));
vi.mock("@/app/lib/voice/web/webBackend", () => ({
    WebVoiceBackend: class {
        status = web.status;
    },
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: vi.fn() }));
vi.mock("@/app/hooks/useConfiguredModels", () => ({ useConfiguredModels: () => [] }));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(() => "openai"),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof ModelToggleModule>()),
    ModelToggle: () => null,
}));
vi.mock("./UploadOverlay", () => ({
    UploadOverlay: ({ warning }: { warning?: string | null }) => (warning ? <div role="alert">{warning}</div> : null),
}));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: vi.fn(() => null) }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: vi.fn(() => null) }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: ({ open }: { open: boolean }) => (open ? <div>Add an API key</div> : null),
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const thread: Message[] = [{ id: "u0", role: "user", content: "Hello" }];
const nativePromise = vi.fn();

function agent(value: string) {
    Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

async function tapVoice() {
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
    });
}

/** A composer with a voice session held above it, like a thread. */
function VoiceComposer(props: Omit<Parameters<typeof ChatInput>[0], "voice">) {
    const inputRef = useRef<ChatInputHandle>(null);
    const session = useVoiceChat({
        chatId: "chat-1",
        messages: thread,
        isResponseLoading: false,
        send: (text) => inputRef.current?.sendVoice(text) ?? false,
        cancelResponse: () => props.onCancel?.(),
    });
    return <ChatInput ref={inputRef} {...props} voice={{ session }} />;
}

function renderInput() {
    return render(
        <VoiceComposer
            chatKey="chat-1"
            chatModel="gpt-5.6-luna"
            chatReasoningLevel="high"
            onSubmit={vi.fn()}
            onCancel={vi.fn()}
            isLoading={false}
            canSend
        />,
    );
}

describe("ChatInput voice button in a browser", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        web.status.mockResolvedValue({
            available: false, missing: [], downloadBytes: 0, preparing: false, firstTime: false, ready: [],
            speakerLearned: false, unavailableMessage: "stub",
        });
        vi.mocked(useUserProfile).mockReturnValue({
            profile: { openRouterModels: [], vercelModels: [], openCodeGoModels: [], apiKeys: {} },
            loading: false,
            apiKeysDegraded: false,
            persistChatModelSelection: vi.fn(),
            persistChatReasoningSelection: vi.fn(),
        } as never);
    });

    afterEach(() => {
        agent(MAC);
        vi.unstubAllGlobals();
    });

    it("opens the app modal on a phone browser instead of starting, then remembers the browser choice", async () => {
        agent(IPHONE);
        renderInput();
        await tapVoice();
        expect(screen.getByRole("dialog", { name: "Voice mode" })).toBeInTheDocument();
        expect(web.status).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Use voice mode in this browser" }));
        });
        expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
        expect(web.status).toHaveBeenCalledTimes(1);
        expect(JSON.parse(window.localStorage.getItem(VOICE_PREFERENCES_KEY)!).voiceMode.phoneBrowser).toBe(true);
    });

    it("goes straight to voice mode once the browser has been chosen", async () => {
        agent(IPHONE);
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ voiceMode: { phoneBrowser: true } }));
        renderInput();
        await tapVoice();
        expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
        expect(web.status).toHaveBeenCalledTimes(1);
    });

    it("closing the modal starts nothing and remembers nothing", async () => {
        agent(IPHONE);
        renderInput();
        await tapVoice();
        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
        expect(web.status).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(VOICE_PREFERENCES_KEY)).toBeNull();
    });

    it("starts at once in a computer's browser", async () => {
        agent(MAC);
        renderInput();
        await tapVoice();
        expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
        expect(web.status).toHaveBeenCalledTimes(1);
    });

    it("starts at once in the native app, even on a phone", async () => {
        agent(IPHONE);
        nativePromise.mockImplementation(async (_plugin: string, method: string) =>
            method === "voiceStatus" ? { available: false, missing: [], downloadBytes: 0 } : undefined,
        );
        vi.stubGlobal("Capacitor", {
            PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "voiceStatus" }] }],
            nativePromise,
            addListener: vi.fn(() => ({ remove: vi.fn() })),
        });
        renderInput();
        await tapVoice();
        expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voiceStatus", undefined);
        expect(web.status).not.toHaveBeenCalled();
    });
});
