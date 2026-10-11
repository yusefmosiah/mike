import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DEVICE_TRANSCRIBE_FAILURE_MESSAGE,
    DeviceSpeechError,
    deviceSpeechStatus,
    deviceSpeechSupported,
    installDeviceSpeech,
    transcribeOnDevice,
} from "./deviceSpeech";

const nativePromise = vi.fn();

function inApp(headers = [{ name: "MikeSpeech" }]) {
    vi.stubGlobal("Capacitor", { PluginHeaders: headers, nativePromise });
}

afterEach(() => {
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
