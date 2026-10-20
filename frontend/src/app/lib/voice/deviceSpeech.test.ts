import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DEVICE_SPEAK_FAILURE_MESSAGE,
    DEVICE_TRANSCRIBE_FAILURE_MESSAGE,
    DeviceSpeechError,
    deviceSpeechStatus,
    deviceSpeechSupported,
    deviceVoices,
    deviceVoiceSupported,
    FLUID_MINI_ENGINE,
    fluidSpeechMiniAvailable,
    installDeviceSpeech,
    isEnglishLanguage,
    resetFluidSpeechMiniAvailability,
    speakOnDevice,
    transcribeOnDevice,
} from "./deviceSpeech";

const nativePromise = vi.fn();

function inApp(headers: { name: string; methods?: { name: string }[] }[] = [{ name: "MikeSpeech" }]) {
    vi.stubGlobal("Capacitor", { PluginHeaders: headers, nativePromise });
}

afterEach(() => {
    resetFluidSpeechMiniAvailability();
    vi.unstubAllGlobals();
    nativePromise.mockReset();
});

describe("deviceSpeechSupported", () => {
    it("is true only inside the app whose shell has the plugin", () => {
        expect(deviceSpeechSupported()).toBe(false);
        vi.stubGlobal("Capacitor", { PluginHeaders: [{ name: "MikeSpeech" }] });
        expect(deviceSpeechSupported()).toBe(false);
        inApp([{ name: "Preferences" }]);
        expect(deviceSpeechSupported()).toBe(false);
        vi.stubGlobal("Capacitor", { nativePromise });
        expect(deviceSpeechSupported()).toBe(false);
        inApp();
        expect(deviceSpeechSupported()).toBe(true);
    });

    it("is false without a window (server rendering)", () => {
        vi.stubGlobal("window", undefined);
        expect(deviceSpeechSupported()).toBe(false);
    });
});

describe("deviceSpeechStatus and installDeviceSpeech", () => {
    it("report unavailable in a browser", async () => {
        expect(await deviceSpeechStatus()).toBe("unavailable");
        expect(await installDeviceSpeech()).toBe("unavailable");
    });

    it("pass the language and read the phone's state", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ state: "downloadable", engine: "dictation-transcriber" });
        expect(await deviceSpeechStatus("fr-FR")).toBe("downloadable");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "status", { language: "fr-FR" });

        nativePromise.mockResolvedValueOnce({ state: "available" });
        expect(await installDeviceSpeech()).toBe("available");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "install", {});
    });

    it("treat anything unexpected as unavailable", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ state: "maybe" });
        expect(await deviceSpeechStatus()).toBe("unavailable");
        nativePromise.mockResolvedValueOnce("available");
        expect(await deviceSpeechStatus()).toBe("unavailable");
        nativePromise.mockRejectedValueOnce(new Error("bridge"));
        expect(await deviceSpeechStatus()).toBe("unavailable");
    });

    it("re-read the status when a download fails", async () => {
        inApp();
        nativePromise.mockRejectedValueOnce({ code: "failed" }).mockResolvedValueOnce({ state: "downloading" });
        expect(await installDeviceSpeech("de-DE")).toBe("downloading");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "status", { language: "de-DE" });
    });
});

describe("transcribeOnDevice", () => {
    it("hands the recording to the phone as base64 with its type and language", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ text: "Draft the letter." });
        const text = await transcribeOnDevice(new Blob(["hi"], { type: "audio/mp4" }), "en-GB");
        expect(text).toBe("Draft the letter.");
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "transcribe", {
            audio: "aGk=",
            mimeType: "audio/mp4",
            language: "en-GB",
        });
    });

    it("encodes a recording larger than one chunk", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ text: "" });
        const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 256);
        await transcribeOnDevice(new Blob([bytes], { type: "audio/mp4" }));
        const { audio } = nativePromise.mock.calls[0][2] as { audio: string };
        expect(Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))).toEqual(bytes);
    });

    it("returns no text when the phone answers without any", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
        expect(await transcribeOnDevice(new Blob(["a"]))).toBe("");
        expect(await transcribeOnDevice(new Blob(["a"]))).toBe("");
    });

    it("turns the phone's failure codes into messages for the user", async () => {
        inApp();
        nativePromise.mockRejectedValueOnce({ code: "not-installed", message: "internal" });
        await expect(transcribeOnDevice(new Blob(["a"]))).rejects.toThrow(/Download Apple's speech model/);
        nativePromise.mockRejectedValueOnce({ code: "something-new" });
        await expect(transcribeOnDevice(new Blob(["a"]))).rejects.toThrow(DEVICE_TRANSCRIBE_FAILURE_MESSAGE);
        nativePromise.mockRejectedValueOnce(new Error("raw native text"));
        const error = await transcribeOnDevice(new Blob(["a"])).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DeviceSpeechError);
        expect((error as Error).message).toBe(DEVICE_TRANSCRIBE_FAILURE_MESSAGE);
    });

    it("refuses in a browser", async () => {
        await expect(transcribeOnDevice(new Blob(["a"]))).rejects.toThrow(/cannot transcribe this language/);
    });
});

describe("deviceVoiceSupported", () => {
    it("is true only when the app's plugin lists the speak method", () => {
        expect(deviceVoiceSupported()).toBe(false);
        inApp();
        expect(deviceVoiceSupported()).toBe(false);
        inApp([{ name: "MikeSpeech", methods: [{ name: "transcribe" }] }]);
        expect(deviceVoiceSupported()).toBe(false);
        inApp([{ name: "MikeSpeech", methods: [{ name: "transcribe" }, { name: "speak" }] }]);
        expect(deviceVoiceSupported()).toBe(true);
    });
});

describe("deviceVoices", () => {
    it("lists the phone's voices and drops malformed entries", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({
            voices: [
                { id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", language: "en-US", quality: "premium" },
                { id: "com.apple.voice.compact.en-GB.Daniel", name: "Daniel", language: "en-GB" },
                { id: 3, name: "bad", language: "x" },
                null,
            ],
        });
        expect(await deviceVoices()).toEqual([
            { id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", language: "en-US", quality: "premium" },
            { id: "com.apple.voice.compact.en-GB.Daniel", name: "Daniel", language: "en-GB", quality: "default" },
        ]);
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "voices");
    });

    it("is empty in a browser, on a failure, or on an unexpected answer", async () => {
        expect(await deviceVoices()).toEqual([]);
        inApp();
        nativePromise.mockRejectedValueOnce(new Error("no"));
        expect(await deviceVoices()).toEqual([]);
        nativePromise.mockResolvedValueOnce({ voices: "nope" });
        expect(await deviceVoices()).toEqual([]);
        nativePromise.mockResolvedValueOnce(null);
        expect(await deviceVoices()).toEqual([]);
    });
});

describe("speakOnDevice", () => {
    it("asks the phone for the text in a voice and returns the WAV", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ audio: btoa("RIFF"), mimeType: "audio/wav" });
        const blob = await speakOnDevice("Hello.", "voice-1");
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "speak", { text: "Hello.", voice: "voice-1" });
        expect(blob.type).toBe("audio/wav");
        expect(await blob.text()).toBe("RIFF");

        nativePromise.mockResolvedValueOnce({ audio: btoa("x") });
        await speakOnDevice("Hi.");
        expect(nativePromise).toHaveBeenLastCalledWith("MikeSpeech", "speak", { text: "Hi." });
    });

    it("turns failures into messages for the user", async () => {
        await expect(speakOnDevice("Hi.")).rejects.toThrow(DEVICE_SPEAK_FAILURE_MESSAGE);
        inApp();
        nativePromise.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "too-long" }));
        await expect(speakOnDevice("Hi.")).rejects.toThrow("This is too long to read aloud on this iPhone at once.");
        nativePromise.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "failed" }));
        await expect(speakOnDevice("Hi.")).rejects.toBeInstanceOf(DeviceSpeechError);
        nativePromise.mockResolvedValueOnce({ audio: "" });
        await expect(speakOnDevice("Hi.")).rejects.toThrow(DEVICE_SPEAK_FAILURE_MESSAGE);
        nativePromise.mockResolvedValueOnce(null);
        await expect(speakOnDevice("Hi.")).rejects.toThrow(DEVICE_SPEAK_FAILURE_MESSAGE);
    });
});

describe("fluidSpeechMiniAvailable", () => {
    it("is false in a browser", async () => {
        expect(await fluidSpeechMiniAvailable()).toBe(false);
    });

    it("is true only when the app answers for the Fluid Speech Mini engine", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ state: "available", engine: "fluid-mini", locale: "en" });
        expect(await fluidSpeechMiniAvailable()).toBe(true);
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "status", { engine: "fluid-mini" });
        // A positive answer is kept.
        expect(await fluidSpeechMiniAvailable()).toBe(true);
        expect(nativePromise).toHaveBeenCalledTimes(1);
    });

    it("is false on an older app build, which ignores the option and answers for Apple's recognizer", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ state: "available", engine: "speech-analyzer" });
        expect(await fluidSpeechMiniAvailable()).toBe(false);
    });

    it("is false below iOS 18 or without the model, and is asked again later", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ state: "unavailable" });
        expect(await fluidSpeechMiniAvailable()).toBe(false);
        nativePromise.mockRejectedValueOnce(new Error("bridge"));
        expect(await fluidSpeechMiniAvailable()).toBe(false);
        nativePromise.mockResolvedValueOnce({ state: "available", engine: "fluid-mini" });
        expect(await fluidSpeechMiniAvailable()).toBe(true);
    });
});

describe("transcribeOnDevice with Fluid Speech Mini", () => {
    it("sends the engine and no language", async () => {
        inApp();
        nativePromise.mockResolvedValueOnce({ text: "Hello." });
        expect(await transcribeOnDevice(new Blob(["hi"], { type: "audio/mp4" }), "en-GB", FLUID_MINI_ENGINE)).toBe("Hello.");
        expect(nativePromise).toHaveBeenCalledWith("MikeSpeech", "transcribe", {
            audio: "aGk=",
            mimeType: "audio/mp4",
            engine: "fluid-mini",
        });
    });
});

describe("isEnglishLanguage", () => {
    it("accepts English tags and reads the phone's language when none is set", () => {
        expect(isEnglishLanguage("en")).toBe(true);
        expect(isEnglishLanguage("en-GB")).toBe(true);
        expect(isEnglishLanguage("en_US")).toBe(true);
        expect(isEnglishLanguage("fr-FR")).toBe(false);
        expect(isEnglishLanguage("enm")).toBe(false);
        vi.stubGlobal("navigator", { language: "de-DE" });
        expect(isEnglishLanguage()).toBe(false);
        vi.stubGlobal("navigator", { language: "en-AU" });
        expect(isEnglishLanguage()).toBe(true);
    });
});
