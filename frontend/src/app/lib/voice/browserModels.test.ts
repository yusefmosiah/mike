import { afterEach, describe, expect, it, vi } from "vitest";

import {
    BrowserModelConsentError,
    browserModelBytes,
    browserModelFiles,
    browserModelRuntime,
    browserModelVoices,
    estimateBrowserModelSetup,
    hasBrowserModelConsent,
    loadBrowserSpeaker,
    loadBrowserTranscriber,
    setBrowserModelConsent,
    webkitBrowser,
    type BrowserModelRuntime,
} from "./browserModels";

vi.mock("@huggingface/transformers", () => {
    throw new Error("the model library must not load without consent");
});
vi.mock("kokoro-js", () => {
    throw new Error("the model library must not load without consent");
});

afterEach(() => {
    window.localStorage.clear();
    setBrowserModelConsent("transcription", false);
    setBrowserModelConsent("speech", false);
    vi.unstubAllGlobals();
});

const AGENTS = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15",
    macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
};

const desktopGpu: BrowserModelRuntime = { device: "webgpu", webkit: false, oneModelAtATime: false };
const desktopWasm: BrowserModelRuntime = { device: "wasm", webkit: false, oneModelAtATime: false };
const iphone: BrowserModelRuntime = { device: "wasm", webkit: true, oneModelAtATime: true };

describe("runtime", () => {
    it("keeps WebGPU for Chrome and Firefox and WebAssembly where there is none", () => {
        expect(browserModelRuntime({ userAgent: AGENTS.macChrome, gpu: {} })).toEqual(desktopGpu);
        expect(browserModelRuntime({ userAgent: AGENTS.androidChrome, gpu: {} })).toEqual(desktopGpu);
        expect(browserModelRuntime({ userAgent: AGENTS.firefox })).toEqual(desktopWasm);
        vi.stubGlobal("navigator", undefined);
        expect(browserModelRuntime()).toEqual(desktopWasm);
    });

    it("never uses WebGPU in WebKit, and holds one model at a time on iPhone and iPad", () => {
        // Safari on the iPhone with the WebGPU flag on, as the owner had it.
        expect(browserModelRuntime({ userAgent: AGENTS.iphone, gpu: {}, maxTouchPoints: 5 })).toEqual(iphone);
        expect(browserModelRuntime({ userAgent: AGENTS.iphoneChrome, gpu: {} })).toEqual(iphone);
        // An iPad asks for the desktop site with a Mac user agent.
        expect(browserModelRuntime({ userAgent: AGENTS.macSafari, gpu: {}, maxTouchPoints: 5 })).toEqual(iphone);
        // Safari on the Mac shares the WebKit runtime but keeps both models.
        expect(browserModelRuntime({ userAgent: AGENTS.macSafari, gpu: {} })).toEqual({ ...iphone, oneModelAtATime: false });
        expect(browserModelRuntime({ userAgent: AGENTS.macSafari, maxTouchPoints: 0 })).toEqual({ ...iphone, oneModelAtATime: false });
    });

    it("recognises WebKit by its user agent", () => {
        expect(webkitBrowser({ userAgent: AGENTS.iphone })).toBe(true);
        expect(webkitBrowser({ userAgent: AGENTS.macChrome })).toBe(false);
        expect(webkitBrowser({})).toBe(false);
        vi.stubGlobal("navigator", undefined);
        expect(webkitBrowser()).toBe(false);
        vi.stubGlobal("navigator", { userAgent: AGENTS.iphone });
        expect(webkitBrowser()).toBe(true);
        expect(browserModelRuntime().oneModelAtATime).toBe(true);
    });
});

describe("weights by runtime", () => {
    it("fetches 8-bit weights in WebKit and keeps the desktop files elsewhere", () => {
        expect(browserModelFiles("transcription", iphone)).toEqual([
            "onnx/encoder_model_quantized.onnx",
            "onnx/decoder_model_merged_quantized.onnx",
        ]);
        expect(browserModelFiles("speech", iphone)).toEqual(["onnx/model_quantized.onnx"]);
        expect(browserModelFiles("transcription", desktopGpu)).toEqual([
            "onnx/encoder_model.onnx",
            "onnx/decoder_model_merged_q4.onnx",
        ]);
        expect(browserModelFiles("speech", desktopGpu)).toEqual(["onnx/model.onnx"]);
        expect(browserModelFiles("speech", desktopWasm)).toEqual(["onnx/model_quantized.onnx"]);
    });

    it("asks WebKit for consent again, since its files changed", () => {
        vi.stubGlobal("navigator", { userAgent: AGENTS.macChrome });
        setBrowserModelConsent("speech", true);
        expect(hasBrowserModelConsent("speech")).toBe(true);
        vi.stubGlobal("navigator", { userAgent: AGENTS.iphone });
        expect(hasBrowserModelConsent("speech")).toBe(false);
        setBrowserModelConsent("speech", true);
        expect(JSON.parse(window.localStorage.getItem("mike.voice.browser-models.v1")!)).toMatchObject({
            "kokoro-82m": true,
            "kokoro-82m-webkit": true,
        });
    });
});

const tree = (files: Array<[string, number]>) =>
    new Response(JSON.stringify(files.map(([path, size]) => ({ path, lfs: { size } }))));

describe("consent", () => {
    it("refuses to download a model the user has not agreed to", async () => {
        expect(hasBrowserModelConsent("transcription")).toBe(false);
        await expect(loadBrowserTranscriber()).rejects.toBeInstanceOf(BrowserModelConsentError);
        await expect(loadBrowserSpeaker()).rejects.toBeInstanceOf(BrowserModelConsentError);
    });

    it("remembers consent per model", () => {
        setBrowserModelConsent("speech", true);
        expect(hasBrowserModelConsent("speech")).toBe(true);
        expect(hasBrowserModelConsent("transcription")).toBe(false);
    });
});

describe("setup estimate", () => {
    it("sums the files this browser will fetch", async () => {
        const fetchMock = vi.fn(async () =>
            tree([
                ["onnx/model.onnx", 325_000_000],
                ["onnx/model_quantized.onnx", 92_000_000],
                ["onnx/model_fp16.onnx", 163_000_000],
            ]),
        ) as unknown as typeof fetch;
        expect(await browserModelBytes("speech", { fetch: fetchMock, runtime: desktopGpu })).toBe(325_000_000);
        expect(await browserModelBytes("speech", { fetch: fetchMock, runtime: desktopWasm })).toBe(92_000_000);
        expect(await browserModelBytes("speech", { fetch: fetchMock, runtime: iphone })).toBe(92_000_000);
    });

    it("turns size and measured speed into minutes", async () => {
        let t = 0;
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("/api/models/")) {
                return tree([
                    ["onnx/encoder_model.onnx", 82_500_000],
                    ["onnx/decoder_model_merged_q4.onnx", 123_600_000],
                ]);
            }
            t += 1000;
            return new Response(new Uint8Array(1_000_000));
        }) as unknown as typeof fetch;
        // 206 MB at 1 MB/s is 3.4 minutes, so "about 4 minutes".
        expect(await estimateBrowserModelSetup("transcription", { fetch: fetchMock, now: () => t, runtime: desktopGpu })).toBe(4);
    });

    it("sizes the iPhone's setup by the 8-bit Whisper it will run", async () => {
        const fetchMock = vi.fn(async () =>
            tree([
                ["onnx/encoder_model.onnx", 82_500_000],
                ["onnx/encoder_model_quantized.onnx", 23_200_000],
                ["onnx/decoder_model_merged_q4.onnx", 123_600_000],
                ["onnx/decoder_model_merged_quantized.onnx", 53_700_000],
            ]),
        ) as unknown as typeof fetch;
        expect(await browserModelBytes("transcription", { fetch: fetchMock, runtime: iphone })).toBe(76_900_000);
    });
});

describe("browserModelVoices", () => {
    it("lists Kokoro's voices by name", async () => {
        const fetchMock = vi.fn(async () =>
            new Response(JSON.stringify([{ path: "voices/af.bin" }, { path: "voices/af_heart.bin" }, { path: "voices/bm_george.bin" }])),
        ) as unknown as typeof fetch;
        expect(await browserModelVoices({ fetch: fetchMock })).toEqual(["af_heart", "bm_george"]);
    });
});
