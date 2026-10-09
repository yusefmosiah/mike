import { afterEach, describe, expect, it } from "vitest";

import {
    DEFAULT_VOICE_PREFERENCES,
    VOICE_PREFERENCES_KEY,
    loadVoicePreferences,
    parseVoicePreferences,
    resolveVoiceEngine,
    saveVoicePreferences,
    type VoiceAvailability,
} from "./preferences";

const everything: VoiceAvailability = {
    operatorTranscription: true,
    operatorSpeech: true,
    openRouter: true,
    browserRecognition: true,
    browserSpeech: true,
    webgpu: true,
};

afterEach(() => window.localStorage.clear());

describe("parseVoicePreferences", () => {
    it("keeps valid choices and drops the rest field by field", () => {
        expect(parseVoicePreferences({ transcription: { engine: "openrouter", model: "qwen/qwen3-asr-0.6b" }, speech: { engine: "laser", voice: "af_heart" } })).toEqual({
            transcription: { engine: "openrouter", model: "qwen/qwen3-asr-0.6b" },
            speech: { engine: "operator", voice: "af_heart" },
        });
        expect(parseVoicePreferences(null)).toEqual(DEFAULT_VOICE_PREFERENCES);
        expect(parseVoicePreferences("nonsense")).toEqual(DEFAULT_VOICE_PREFERENCES);
    });
});

describe("load and save", () => {
    it("round-trips through this browser's storage and survives junk", () => {
        expect(loadVoicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
        saveVoicePreferences({ transcription: { engine: "browser" }, speech: { engine: "webgpu", voice: "bf_emma" } });
        expect(loadVoicePreferences()).toEqual({ transcription: { engine: "browser" }, speech: { engine: "webgpu", voice: "bf_emma" } });
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, "{not json");
        expect(loadVoicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
    });
});

describe("resolveVoiceEngine", () => {
    it("uses the chosen engine when it is available", () => {
        const prefs = { transcription: { engine: "webgpu" as const }, speech: { engine: "openrouter" as const } };
        expect(resolveVoiceEngine("transcription", prefs, everything)).toBe("webgpu");
        expect(resolveVoiceEngine("speech", prefs, everything)).toBe("openrouter");
    });

    it("never falls back to OpenRouter, and drops it in strict private mode", () => {
        const strict = { ...everything, openRouter: false };
        const prefs = { transcription: { engine: "openrouter" as const }, speech: { engine: "openrouter" as const } };
        expect(resolveVoiceEngine("speech", prefs, strict)).toBe("operator");
        const nothingElse = { ...strict, operatorSpeech: false, browserSpeech: false, webgpu: false };
        expect(resolveVoiceEngine("speech", prefs, nothingElse)).toBeNull();
    });

    it("falls back operator, then browser, then webgpu", () => {
        const prefs = { transcription: { engine: "operator" as const }, speech: { engine: "operator" as const } };
        expect(resolveVoiceEngine("transcription", prefs, { ...everything, operatorTranscription: false })).toBe("browser");
        expect(resolveVoiceEngine("transcription", prefs, { ...everything, operatorTranscription: false, browserRecognition: false })).toBe("webgpu");
    });
});
