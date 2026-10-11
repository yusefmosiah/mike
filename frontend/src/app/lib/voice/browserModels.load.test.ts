import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loading paths with stand-in libraries; browserModels.test.ts keeps the
// guard that nothing loads without consent.
const lib = vi.hoisted(() => ({
    pipeline: vi.fn(),
    env: { allowLocalModels: true } as { allowLocalModels: boolean; backends?: unknown },
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
    lib.env.allowLocalModels = true;
    delete lib.env.backends;
    // A desktop browser unless a test says otherwise (jsdom's own user
    // agent names AppleWebKit).
    vi.stubGlobal("navigator", {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
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
        await expect(mod.loadBrowserSpeaker()).resolves.toBeUndefined();
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
        expect(await mod.browserModelBytes("speech", { fetch: noSize })).toBe(0);
        const bad = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
        await expect(mod.browserModelBytes("speech", { fetch: bad })).rejects.toThrow("model size lookup failed");
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
        await expect(mod.loadBrowserTranscriber()).resolves.toBeUndefined();
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

    it("lets Safari iterate a ReadableStream before Kokoro's phonemizer needs it", async () => {
        class OldStream<T> extends ReadableStream<T> {}
        Object.defineProperty(OldStream.prototype, Symbol.asyncIterator, { value: undefined, configurable: true });
        vi.stubGlobal("ReadableStream", OldStream);
        mod.setBrowserModelConsent("speech", true);
        lib.fromPretrained.mockResolvedValue({ generate: vi.fn() });
        await mod.loadBrowserSpeaker();
        const iterate = OldStream.prototype[Symbol.asyncIterator];
        expect(typeof iterate).toBe("function");
        const chunks: number[] = [];
        const stream = new OldStream<number>({
            start(controller) {
                controller.enqueue(1);
                controller.enqueue(2);
                controller.close();
            },
        });
        for await (const chunk of stream) chunks.push(chunk);
        expect(chunks).toEqual([1, 2]);
        expect(stream.locked).toBe(false);
        // Already there: left alone.
        await mod.loadBrowserSpeaker();
        expect(OldStream.prototype[Symbol.asyncIterator]).toBe(iterate);
    });

    it("forgets a failed load so the next attempt retries", async () => {
        mod.setBrowserModelConsent("speech", true);
        lib.fromPretrained.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ generate: vi.fn() });
        await expect(mod.loadBrowserSpeaker()).rejects.toThrow("offline");
        await expect(mod.loadBrowserSpeaker()).resolves.toBeUndefined();
    });

    it("still refuses without consent", async () => {
        await expect(mod.loadBrowserSpeaker()).rejects.toBeInstanceOf(mod.BrowserModelConsentError);
    });
});

const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
const ORT = "1.22.0-dev.20250409-89f8206ba4";
const RUNNING_KEY = "mike.voice.browser-models.running.v1";

const onnxEnv = () => ({ versions: { web: ORT }, wasm: {} as { wasmPaths?: unknown; numThreads?: number } });
const spoken = () => ({ toBlob: () => new Blob(["wav"]) });

describe("in WebKit (Safari, and every iPhone browser)", () => {
    beforeEach(() => {
        // Safari on the iPhone with the WebGPU feature flag on.
        vi.stubGlobal("navigator", { userAgent: IPHONE, gpu: {}, maxTouchPoints: 5 });
        mod.setBrowserModelConsent("transcription", true);
        mod.setBrowserModelConsent("speech", true);
    });

    it("runs Whisper on ONNX Runtime's plain WebAssembly build, on one thread, with 8-bit weights", async () => {
        const onnx = onnxEnv();
        lib.env.backends = { onnx };
        lib.pipeline.mockResolvedValue(vi.fn(async () => ({ text: "hi" })));
        await mod.loadBrowserTranscriber();
        expect(onnx.wasm).toEqual({
            wasmPaths: {
                mjs: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort-wasm-simd-threaded.mjs`,
                wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist/ort-wasm-simd-threaded.wasm`,
            },
            numThreads: 1,
        });
        expect(lib.env.allowLocalModels).toBe(false);
        expect(lib.pipeline.mock.calls[0][2]).toMatchObject({
            device: "wasm",
            dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        });
    });

    it("runs Kokoro the same way, in q8, on Safari for the Mac too", async () => {
        vi.stubGlobal("navigator", { userAgent: MAC_SAFARI, gpu: {}, maxTouchPoints: 0 });
        mod.setBrowserModelConsent("speech", true);
        const onnx = onnxEnv();
        lib.env.backends = { onnx };
        lib.fromPretrained.mockResolvedValue({ generate: vi.fn(async () => spoken()) });
        await mod.speakWithBrowserModel("Hi");
        expect(onnx.wasm.numThreads).toBe(1);
        expect(onnx.wasm.wasmPaths).toMatchObject({ wasm: expect.stringMatching(/\/ort-wasm-simd-threaded\.wasm$/) });
        expect(lib.fromPretrained.mock.calls[0][1]).toMatchObject({ dtype: "q8", device: "wasm" });
    });

    it("does not fall back to the JSEP build when ONNX Runtime cannot be configured", async () => {
        for (const backends of [undefined, { onnx: { wasm: {} } }, { onnx: { versions: { web: ORT } } }]) {
            lib.env.backends = backends;
            await expect(mod.loadBrowserTranscriber()).rejects.toThrow("ONNX Runtime Web is missing");
        }
        await expect(mod.transcribeInBrowser(blob())).rejects.toThrow(mod.BROWSER_MODEL_FAILED_MESSAGE);
        expect(lib.pipeline).not.toHaveBeenCalled();
    });

    it("keeps one model in memory on the iPhone, releasing the other first", async () => {
        lib.env.backends = { onnx: onnxEnv() };
        const disposeWhisper = vi.fn(async () => {});
        const disposeKokoro = vi.fn(async () => {});
        lib.pipeline.mockImplementation(async () =>
            Object.assign(vi.fn(async () => ({ text: "hi" })), { dispose: disposeWhisper }),
        );
        lib.fromPretrained.mockResolvedValue({ generate: vi.fn(async () => spoken()), model: { dispose: disposeKokoro } });
        stubAudio([new Float32Array([0])]);

        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        await mod.speakWithBrowserModel("Hi");
        expect(disposeWhisper).toHaveBeenCalledTimes(1);
        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        expect(disposeKokoro).toHaveBeenCalledTimes(1);
        expect(lib.pipeline).toHaveBeenCalledTimes(2);
        expect(lib.fromPretrained).toHaveBeenCalledTimes(1);
    });

    it("queues work on the iPhone so a model is never released mid-run", async () => {
        lib.env.backends = { onnx: onnxEnv() };
        let finishSpeech: (value: ReturnType<typeof spoken>) => void = () => {};
        const generate = vi.fn(() => new Promise<ReturnType<typeof spoken>>((resolve) => (finishSpeech = resolve)));
        const disposeKokoro = vi.fn(async () => {});
        lib.fromPretrained.mockResolvedValue({ generate, model: { dispose: disposeKokoro } });
        lib.pipeline.mockResolvedValue(vi.fn(async () => ({ text: "hi" })));
        stubAudio([new Float32Array([0])]);

        const speaking = mod.speakWithBrowserModel("Hi");
        const transcribing = mod.transcribeInBrowser(blob());
        await vi.waitFor(() => expect(generate).toHaveBeenCalled());
        expect(lib.pipeline).not.toHaveBeenCalled();
        expect(disposeKokoro).not.toHaveBeenCalled();
        finishSpeech(spoken());
        await speaking;
        expect(await transcribing).toBe("hi");
        expect(disposeKokoro).toHaveBeenCalledTimes(1);
    });

    it("carries on after a failed run, a model without dispose, and a dispose that fails", async () => {
        lib.env.backends = { onnx: onnxEnv() };
        const generate = vi.fn(async () => spoken());
        lib.fromPretrained
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ generate, model: { dispose: vi.fn(async () => Promise.reject(new Error("busy"))) } })
            .mockResolvedValueOnce({ generate, model: {} })
            .mockResolvedValueOnce({ generate });
        const run = vi.fn(async () => ({ text: "hi" }));
        lib.pipeline
            .mockResolvedValueOnce(Object.assign(run, { dispose: vi.fn(async () => Promise.reject(new Error("busy"))) }))
            .mockResolvedValue(vi.fn(async () => ({ text: "hi" })));
        stubAudio([new Float32Array([0])]);

        await expect(mod.speakWithBrowserModel("Hi")).rejects.toThrow(mod.BROWSER_MODEL_FAILED_MESSAGE);
        await mod.speakWithBrowserModel("Hi");
        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        await mod.speakWithBrowserModel("Hi");
        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        await mod.speakWithBrowserModel("Hi");
        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        expect(lib.fromPretrained).toHaveBeenCalledTimes(4);
    });
});

describe("a page that died while a model ran", () => {
    it("is reported once instead of silently running again", async () => {
        mod.setBrowserModelConsent("transcription", true);
        window.sessionStorage.setItem(RUNNING_KEY, "transcription");
        lib.pipeline.mockResolvedValue(vi.fn(async () => ({ text: "hi" })));
        stubAudio([new Float32Array([0])]);

        await expect(mod.transcribeInBrowser(blob())).rejects.toThrow(mod.BROWSER_MODEL_RESTARTED_MESSAGE);
        expect(lib.pipeline).not.toHaveBeenCalled();
        expect(window.sessionStorage.getItem(RUNNING_KEY)).toBeNull();
        expect(await mod.transcribeInBrowser(blob())).toBe("hi");
        expect(window.sessionStorage.getItem(RUNNING_KEY)).toBeNull();
    });

    it("is reported to setup too", async () => {
        mod.setBrowserModelConsent("speech", true);
        window.sessionStorage.setItem(RUNNING_KEY, "speech");
        await expect(mod.loadBrowserSpeaker()).rejects.toBeInstanceOf(mod.BrowserModelError);
    });

    it("is marked only while a model runs, and not after the user leaves the page", async () => {
        mod.setBrowserModelConsent("speech", true);
        let finish: (value: ReturnType<typeof spoken>) => void = () => {};
        lib.fromPretrained.mockResolvedValue({
            generate: vi.fn(() => new Promise<ReturnType<typeof spoken>>((resolve) => (finish = resolve))),
        });
        const speaking = mod.speakWithBrowserModel("Hi");
        await vi.waitFor(() => expect(window.sessionStorage.getItem(RUNNING_KEY)).toBe("speech"));
        // A second run in the same page is not taken for a dead page.
        await expect(mod.loadBrowserSpeaker()).resolves.toBeUndefined();
        window.dispatchEvent(new Event("pagehide"));
        expect(window.sessionStorage.getItem(RUNNING_KEY)).toBeNull();
        finish(spoken());
        await expect(speaking).resolves.toBeInstanceOf(Blob);
        window.sessionStorage.setItem(RUNNING_KEY, "speech");
        window.dispatchEvent(new Event("pagehide"));
        expect(window.sessionStorage.getItem(RUNNING_KEY)).toBe("speech");
    });

    it("cannot be noticed without storage, and the model still runs", async () => {
        mod.setBrowserModelConsent("speech", true);
        lib.fromPretrained.mockResolvedValue({ generate: vi.fn(async () => spoken()) });
        const denied = () => {
            throw new Error("denied");
        };
        const spies = [
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied),
            vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied),
            vi.spyOn(Storage.prototype, "removeItem").mockImplementation(denied),
        ];
        await expect(mod.speakWithBrowserModel("Hi")).resolves.toBeInstanceOf(Blob);
        spies.forEach((spy) => spy.mockRestore());
    });

    it("leaves the consent message as it is", async () => {
        await expect(mod.transcribeInBrowser(blob())).rejects.toBeInstanceOf(mod.BrowserModelConsentError);
        await expect(mod.speakWithBrowserModel("Hi")).rejects.toBeInstanceOf(mod.BrowserModelConsentError);
    });
});
