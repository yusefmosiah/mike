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
const phone = vi.hoisted(() => ({ transcribeOnDevice: vi.fn(async () => "phone words") }));
vi.mock("./deviceSpeech", () => phone);

import { synthesizeSentence, transcribeRecording } from "./engines";

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
        await synthesizeSentence("Hi.", { engine: "webgpu", voice: "bm_george" });
        expect(local.speakWithBrowserModel).toHaveBeenCalledWith("Hi.", { voice: "bm_george" });
    });
});
