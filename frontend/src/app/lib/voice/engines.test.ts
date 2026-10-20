import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    transcribeAudio: vi.fn(async () => ({ text: "hello" })),
    synthesizeSpeech: vi.fn(async () => new Blob(["mp3"])),
}));
vi.mock("@/app/lib/mikeApi", () => api);
const local = vi.hoisted(() => ({
    transcribeInBrowser: vi.fn(async () => "local words"),
    speakWithBrowserModel: vi.fn(async () => new Blob(["wav"])),
}));
vi.mock("./browserModels", () => local);
const phone = vi.hoisted(() => ({
    transcribeOnDevice: vi.fn(async (..._args: unknown[]) => "phone words"),
    fluidSpeechMiniAvailable: vi.fn(async () => false),
    isEnglishLanguage: vi.fn((language?: string) => !language || /^en/i.test(language)),
    FLUID_MINI_ENGINE: "fluid-mini",
    deviceSpeechSupported: vi.fn(() => false),
    deviceVoiceSupported: vi.fn(() => false),
    speakOnDevice: vi.fn(async () => new Blob(["wav"])),
}));
vi.mock("./deviceSpeech", () => phone);

import { speechRenderPlan, synthesizeSentence, transcribeRecording } from "./engines";

beforeEach(() => vi.clearAllMocks());

describe("transcribeRecording", () => {
    const blob = new Blob(["a"], { type: "audio/webm" });

    it("uses the operator by default", async () => {
        expect(await transcribeRecording(blob, { engine: "operator" })).toBe("hello");
        expect(api.transcribeAudio).toHaveBeenCalledWith(blob, { language: undefined });
    });

    it("names OpenRouter and the model when chosen", async () => {
        await transcribeRecording(blob, { engine: "openrouter", model: "qwen/qwen3-asr-0.6b" });
        expect(api.transcribeAudio).toHaveBeenCalledWith(blob, { provider: "openrouter", model: "qwen/qwen3-asr-0.6b", language: undefined });
    });

    it("hands the recording to the phone for the device engine", async () => {
        expect(await transcribeRecording(blob, { engine: "device", language: "en-GB" })).toBe("phone words");
        expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, "en-GB");
        expect(api.transcribeAudio).not.toHaveBeenCalled();
    });

    describe("on the phone with Fluid Speech Mini", () => {
        beforeEach(() => phone.fluidSpeechMiniAvailable.mockResolvedValue(true));

        it("uses it by default for English", async () => {
            expect(await transcribeRecording(blob, { engine: "device", model: "fluid-speech-mini", language: "en-GB" })).toBe("phone words");
            expect(phone.transcribeOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, "en-GB", "fluid-mini");
            await transcribeRecording(blob, { engine: "device" });
            expect(phone.transcribeOnDevice).toHaveBeenLastCalledWith(blob, undefined, "fluid-mini");
        });

        it("uses Apple's recognizer when chosen", async () => {
            await transcribeRecording(blob, { engine: "device", model: "apple" });
            expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, undefined);
        });

        it("uses Apple's recognizer for a language other than English", async () => {
            await transcribeRecording(blob, { engine: "device", model: "fluid-speech-mini", language: "fr-FR" });
            expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, "fr-FR");
            expect(phone.transcribeOnDevice).toHaveBeenCalledTimes(1);
        });

        it("falls back to Apple's recognizer when Fluid Speech Mini is unavailable", async () => {
            phone.fluidSpeechMiniAvailable.mockResolvedValue(false);
            await transcribeRecording(blob, { engine: "device", model: "fluid-speech-mini" });
            expect(phone.transcribeOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, undefined);
        });

        it("falls back to Apple's recognizer when Fluid Speech Mini fails, and shows the first error if both do", async () => {
            phone.transcribeOnDevice.mockRejectedValueOnce(new Error("fluid"));
            expect(await transcribeRecording(blob, { engine: "device" })).toBe("phone words");
            expect(phone.transcribeOnDevice).toHaveBeenLastCalledWith(blob, undefined);
            phone.transcribeOnDevice.mockRejectedValueOnce(new Error("fluid")).mockRejectedValueOnce(new Error("apple"));
            await expect(transcribeRecording(blob, { engine: "device" })).rejects.toThrow("fluid");
        });
    });

    it("stays in the browser for the browser model", async () => {
        expect(await transcribeRecording(blob, { engine: "webgpu" })).toBe("local words");
        expect(api.transcribeAudio).not.toHaveBeenCalled();
    });
});

describe("synthesizeSentence", () => {
    it("routes to the operator, OpenRouter or the browser model", async () => {
        await synthesizeSentence("Hi.", { engine: "operator" });
        expect(api.synthesizeSpeech).toHaveBeenLastCalledWith("Hi.");
        await synthesizeSentence("Hi.", { engine: "openrouter", model: "hexgrad/kokoro-82m", voice: "af_heart" });
        expect(api.synthesizeSpeech).toHaveBeenLastCalledWith("Hi.", { provider: "openrouter", model: "hexgrad/kokoro-82m", voice: "af_heart" });
        await synthesizeSentence("Hi.", { engine: "device", voice: "zoe" });
        expect(phone.speakOnDevice).toHaveBeenCalledWith("Hi.", "zoe");
        await synthesizeSentence("Hi.", { engine: "webgpu", voice: "bm_george" });
        expect(local.speakWithBrowserModel).toHaveBeenCalledWith("Hi.", { voice: "bm_george" });
    });
});

describe("speechRenderPlan", () => {
    it("sends long chunks, three at a time, to server engines", () => {
        expect(speechRenderPlan({ engine: "operator" })).toEqual({ maxChars: 1200, concurrency: 3 });
        expect(speechRenderPlan({ engine: "openrouter", model: "m" })).toEqual({ maxChars: 1200, concurrency: 3 });
    });

    it("sends a few sentences at a time, one by one, to the model in the browser", () => {
        expect(speechRenderPlan({ engine: "webgpu" })).toEqual({ maxChars: 300, concurrency: 1 });
        expect(speechRenderPlan({ engine: "device" })).toEqual({ maxChars: 1200, concurrency: 1 });
    });

    it("reads the saved preferences by default", () => {
        expect(speechRenderPlan()).toEqual({ maxChars: 1200, concurrency: 3 });
    });
});
