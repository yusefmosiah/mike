import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    transcribeAudio: vi.fn(async () => ({ text: "hello" })),
    synthesizeSpeech: vi.fn(async () => new Blob(["mp3"])),
    getDictationVocabulary: vi.fn(async () => ({ terms: [] as string[] })),
    saveDictationVocabulary: vi.fn(async (terms: string[]) => ({ terms })),
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
    fluidSpeechMiniStatus: vi.fn(async () => ({ state: "unavailable" })),
    DEVICE_MODEL_MISSING_MESSAGE: "Download the speech model in Settings → Voice to dictate on this phone.",
    DeviceSpeechError: class DeviceSpeechError extends Error {},
    prepareFluidSpeechMini: vi.fn(),
    liveDictationAvailable: vi.fn(async () => false),
    startLiveDictation: vi.fn(async (..._args: unknown[]) => undefined),
    stopLiveDictation: vi.fn(async () => "final text"),
    cancelLiveDictation: vi.fn(),
    isEnglishLanguage: vi.fn((language?: string) => !language || /^en/i.test(language)),
    FLUID_MINI_ENGINE: "fluid-mini",
    deviceSpeechSupported: vi.fn(() => false),
    deviceVoiceSupported: vi.fn(() => false),
    speakOnDevice: vi.fn(async (...args: unknown[]) => new Blob(["wav"], { type: `x${args.length}` })),
    PHONON_ENGINE: "phonon",
    phononAvailable: vi.fn(async () => false),
}));
vi.mock("./deviceSpeech", () => phone);

import { resetDictationVocabulary, setDictationContext } from "./dictationVocabulary";
import {
    correctDictation,
    cancelLiveTranscription,
    prepareTranscription,
    speechRenderPlan,
    startLiveTranscription,
    stopLiveTranscription,
    wantsLiveDictation,
    synthesizeSentence,
    transcribeRecording,
} from "./engines";

beforeEach(() => {
    vi.clearAllMocks();
    api.getDictationVocabulary.mockResolvedValue({ terms: [] });
    resetDictationVocabulary();
});

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

    describe("with a vocabulary", () => {
        it("corrects the text of any engine, with the person's terms and the page's names", async () => {
            api.getDictationVocabulary.mockResolvedValue({ terms: ["Ximena Achterberg"] });
            setDictationContext("test", ["Okonkwo-Lindqvist"]);
            api.transcribeAudio.mockResolvedValueOnce({ text: "Ask Zamina Akterberg about Conquo Lindqvist." });
            expect(await transcribeRecording(blob, { engine: "operator" })).toBe(
                "Ask Ximena Achterberg about Okonkwo-Lindqvist.",
            );
        });

        it("transcribes without it when the list cannot be loaded", async () => {
            api.getDictationVocabulary.mockRejectedValue(new Error("offline"));
            api.transcribeAudio.mockResolvedValueOnce({ text: "Zamina Akterberg" });
            expect(await transcribeRecording(blob, { engine: "operator" })).toBe("Zamina Akterberg");
        });

        it("corrects text an engine produced itself", async () => {
            api.getDictationVocabulary.mockResolvedValue({ terms: ["Ximena Achterberg"] });
            expect(await correctDictation("Zamina Akterberg")).toBe("Ximena Achterberg");
        });

        it("gives Apple's recognizer up to 100 terms, the person's first", async () => {
            const own = Array.from({ length: 60 }, (_, i) => `Person Term${i}`);
            api.getDictationVocabulary.mockResolvedValue({ terms: own });
            setDictationContext("test", Array.from({ length: 80 }, (_, i) => `Automatic Name${i}`));
            await transcribeRecording(blob, { engine: "device", language: "en-GB" });
            const args = phone.transcribeOnDevice.mock.calls[0];
            expect(args.slice(0, 3)).toEqual([blob, "en-GB", undefined]);
            const sent = args[3] as string[];
            expect(sent).toHaveLength(100);
            expect(sent.slice(0, 60)).toEqual(own);
            expect(sent[60]).toBe("Automatic Name0");
        });

        it("does not send the vocabulary to Fluid Speech Mini", async () => {
            phone.fluidSpeechMiniAvailable.mockResolvedValue(true);
            api.getDictationVocabulary.mockResolvedValue({ terms: ["Ximena Achterberg"] });
            await transcribeRecording(blob, { engine: "device", model: "fluid-speech-mini" });
            expect(phone.transcribeOnDevice).toHaveBeenCalledWith(blob, undefined, "fluid-mini");
        });
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

        it("asks for the download when the phone has no recognizer until Fluid Speech Mini is downloaded (Android)", async () => {
            phone.fluidSpeechMiniAvailable.mockResolvedValue(false);
            phone.transcribeOnDevice.mockRejectedValue(new Error("unavailable"));
            phone.fluidSpeechMiniStatus.mockResolvedValueOnce({ state: "downloadable" });
            await expect(transcribeRecording(blob, { engine: "device", model: "fluid-speech-mini" })).rejects.toThrow(
                "Download the speech model in Settings → Voice to dictate on this phone.",
            );
            phone.fluidSpeechMiniStatus.mockResolvedValueOnce({ state: "downloading" });
            await expect(transcribeRecording(blob, { engine: "device" })).rejects.toThrow("Download the speech model");
            // Fluid Speech Mini cannot run here at all: the recognizer's own error stands.
            await expect(transcribeRecording(blob, { engine: "device" })).rejects.toThrow("unavailable");
            // Apple's recognizer chosen: no question about Fluid Speech Mini.
            phone.fluidSpeechMiniStatus.mockClear();
            await expect(transcribeRecording(blob, { engine: "device", model: "apple" })).rejects.toThrow("unavailable");
            expect(phone.fluidSpeechMiniStatus).not.toHaveBeenCalled();
            phone.transcribeOnDevice.mockReset();
            phone.transcribeOnDevice.mockImplementation(async () => "phone words");
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

describe("prepareTranscription", () => {
    it("starts loading Fluid Speech Mini on the phone for English", async () => {
        phone.fluidSpeechMiniAvailable.mockResolvedValueOnce(true);
        await prepareTranscription({ engine: "device", language: "en-US" });
        expect(phone.prepareFluidSpeechMini).toHaveBeenCalledTimes(1);
    });

    it("does nothing when Fluid Speech Mini would not transcribe", async () => {
        phone.fluidSpeechMiniAvailable.mockResolvedValue(false);
        await prepareTranscription({ engine: "device" });
        await prepareTranscription({ engine: "device", model: "apple" });
        await prepareTranscription({ engine: "device", language: "fr-FR" });
        await prepareTranscription({ engine: "operator" });
        await prepareTranscription();
        expect(phone.prepareFluidSpeechMini).not.toHaveBeenCalled();
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
        expect(local.speakWithBrowserModel).toHaveBeenCalledWith("Hi.", { voice: "bm_george", model: undefined });
    });

    it("tells the browser engine which model the preference names", async () => {
        await synthesizeSentence("Hi.", { engine: "webgpu", model: "phonon", voice: "Maeve" });
        expect(local.speakWithBrowserModel).toHaveBeenCalledWith("Hi.", { voice: "Maeve", model: "phonon" });
    });

    describe("on the phone", () => {
        const english = "The court held that the contract was void for want of consideration.";
        beforeEach(() => phone.phononAvailable.mockResolvedValue(true));

        it("reads English with Phonon once it is downloaded, and no choice means Phonon", async () => {
            await synthesizeSentence(english, { engine: "device" });
            expect(phone.speakOnDevice).toHaveBeenCalledWith(english, undefined, "phonon");
            await synthesizeSentence(english, { engine: "device", model: "phonon", voice: "Maeve" });
            expect(phone.speakOnDevice).toHaveBeenLastCalledWith(english, "Maeve", "phonon");
        });

        it("reads with Apple's voices when Apple's are chosen", async () => {
            await synthesizeSentence(english, { engine: "device", model: "apple", voice: "Maeve" });
            expect(phone.speakOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.speakOnDevice).toHaveBeenCalledWith(english, undefined);
        });

        it("keeps an Apple voice chosen before Phonon existed", async () => {
            await synthesizeSentence(english, { engine: "device", voice: "com.apple.voice.premium.en-US.Zoe" });
            expect(phone.speakOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.speakOnDevice).toHaveBeenCalledWith(english, "com.apple.voice.premium.en-US.Zoe");
        });

        it("reads other languages with Apple's voices", async () => {
            await synthesizeSentence("Le tribunal a jugé que le contrat était nul faute de cause.", { engine: "device", model: "phonon" });
            expect(phone.speakOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.speakOnDevice).toHaveBeenCalledWith("Le tribunal a jugé que le contrat était nul faute de cause.", undefined);
        });

        it("reads with Apple's voices until Phonon is downloaded", async () => {
            phone.phononAvailable.mockResolvedValue(false);
            await synthesizeSentence(english, { engine: "device", model: "phonon", voice: "Maeve" });
            expect(phone.speakOnDevice).toHaveBeenCalledTimes(1);
            expect(phone.speakOnDevice).toHaveBeenCalledWith(english, undefined);
        });

        it("falls back to Apple's voice when Phonon fails", async () => {
            phone.speakOnDevice.mockRejectedValueOnce(new Error("phonon"));
            await synthesizeSentence(english, { engine: "device", model: "phonon", voice: "Maeve" });
            expect(phone.speakOnDevice).toHaveBeenCalledTimes(2);
            expect(phone.speakOnDevice).toHaveBeenLastCalledWith(english, undefined);
        });
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

describe("live dictation", () => {
    it("is wanted only on the phone, with Fluid Speech Mini, in English, in a build that reports live", async () => {
        phone.liveDictationAvailable.mockResolvedValue(true);
        expect(await wantsLiveDictation({ engine: "device", language: "en-US" })).toBe(true);
        expect(await wantsLiveDictation({ engine: "device" })).toBe(true);
        expect(await wantsLiveDictation({ engine: "device", model: "apple" })).toBe(false);
        expect(await wantsLiveDictation({ engine: "device", language: "fr-FR" })).toBe(false);
        expect(await wantsLiveDictation({ engine: "operator" })).toBe(false);
        phone.liveDictationAvailable.mockResolvedValue(false);
        expect(await wantsLiveDictation({ engine: "device" })).toBe(false);
        expect(await wantsLiveDictation()).toBe(false);
    });

    it("applies the vocabulary to the confirmed text only, and passes the level on", async () => {
        setDictationContext("test", ["Okonkwo-Lindqvist"]);
        let send: (event: unknown) => void = () => undefined;
        phone.startLiveDictation.mockImplementationOnce(async (...args: unknown[]) => {
            send = args[0] as (event: unknown) => void;
        });
        const onText = vi.fn();
        const onLevel = vi.fn();
        await startLiveTranscription({ onText, onLevel });
        send({ kind: "text", confirmed: "ask Conquo Lindqvist", volatile: "Conquo Lindqvist now", ended: false });
        send({ kind: "text", confirmed: "done", volatile: "", ended: true });
        send({ kind: "level", level: 0.5 });
        expect(onText).toHaveBeenNthCalledWith(1, { confirmed: "ask Okonkwo-Lindqvist", volatile: "Conquo Lindqvist now" }, false);
        expect(onText).toHaveBeenNthCalledWith(2, { confirmed: "done", volatile: "" }, true);
        expect(onLevel).toHaveBeenCalledWith(0.5);
    });

    it("tolerates a missing level handler and a vocabulary that cannot be loaded", async () => {
        api.getDictationVocabulary.mockRejectedValueOnce(new Error("offline"));
        resetDictationVocabulary();
        let send: (event: unknown) => void = () => undefined;
        phone.startLiveDictation.mockImplementationOnce(async (...args: unknown[]) => {
            send = args[0] as (event: unknown) => void;
        });
        await startLiveTranscription({ onText: vi.fn() });
        send({ kind: "level", level: 1 });
    });

    it("applies the vocabulary to the final text on stop, and cancels", async () => {
        setDictationContext("test", ["Okonkwo-Lindqvist"]);
        phone.stopLiveDictation.mockResolvedValueOnce("ask Conquo Lindqvist");
        expect(await stopLiveTranscription()).toBe("ask Okonkwo-Lindqvist");
        cancelLiveTranscription();
        expect(phone.cancelLiveDictation).toHaveBeenCalledTimes(1);
    });
});
