import { afterEach, describe, expect, it, vi } from "vitest";

import {
    BrowserModelConsentError,
    browserModelBytes,
    browserModelVoices,
    estimateBrowserModelSetup,
    hasBrowserModelConsent,
    loadBrowserSpeaker,
    loadBrowserTranscriber,
    setBrowserModelConsent,
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
        expect(await browserModelBytes("speech", { fetch: fetchMock, webgpu: true })).toBe(325_000_000);
        expect(await browserModelBytes("speech", { fetch: fetchMock, webgpu: false })).toBe(92_000_000);
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
        expect(await estimateBrowserModelSetup("transcription", { fetch: fetchMock, now: () => t, webgpu: true })).toBe(4);
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
