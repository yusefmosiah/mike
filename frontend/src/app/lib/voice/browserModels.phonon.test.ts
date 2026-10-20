import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("/phonon-tts/index.js", () => ({ PhononTTS: { load: lib.load } }));

import {
    DEFAULT_PHONON_VOICE,
    PHONON_REVISION,
    PHONON_VOICES,
    isPhononVoice,
    phononVoiceUrl,
} from "./browserModels.spec";

type Module = typeof import("./browserModels.phonon");
let mod: Module;

function fakePhonon(overrides: Partial<{ voices: string[]; device: string }> = {}) {
    const voices = [...(overrides.voices ?? ["default"])];
    return {
        device: overrides.device ?? "cpu",
        voices,
        addVoice: vi.fn(async (name: string) => {
            voices.push(name);
        }),
        synthWav: vi.fn(async () => new Blob(["wav"])),
        dispose: vi.fn(),
    };
}

beforeEach(async () => {
    vi.resetModules();
    lib.load.mockReset();
    mod = await import("./browserModels.phonon");
});

describe("the curated voices", () => {
    it("are eight English voices, with unique ids and pinned URLs", () => {
        expect(PHONON_VOICES).toHaveLength(8);
        expect(new Set(PHONON_VOICES.map((voice) => voice.id)).size).toBe(8);
        expect(isPhononVoice(DEFAULT_PHONON_VOICE)).toBe(true);
        expect(isPhononVoice("com.apple.voice.compact.en-US.Samantha")).toBe(false);
        expect(isPhononVoice(undefined)).toBe(false);
        expect(phononVoiceUrl(PHONON_VOICES[0])).toBe(
            "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/4SZHfMpw-p46Ywgs.safetensors",
        );
    });
});

describe("loadPhonon", () => {
    it("loads the pinned model with q8 weights where the browser decides the device, and its first voice", async () => {
        const tts = fakePhonon();
        lib.load.mockResolvedValue(tts);
        await mod.loadPhonon();
        expect(lib.load).toHaveBeenCalledWith(
            expect.objectContaining({
                lang: "en",
                model: `hf://gradium/phonon-31m-en@${PHONON_REVISION}`,
                quant: "q8",
                device: "auto",
            }),
        );
        expect(tts.addVoice).toHaveBeenCalledWith("Harper", phononVoiceUrl(PHONON_VOICES[0]));
        await mod.loadPhonon();
        expect(lib.load).toHaveBeenCalledTimes(1);
        expect(tts.addVoice).toHaveBeenCalledTimes(1);
    });

    it("folds the package's per-file progress into one fraction", async () => {
        lib.load.mockImplementation(async (options: { onProgress: (e: object) => void }) => {
            options.onProgress({ file: "weights", loaded: 10, total: 100 });
            options.onProgress({ file: "tokenizer", loaded: 5, total: null });
            options.onProgress({ file: "weights", loaded: 100, total: 100 });
            return fakePhonon({ voices: ["default", "Harper"] });
        });
        const progress = vi.fn();
        await mod.loadPhonon(progress);
        expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0.1, 0.1, 1]);
    });

    it("reports nothing while no file's size is known", async () => {
        lib.load.mockImplementation(async (options: { onProgress: (e: object) => void }) => {
            options.onProgress({ file: "weights", loaded: 10, total: null });
            return fakePhonon({ voices: ["Harper"] });
        });
        const progress = vi.fn();
        await mod.loadPhonon(progress);
        expect(progress).not.toHaveBeenCalled();
    });

    it("loads without a progress callback", async () => {
        lib.load.mockImplementation(async (options: { onProgress: (e: object) => void }) => {
            options.onProgress({ file: "weights", loaded: 1, total: 2 });
            return fakePhonon({ voices: ["Harper"] });
        });
        await expect(mod.loadPhonon()).resolves.toBeUndefined();
    });

    it("forgets a failed load so the next attempt retries", async () => {
        lib.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(fakePhonon());
        await expect(mod.loadPhonon()).rejects.toThrow("offline");
        await expect(mod.loadPhonon()).resolves.toBeUndefined();
        expect(lib.load).toHaveBeenCalledTimes(2);
    });
});

describe("speakWithPhonon", () => {
    it("speaks with the chosen voice, fetching it once", async () => {
        const tts = fakePhonon();
        lib.load.mockResolvedValue(tts);
        const wav = await mod.speakWithPhonon("Hello.", "Maeve");
        expect(wav).toBeInstanceOf(Blob);
        expect(tts.synthWav).toHaveBeenCalledWith("Hello.", { voice: "Maeve" });
        await mod.speakWithPhonon("Again.", "Maeve");
        expect(tts.addVoice.mock.calls.filter(([name]) => name === "Maeve")).toHaveLength(1);
    });

    it("speaks a voice that is not in the list, or none, with the default voice", async () => {
        const tts = fakePhonon();
        lib.load.mockResolvedValue(tts);
        await mod.speakWithPhonon("Hello.", "com.apple.voice.premium.en-US.Zoe");
        await mod.speakWithPhonon("Hello.");
        expect(tts.synthWav).toHaveBeenNthCalledWith(1, "Hello.", { voice: "Harper" });
        expect(tts.synthWav).toHaveBeenNthCalledWith(2, "Hello.", { voice: "Harper" });
    });

    it("shares a voice fetch that is already running", async () => {
        const tts = fakePhonon();
        let finish: () => void = () => {};
        tts.addVoice.mockImplementation(
            (name: string) =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        tts.voices.push(name);
                        resolve();
                    };
                }),
        );
        lib.load.mockResolvedValue(tts);
        const first = mod.speakWithPhonon("One.", "Hugh");
        const second = mod.speakWithPhonon("Two.", "Hugh");
        await vi.waitFor(() => expect(tts.addVoice).toHaveBeenCalledTimes(1));
        finish();
        await Promise.all([first, second]);
        expect(tts.addVoice).toHaveBeenCalledTimes(1);
        expect(tts.synthWav).toHaveBeenCalledTimes(2);
    });
});

describe("phononDevice and releasePhonon", () => {
    it("reports where the loaded model runs, and nothing before or after", async () => {
        expect(await mod.phononDevice()).toBeNull();
        const tts = fakePhonon({ device: "webgpu" });
        lib.load.mockResolvedValue(tts);
        await mod.loadPhonon();
        expect(await mod.phononDevice()).toBe("webgpu");
        await mod.releasePhonon();
        expect(tts.dispose).toHaveBeenCalledTimes(1);
        expect(await mod.phononDevice()).toBeNull();
        await expect(mod.releasePhonon()).resolves.toBeUndefined();
    });

    it("tolerates a load that is failing", async () => {
        let fail: (error: Error) => void = () => {};
        lib.load.mockReturnValue(new Promise((_, reject) => (fail = reject)));
        const loading = mod.loadPhonon().catch(() => undefined);
        const device = mod.phononDevice();
        const released = mod.releasePhonon();
        fail(new Error("offline"));
        await Promise.all([loading, device, released]);
        expect(await device).toBeNull();
    });
});
