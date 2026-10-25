import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_VOICE_PREFERENCES,
    VOICE_PREFERENCES_KEY,
    defaultVoicePreferences,
    engineAvailable,
    loadVoicePreferences,
    parseVoicePreferences,
    resolveVoiceEngine,
    saveVoicePreferences,
    useVoicePreferences,
    voiceModeServerSpeech,
    type VoiceAvailability,
} from "./preferences";

const everything: VoiceAvailability = {
    deviceRecognition: false,
    deviceSpeech: false,
    operatorTranscription: true,
    operatorSpeech: true,
    openRouter: true,
    browserRecognition: true,
    browserSpeech: true,
    webgpu: true,
};

afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
});

/** The iPhone app's shell: the Capacitor bridge with Mike's speech plugin (which can speak, in newer builds). */
const inApp = (speaks = false) =>
    vi.stubGlobal("Capacitor", {
        PluginHeaders: [{ name: "MikeSpeech", methods: speaks ? [{ name: "transcribe" }, { name: "speak" }] : [{ name: "transcribe" }] }],
        nativePromise: vi.fn(),
    });

describe("parseVoicePreferences", () => {
    it("keeps valid choices and drops the rest field by field", () => {
        expect(parseVoicePreferences({ transcription: { engine: "openrouter", model: "qwen/qwen3-asr-0.6b" }, speech: { engine: "laser", voice: "af_heart" } })).toEqual({
            transcription: { engine: "openrouter", model: "qwen/qwen3-asr-0.6b" },
            speech: { engine: "operator", voice: "af_heart" },
        });
        expect(parseVoicePreferences(null)).toEqual(DEFAULT_VOICE_PREFERENCES);
        expect(parseVoicePreferences("nonsense")).toEqual(DEFAULT_VOICE_PREFERENCES);
    });

    it("keeps the read-aloud speed apart from the engine, so choosing another keeps it", () => {
        const saved = parseVoicePreferences({ speech: { engine: "operator" }, readAloudRate: 1.5 });
        expect(saved.readAloudRate).toBe(1.5);
        // Settings replace the speech choice whole; the speed stays.
        expect(parseVoicePreferences({ ...saved, speech: { engine: "browser" } }).readAloudRate).toBe(1.5);
        for (const junk of [0, -1, 99, Number.NaN, "2", null]) {
            expect(parseVoicePreferences({ readAloudRate: junk })).not.toHaveProperty("readAloudRate");
        }
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

describe("in the Android app", () => {
    it("reads aloud on the phone but dictates with the server until Fluid Speech Mini is downloaded and chosen", () => {
        vi.stubGlobal("Capacitor", {
            PluginHeaders: [{ name: "MikeSpeech", methods: [{ name: "transcribe" }, { name: "speak" }] }],
            nativePromise: vi.fn(),
            getPlatform: () => "android",
        });
        expect(defaultVoicePreferences()).toEqual({ transcription: { engine: "operator" }, speech: { engine: "device" } });
        saveVoicePreferences({ transcription: { engine: "device", model: "fluid-speech-mini" }, speech: { engine: "device" } });
        expect(loadVoicePreferences().transcription).toEqual({ engine: "device", model: "fluid-speech-mini" });
    });
});

describe("in the iPhone app", () => {
    it("dictates on the phone by default, and keeps a saved choice", () => {
        expect(defaultVoicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
        inApp();
        expect(defaultVoicePreferences().transcription).toEqual({ engine: "device", model: "fluid-speech-mini" });
        expect(loadVoicePreferences()).toEqual({ transcription: { engine: "device", model: "fluid-speech-mini" }, speech: { engine: "operator" } });
        expect(parseVoicePreferences({ speech: { engine: "browser" } }).transcription.engine).toBe("device");
        saveVoicePreferences({ transcription: { engine: "operator" }, speech: { engine: "operator" } });
        expect(loadVoicePreferences().transcription.engine).toBe("operator");
    });

    it("reads aloud on the phone by default when the app's plugin can speak", () => {
        inApp(true);
        expect(defaultVoicePreferences()).toEqual({
            transcription: { engine: "device", model: "fluid-speech-mini" },
            speech: { engine: "device" },
        });
    });

    it("offers the phone for dictation, and for read-aloud when its plugin can speak", () => {
        const phone = { ...everything, deviceRecognition: true };
        expect(engineAvailable("transcription", "device", phone)).toBe(true);
        expect(engineAvailable("transcription", "device", everything)).toBe(false);
        expect(engineAvailable("speech", "device", phone)).toBe(false);
        expect(engineAvailable("speech", "device", { ...phone, deviceSpeech: true })).toBe(true);
        expect(parseVoicePreferences({ speech: { engine: "device" } }).speech.engine).toBe("device");
    });

    it("falls back to the phone first when the chosen engine is missing", () => {
        const prefs = { transcription: { engine: "openrouter" as const }, speech: { engine: "operator" as const } };
        const phone = { ...everything, openRouter: false, deviceRecognition: true };
        expect(resolveVoiceEngine("transcription", prefs, phone)).toBe("device");
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

describe("stored languages, voices, blocked storage and the hook", () => {
    it("keeps a stored language and voice", () => {
        expect(parseVoicePreferences({
            transcription: { engine: "browser", language: "fr-FR" },
            speech: { engine: "browser", voice: "Amelie" },
        })).toMatchObject({ transcription: { language: "fr-FR" }, speech: { voice: "Amelie" } });
        expect(parseVoicePreferences({ speech: { engine: "openrouter", model: "m", voice: "  " } }).speech)
            .toEqual({ engine: "openrouter", model: "m" });
    });

    it("keeps an unsaved change in this tab when storage refuses writes", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const next = { ...DEFAULT_VOICE_PREFERENCES, speech: { engine: "browser" as const, voice: "Daniel" } };
        saveVoicePreferences(next);
        setItem.mockRestore();
        // getItem still reads the unsaved key, so the cache answers.
        window.localStorage.removeItem(VOICE_PREFERENCES_KEY);
        expect(loadVoicePreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
    });

    it("follows saves in this tab and storage events for its key from others", () => {
        const { result, unmount } = renderHook(() => useVoicePreferences());
        expect(result.current[0]).toEqual(DEFAULT_VOICE_PREFERENCES);
        act(() => result.current[1]({ ...DEFAULT_VOICE_PREFERENCES, speech: { engine: "browser" } }));
        expect(result.current[0].speech.engine).toBe("browser");

        act(() => {
            window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ speech: { engine: "webgpu" } }));
            window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
        });
        act(() => {
            window.dispatchEvent(new StorageEvent("storage", { key: VOICE_PREFERENCES_KEY }));
        });
        expect(result.current[0].speech.engine).toBe("webgpu");
        act(() => {
            window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ speech: { engine: "operator" } }));
            window.dispatchEvent(new StorageEvent("storage", { key: null }));
        });
        expect(result.current[0].speech.engine).toBe("operator");
        unmount();
    });
});

describe("server rendering", () => {
    it("renders the defaults on the server", () => {
        window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify({ speech: { engine: "browser" } }));
        function Probe() {
            return createElement("span", null, useVoicePreferences()[0].speech.engine);
        }
        expect(renderToString(createElement(Probe))).toContain("operator");
    });
});

describe("voice mode preferences", () => {
    it("keeps the browser voice mode flags that are booleans, and leaves the server off by default", () => {
        expect(parseVoicePreferences({}).voiceMode).toBeUndefined();
        expect(voiceModeServerSpeech(parseVoicePreferences({}))).toBe(false);
        expect(parseVoicePreferences({ voiceMode: "yes" }).voiceMode).toBeUndefined();
        expect(parseVoicePreferences({ voiceMode: { serverSpeech: "true", headphones: 1 } }).voiceMode).toBeUndefined();
        const parsed = parseVoicePreferences({ voiceMode: { serverSpeech: true, headphones: false, extra: 1 } });
        expect(parsed.voiceMode).toEqual({ serverSpeech: true, headphones: false });
        expect(voiceModeServerSpeech(parsed)).toBe(true);
    });

    it("stores the section with the rest", () => {
        saveVoicePreferences({ ...DEFAULT_VOICE_PREFERENCES, voiceMode: { serverSpeech: true } });
        expect(loadVoicePreferences().voiceMode).toEqual({ serverSpeech: true });
    });
});
