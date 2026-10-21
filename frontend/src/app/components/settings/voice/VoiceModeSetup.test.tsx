import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VoiceEngineModule from "@/app/lib/voice/voiceEngine";
import type { VoiceEvent, VoiceStatus } from "@/app/lib/voice/voiceEngine";

const engine = vi.hoisted(() => ({
    supported: vi.fn(() => true),
    status: vi.fn(),
    install: vi.fn(),
    remove: vi.fn(),
    forget: vi.fn(),
    forgetSupported: vi.fn(() => true),
    handlers: new Set<(event: VoiceEvent) => void>(),
}));
vi.mock("@/app/lib/voice/voiceEngine", async (importOriginal) => ({
    ...(await importOriginal<typeof VoiceEngineModule>()),
    voiceChatSupported: engine.supported,
    voiceStatus: engine.status,
    voiceInstall: engine.install,
    voiceRemove: engine.remove,
    voiceForgetSpeaker: engine.forget,
    voiceForgetSpeakerSupported: engine.forgetSupported,
    onVoiceEvent: (handler: (event: VoiceEvent) => void) => {
        engine.handlers.add(handler);
        return () => engine.handlers.delete(handler);
    },
}));

import {
    VoiceEngineError,
    VOICE_FORGET_FAILURE_MESSAGE,
    VOICE_INSTALL_FAILURE_MESSAGE,
    VOICE_REMOVE_FAILURE_MESSAGE,
} from "@/app/lib/voice/voiceEngine";
import { VoiceModeSetup } from "./VoiceModeSetup";

const INSTALLED: VoiceStatus = { available: true, missing: [], downloadBytes: 0, speakerLearned: false };
const MISSING: VoiceStatus = {
    available: false,
    missing: ["vad", "eou", "smart-turn", "speaker", "speaker-campplus"],
    downloadBytes: 42e6,
    speakerLearned: false,
};

beforeEach(() => {
    engine.supported.mockReturnValue(true);
    engine.status.mockReset();
    engine.install.mockReset();
    engine.remove.mockReset();
    engine.forget.mockReset();
    engine.forgetSupported.mockReturnValue(true);
    engine.handlers.clear();
});

describe("VoiceModeSetup", () => {
    it("shows nothing outside an app build with the voice engine", () => {
        engine.supported.mockReturnValue(false);
        const { container } = render(<VoiceModeSetup />);
        expect(container).toBeEmptyDOMElement();
        expect(engine.status).not.toHaveBeenCalled();
    });

    it("ignores a status that arrives after it is gone", async () => {
        let answer: (status: VoiceStatus) => void = () => {};
        engine.status.mockReturnValue(new Promise<VoiceStatus>((resolve) => (answer = resolve)));
        const { unmount } = render(<VoiceModeSetup />);
        unmount();
        await act(async () => answer(INSTALLED));
        expect(screen.queryByText("Voice mode")).not.toBeInTheDocument();
    });

    it("removes the installed models and shows the size of downloading them again", async () => {
        engine.status.mockResolvedValue(INSTALLED);
        engine.remove.mockResolvedValue(MISSING);
        render(<VoiceModeSetup />);
        fireEvent.click(await screen.findByRole("button", { name: "Remove voice mode models" }));
        expect(await screen.findByRole("button", { name: "Download speech models" })).toBeInTheDocument();
        expect(screen.getByText(/about 42 MB, downloaded once/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove voice mode models" })).not.toBeInTheDocument();
    });

    it("offers removal when only another model is missing", async () => {
        engine.status.mockResolvedValue({ available: false, missing: ["phonon"], downloadBytes: 160e6, speakerLearned: false });
        render(<VoiceModeSetup />);
        expect(await screen.findByRole("button", { name: "Remove voice mode models" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Download speech models" })).toBeInTheDocument();
    });

    it("says why the models could not be removed", async () => {
        engine.status.mockResolvedValue(INSTALLED);
        engine.remove.mockRejectedValueOnce(new VoiceEngineError("Turn off voice mode before removing its models.", "busy"));
        render(<VoiceModeSetup />);
        fireEvent.click(await screen.findByRole("button", { name: "Remove voice mode models" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Turn off voice mode before removing its models.");
        engine.remove.mockRejectedValueOnce("odd");
        fireEvent.click(screen.getByRole("button", { name: "Remove voice mode models" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(VOICE_REMOVE_FAILURE_MESSAGE));
    });

    it("downloads with progress and reads the status again", async () => {
        engine.status.mockResolvedValueOnce(MISSING).mockResolvedValueOnce(INSTALLED);
        let finish: (available: boolean) => void = () => {};
        engine.install.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
        render(<VoiceModeSetup />);
        fireEvent.click(await screen.findByRole("button", { name: "Download speech models" }));
        const bar = await screen.findByRole("progressbar", { name: "Downloading speech models" });
        expect(bar).toHaveAttribute("aria-valuenow", "0");
        act(() => {
            for (const handler of engine.handlers) {
                handler({ type: "state", state: "listening" });
                handler({ type: "install", fraction: 0.5 });
            }
        });
        expect(bar).toHaveAttribute("aria-valuenow", "50");
        await act(async () => finish(true));
        expect(await screen.findByText(/speech models are on this phone/)).toBeInTheDocument();
        expect(engine.handlers.size).toBe(0);
    });

    it("says why the download failed", async () => {
        engine.status.mockResolvedValue(MISSING);
        engine.install.mockRejectedValueOnce(new VoiceEngineError("No connection."));
        render(<VoiceModeSetup />);
        fireEvent.click(await screen.findByRole("button", { name: "Download speech models" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("No connection.");
        engine.install.mockRejectedValueOnce("odd");
        fireEvent.click(screen.getByRole("button", { name: "Download speech models" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(VOICE_INSTALL_FAILURE_MESSAGE));
    });

    it("says voice mode learns your voice, and offers to forget it once learned", async () => {
        engine.status.mockResolvedValue(INSTALLED);
        const { unmount } = render(<VoiceModeSetup />);
        expect(await screen.findByText(/learns your voice from your first few turns/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Forget my voice" })).not.toBeInTheDocument();
        unmount();

        engine.status.mockResolvedValue({ ...INSTALLED, speakerLearned: true });
        engine.forget.mockRejectedValueOnce("odd").mockResolvedValueOnce(INSTALLED);
        render(<VoiceModeSetup />);
        expect(await screen.findByText(/knows your voice and ignores other voices/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Forget my voice" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(VOICE_FORGET_FAILURE_MESSAGE);
        fireEvent.click(screen.getByRole("button", { name: "Forget my voice" }));
        expect(await screen.findByText(/learns your voice from your first few turns/)).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps the model that checks voices, marked as pressed", async () => {
        engine.status.mockResolvedValue(INSTALLED);
        render(<VoiceModeSetup />);
        const group = await screen.findByRole("group", { name: "Check voices with" });
        expect(group.querySelectorAll("button")).toHaveLength(4);
        expect(screen.getByRole("button", { name: "WeSpeaker" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "Both" }));
        expect(screen.getByRole("button", { name: "Both" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "WeSpeaker" })).toHaveAttribute("aria-pressed", "false");
        expect(window.localStorage.getItem("mike.voice.speakerModel.v1")).toBe("both");
        window.localStorage.clear();
    });

    it("leaves out the voice row in an app build that cannot forget it", async () => {
        engine.forgetSupported.mockReturnValue(false);
        engine.status.mockResolvedValue({ ...INSTALLED, speakerLearned: true });
        render(<VoiceModeSetup />);
        expect(await screen.findByText(/speech models are on this phone/)).toBeInTheDocument();
        expect(screen.queryByText("Your voice")).not.toBeInTheDocument();
    });
});
