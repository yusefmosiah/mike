import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loading paths with stand-in libraries; browserModels.test.ts keeps the
// guard that nothing loads without consent.
const lib = vi.hoisted(() => ({
    pipeline: vi.fn(),
    env: { allowLocalModels: true },
    fromPretrained: vi.fn(),
}));
vi.mock("@huggingface/transformers", () => ({ pipeline: lib.pipeline, env: lib.env }));
vi.mock("kokoro-js", () => ({ KokoroTTS: { from_pretrained: lib.fromPretrained } }));

type Module = typeof import("./browserModels");
let mod: Module;

beforeEach(async () => {
    vi.resetModules();
    mod = await import("./browserModels");
    lib.pipeline.mockReset();
    lib.fromPretrained.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

function stubAudio(channels: Float32Array[]) {
    const close = vi.fn(async () => {});
    vi.stubGlobal(
        "AudioContext",
        class {
            constructor(public options: { sampleRate: number }) {}
            decodeAudioData = vi.fn(async () => ({
                numberOfChannels: channels.length,
                getChannelData: (i: number) => channels[i],
            }));
            close = close;
        },
    );
    return close;
}

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

describe("environment checks", () => {
    it("sees WebGPU only when navigator.gpu is set", () => {
        vi.stubGlobal("navigator", {});
        expect(mod.webgpuAvailable()).toBe(false);
        vi.stubGlobal("navigator", { gpu: null });
        expect(mod.webgpuAvailable()).toBe(false);
        vi.stubGlobal("navigator", { gpu: {} });
        expect(mod.webgpuAvailable()).toBe(true);
        vi.stubGlobal("navigator", undefined);
        expect(mod.webgpuAvailable()).toBe(false);
    });

    it("supports browser models only in a browser with WebAssembly", () => {
        expect(mod.browserModelsSupported()).toBe(true);
        vi.stubGlobal("WebAssembly", undefined);
        expect(mod.browserModelsSupported()).toBe(false);
        vi.stubGlobal("window", undefined);
        expect(mod.browserModelsSupported()).toBe(false);
    });
});

describe("stored consent", () => {
    it("ignores unreadable or non-object storage", () => {
        window.localStorage.setItem("mike.voice.browser-models.v1", "{not json");
        expect(mod.hasBrowserModelConsent("speech")).toBe(false);
        window.localStorage.setItem("mike.voice.browser-models.v1", "null");
        expect(mod.hasBrowserModelConsent("speech")).toBe(false);
        window.localStorage.setItem("mike.voice.browser-models.v1", "7");
        expect(mod.hasBrowserModelConsent("speech")).toBe(false);
    });

    it("keeps consent for the session when storage refuses writes", async () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("quota");
        });
        mod.setBrowserModelConsent("speech", true);
        vi.mocked(Storage.prototype.setItem).mockRestore();
        expect(mod.hasBrowserModelConsent("speech")).toBe(false);
        lib.fromPretrained.mockResolvedValue({ generate: vi.fn() });
        await expect(mod.loadBrowserSpeaker()).resolves.toBeDefined();
    });
});

describe("sizes and voices from the model host", () => {
    it("uses the global fetch and this browser's backend by default", async () => {
        vi.stubGlobal("navigator", { gpu: {} });
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify([
                { path: "onnx/model.onnx", size: 300 },
                { path: "onnx/model_quantized.onnx", lfs: { size: 90 } },
            ])),
        );
        vi.stubGlobal("fetch", fetchMock);
        expect(await mod.browserModelBytes("speech")).toBe(300);
    });

    it("counts a file with no size as zero and fails on a bad response", async () => {
        const noSize = vi.fn(async () => new Response(JSON.stringify([{ path: "onnx/model_quantized.onnx" }]))) as unknown as typeof fetch;
        expect(await mod.browserModelBytes("speech", { fetch: noSize, webgpu: false })).toBe(0);
        const bad = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
        await expect(mod.browserModelBytes("speech", { fetch: bad, webgpu: false })).rejects.toThrow("model size lookup failed");
    });

    it("estimates with default dependencies", async () => {
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("fetch", vi.fn(async (url: string) =>
            url.includes("/api/models/")
                ? new Response(JSON.stringify([{ path: "onnx/model_quantized.onnx", size: 1000 }]))
                : new Response(new Uint8Array(1000)),
        ));
        expect(await mod.estimateBrowserModelSetup("speech")).toBeGreaterThanOrEqual(1);
    });

    it("falls back to the default voice", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
        expect(await mod.browserModelVoices()).toEqual([mod.DEFAULT_KOKORO_VOICE]);
        const none = vi.fn(async () => new Response(JSON.stringify([{ path: "voices/readme.txt" }]))) as unknown as typeof fetch;
        expect(await mod.browserModelVoices({ fetch: none })).toEqual([mod.DEFAULT_KOKORO_VOICE]);
    });
});

describe("Whisper in the browser", () => {
    it("loads once on WebGPU, reports download progress, and transcribes stereo audio", async () => {
        vi.stubGlobal("navigator", { gpu: {} });
        mod.setBrowserModelConsent("transcription", true);
        const run = vi.fn(async () => ({ text: "  hello there  " }));
        lib.pipeline.mockImplementation(async (_task, _repo, options: { progress_callback: (e: object) => void }) => {
            const report = options.progress_callback;
            report({ status: "initiate", file: "a" });
            report({ status: "progress" });
            report({ status: "progress", file: "a" });
            report({ status: "progress", file: "a", loaded: 50, total: 100 });
            report({ status: "progress", file: "b", loaded: 100, total: 100 });
            return run;
        });
        const progress = vi.fn();
        await mod.loadBrowserTranscriber(progress);
        expect(lib.env.allowLocalModels).toBe(false);
        expect(lib.pipeline).toHaveBeenCalledWith(
            "automatic-speech-recognition",
            "onnx-community/whisper-base",
            expect.objectContaining({ device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }),
        );
        expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0.5, 0.75]);

        const close = stubAudio([new Float32Array([1, 0]), new Float32Array([0, 1])]);
        expect(await mod.transcribeInBrowser(blob())).toBe("hello there");
        expect(run).toHaveBeenCalledWith(new Float32Array([0.5, 0.5]));
        expect(close).toHaveBeenCalled();
        expect(lib.pipeline).toHaveBeenCalledTimes(1);
    });

    it("runs on WebAssembly without progress, joins chunked output, and passes mono audio through", async () => {
        vi.stubGlobal("navigator", {});
        mod.setBrowserModelConsent("transcription", true);
        const run = vi.fn(async () => [{ text: "one" }, { text: "two " }]);
        lib.pipeline.mockImplementation(async (_task, _repo, options: { progress_callback: (e: object) => void }) => {
            options.progress_callback({ status: "progress", file: "a", loaded: 1, total: 2 });
            return run;
        });
        const mono = new Float32Array([0.25, 0.75]);
        stubAudio([mono]);
        expect(await mod.transcribeInBrowser(blob())).toBe("one two");
        expect(lib.pipeline.mock.calls[0][2]).toMatchObject({ device: "wasm" });
        expect(run).toHaveBeenCalledWith(mono);
    });

    it("forgets a failed load so the next attempt retries", async () => {
        mod.setBrowserModelConsent("transcription", true);
        lib.pipeline.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(vi.fn());
        await expect(mod.loadBrowserTranscriber()).rejects.toThrow("offline");
        await expect(mod.loadBrowserTranscriber()).resolves.toBeDefined();
        expect(lib.pipeline).toHaveBeenCalledTimes(2);
    });
});

describe("Kokoro in the browser", () => {
    it("loads fp32 on WebGPU and speaks with the default voice", async () => {
        vi.stubGlobal("navigator", { gpu: {} });
        mod.setBrowserModelConsent("speech", true);
        const wav = new Blob(["wav"]);
        const generate = vi.fn(async () => ({ toBlob: () => wav }));
        lib.fromPretrained.mockResolvedValue({ generate });
        expect(await mod.speakWithBrowserModel("Hi")).toBe(wav);
        expect(generate).toHaveBeenCalledWith("Hi", { voice: "af_heart", speed: undefined });
        expect(lib.fromPretrained.mock.calls[0][1]).toMatchObject({ dtype: "fp32", device: "webgpu" });
    });

    it("loads q8 on WebAssembly and uses the chosen voice and speed", async () => {
        vi.stubGlobal("navigator", {});
        mod.setBrowserModelConsent("speech", true);
        const generate = vi.fn(async () => ({ toBlob: () => new Blob() }));
        lib.fromPretrained.mockResolvedValue({ generate });
        await mod.speakWithBrowserModel("Hi", { voice: "bm_george", speed: 1.2 });
        expect(generate).toHaveBeenCalledWith("Hi", { voice: "bm_george", speed: 1.2 });
        expect(lib.fromPretrained.mock.calls[0][1]).toMatchObject({ dtype: "q8", device: "wasm" });
    });

    it("forgets a failed load so the next attempt retries", async () => {
        mod.setBrowserModelConsent("speech", true);
        lib.fromPretrained.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ generate: vi.fn() });
        await expect(mod.loadBrowserSpeaker()).rejects.toThrow("offline");
        await expect(mod.loadBrowserSpeaker()).resolves.toBeDefined();
    });

    it("still refuses without consent", async () => {
        await expect(mod.loadBrowserSpeaker()).rejects.toBeInstanceOf(mod.BrowserModelConsentError);
    });
});
