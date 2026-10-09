import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceOptions } from "@/app/lib/mikeApi";

const state = vi.hoisted(() => ({ options: null as unknown }));

vi.mock("@/app/lib/mikeApi", () => ({
    getVoiceOptions: vi.fn(async () => state.options),
    synthesizeSpeechDetailed: vi.fn(),
    transcribeAudio: vi.fn(),
}));
vi.mock("@/app/lib/voice/browserSpeech", () => ({
    browserSpeechSupported: () => true,
    browserVoices: async () => [],
    installOnDeviceRecognition: vi.fn(),
    onDeviceRecognitionStatus: async () => "unavailable",
    speakWithBrowser: vi.fn(),
}));

import { VoiceSettings } from "./VoiceSettings";
import { loadVoicePreferences } from "@/app/lib/voice/preferences";

const catalog = {
    speech: [
        { id: "hexgrad/kokoro-82m", name: "Kokoro 82M", price: { unit: "per_1k_chars", usd: 0.00062 }, voices: ["af_alloy", "af_heart"] },
    ],
    transcription: [
        { id: "qwen/qwen3-asr-0.6b", name: "Qwen3 ASR 0.6B", price: { unit: "per_minute", usd: 0.0002 }, voices: [] },
    ],
};

const options = (overrides: Partial<VoiceOptions> = {}): VoiceOptions => ({
    strict_private: false,
    operator: { transcription: { model: "whisper-large-v3-turbo" }, speech: { model: "tts-1", voice: "alloy" } },
    openrouter: { available: true, catalog: catalog as VoiceOptions["openrouter"]["catalog"] },
    ...overrides,
});

beforeEach(() => {
    window.localStorage.clear();
    state.options = options();
});
afterEach(() => window.localStorage.clear());

describe("VoiceSettings", () => {
    it("offers the engines this deployment and browser have, with the operator chosen", async () => {
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        const pills = Array.from(dictation.querySelectorAll("button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
        // No on-device recognition in this browser, so "This browser" is not offered for dictation.
        expect(pills).toEqual([
            ["This server", "true"],
            ["OpenRouter", "false"],
            ["Open model in browser", "false"],
        ]);
        expect(screen.getByText(/Uses whisper-large-v3-turbo/)).toBeInTheDocument();
    });

    it("saves an OpenRouter choice and shows model prices", async () => {
        render(<VoiceSettings />);
        const speech = await screen.findByRole("group", { name: "Read-aloud engine" });
        fireEvent.click(Array.from(speech.querySelectorAll("button")).find((b) => b.textContent === "OpenRouter")!);
        await waitFor(() => expect(loadVoicePreferences().speech.engine).toBe("openrouter"));
        expect(screen.getByRole("button", { name: "Read-aloud model" })).toHaveTextContent("Choose a model");
    });

    it("does not offer OpenRouter in strict private mode and says why", async () => {
        state.options = options({ strict_private: true, openrouter: { available: false, reason: "strict_private", catalog: null } });
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        expect(dictation).not.toHaveTextContent("OpenRouter");
        expect(screen.getAllByText(/strict private mode/).length).toBeGreaterThan(0);
    });

    it("asks before setting up a browser model", async () => {
        render(<VoiceSettings />);
        const dictation = await screen.findByRole("group", { name: "Dictation engine" });
        fireEvent.click(Array.from(dictation.querySelectorAll("button")).find((b) => b.textContent === "Open model in browser")!);
        expect(await screen.findByRole("button", { name: "Check how long setup takes" })).toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("says so when the saved engine cannot run here", async () => {
        state.options = options({ operator: { transcription: null, speech: null } });
        render(<VoiceSettings />);
        await screen.findByRole("group", { name: "Dictation engine" });
        expect(screen.getAllByRole("status").map((n) => n.textContent)).toEqual([
            "This deployment has no speech server configured. Choose an engine above.",
            "This deployment has no speech server configured. Choose an engine above.",
        ]);
    });
});
