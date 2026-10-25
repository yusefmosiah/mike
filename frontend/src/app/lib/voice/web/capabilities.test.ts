import { describe, expect, it, vi } from "vitest";
import {
    SAFARI_WEBGPU_HINT,
    WEB_VOICE_NEEDS_SERVER_MESSAGE,
    modelBytes,
    planWebVoice,
    probeVoiceCapabilities,
    probeWebGpu,
    type GpuAdapterLike,
    type VoiceCapabilities,
} from "./capabilities";
import { webVoiceSupported } from "./support";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const goodLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 };
const adapter = (overrides: Record<string, unknown> = {}) => ({
    limits: goodLimits,
    requestDevice: vi.fn(async () => ({ destroy: vi.fn() })),
    ...overrides,
});
const gpuWith = (found: unknown) => ({ requestAdapter: vi.fn(async () => found as GpuAdapterLike | null) });

describe("webVoiceSupported", () => {
    const full = {
        isSecureContext: true,
        navigator: { mediaDevices: { getUserMedia: () => undefined } },
        AudioContext: function AudioContext() {},
        AudioWorkletNode: function AudioWorkletNode() {},
        WebAssembly: {},
        Worker: function Worker() {},
        MessageChannel: function MessageChannel() {},
    };

    it("needs a secure page, a microphone, an AudioWorklet, WebAssembly and workers", () => {
        expect(webVoiceSupported(full)).toBe(true);
        expect(webVoiceSupported({ ...full, AudioContext: undefined, webkitAudioContext: function Old() {} })).toBe(true);
        expect(webVoiceSupported(undefined)).toBe(false);
        expect(webVoiceSupported({ ...full, isSecureContext: false })).toBe(false);
        expect(webVoiceSupported({ ...full, navigator: {} })).toBe(false);
        expect(webVoiceSupported({ ...full, AudioWorkletNode: undefined })).toBe(false);
        expect(webVoiceSupported({ ...full, WebAssembly: undefined })).toBe(false);
        expect(webVoiceSupported({ ...full, Worker: undefined })).toBe(false);
    });

    it("is false in the test environment, which has no microphone or AudioWorklet", () => {
        expect(webVoiceSupported()).toBe(false);
    });
});

describe("probeWebGpu", () => {
    it("is usable only with a real adapter, big enough limits and a device", async () => {
        const found = adapter();
        expect(await probeWebGpu({ gpu: gpuWith(found) })).toBe("usable");
        expect(found.requestDevice).toHaveBeenCalled();
    });

    it("says why WebGPU is not used", async () => {
        expect(await probeWebGpu({})).toBe("missing");
        expect(await probeWebGpu(undefined)).toBe("missing");
        // Safari with the API but WebGPU turned off hands out no adapter.
        expect(await probeWebGpu({ gpu: gpuWith(null) })).toBe("no-adapter");
        expect(await probeWebGpu({ gpu: gpuWith(adapter({ info: { isFallbackAdapter: true } })) })).toBe("fallback");
        expect(await probeWebGpu({ gpu: gpuWith(adapter({ isFallbackAdapter: true })) })).toBe("fallback");
        expect(await probeWebGpu({ gpu: gpuWith(adapter({ limits: { maxBufferSize: 2 ** 20, maxStorageBufferBindingSize: 2 ** 30 } })) })).toBe(
            "limits",
        );
        expect(
            await probeWebGpu({ gpu: gpuWith(adapter({ requestDevice: async () => Promise.reject(new Error("lost")) })) }),
        ).toBe("device-failed");
        expect(await probeWebGpu({ gpu: { requestAdapter: () => new Promise(() => undefined) } }, 5)).toBe("timeout");
    });
});

describe("probeVoiceCapabilities", () => {
    it("reads the browser, the memory hint and the pieces it is given", async () => {
        const caps = await probeVoiceCapabilities({
            navigator: { userAgent: IPHONE, maxTouchPoints: 5, deviceMemory: 2, gpu: gpuWith(adapter()) },
            basics: () => true,
            priorCrash: () => true,
            onDeviceRecognition: async () => true,
            systemVoices: () => true,
        });
        expect(caps).toEqual({
            basics: true,
            webgpu: "usable",
            webkit: true,
            appleMobile: true,
            lowMemory: true,
            priorCrash: true,
            onDeviceRecognition: true,
            systemVoices: true,
        });
    });

    it("probes nothing more when the basics are missing", async () => {
        const gpu = gpuWith(adapter());
        const recognition = vi.fn(async () => true);
        const caps = await probeVoiceCapabilities({ navigator: { userAgent: CHROME, gpu }, basics: () => false, onDeviceRecognition: recognition });
        expect(caps.basics).toBe(false);
        expect(gpu.requestAdapter).not.toHaveBeenCalled();
        expect(recognition).not.toHaveBeenCalled();
    });

    it("asks about on-device recognition only where a lighter plan would use it", async () => {
        const recognition = vi.fn(async () => true);
        const caps = await probeVoiceCapabilities({ navigator: { userAgent: CHROME, deviceMemory: 8 }, basics: () => true, onDeviceRecognition: recognition });
        expect(recognition).not.toHaveBeenCalled();
        expect(caps.onDeviceRecognition).toBe(false);
        await probeVoiceCapabilities({ navigator: { userAgent: CHROME }, basics: () => true, priorCrash: () => true, onDeviceRecognition: recognition });
        expect(recognition).toHaveBeenCalledTimes(1);
    });

    it("treats a failing recognition check as none", async () => {
        const caps = await probeVoiceCapabilities({
            navigator: { userAgent: CHROME, deviceMemory: 2 },
            basics: () => true,
            onDeviceRecognition: () => Promise.reject(new Error("no")),
        });
        expect(caps.onDeviceRecognition).toBe(false);
        expect(caps.webkit).toBe(false);
    });
});

const caps = (overrides: Partial<VoiceCapabilities> = {}): VoiceCapabilities => ({
    basics: true,
    webgpu: "usable",
    webkit: false,
    appleMobile: false,
    lowMemory: false,
    priorCrash: false,
    onDeviceRecognition: false,
    systemVoices: true,
    ...overrides,
});

describe("planWebVoice", () => {
    const local = { serverSpeech: false };

    it("runs everything on the GPU where WebGPU works outside WebKit (A)", () => {
        const result = planWebVoice(caps(), local);
        expect(result).toMatchObject({ available: true, plan: { tier: "A", words: "whisper-gpu", speaking: "phonon", models: ["vad", "whisper", "phonon"] } });
    });

    it("runs the words on the CPU and speaks with the system's voice without WebGPU (B)", () => {
        const result = planWebVoice(caps({ webgpu: "no-adapter" }), local);
        expect(result).toMatchObject({ available: true, plan: { tier: "B", words: "whisper-cpu", speaking: "system", models: ["vad", "whisper"] } });
        if (result.available) expect(result.plan.sentence).not.toContain(SAFARI_WEBGPU_HINT);
        const firefoxNoVoices = planWebVoice(caps({ webgpu: "missing", systemVoices: false }), local);
        expect(firefoxNoVoices).toMatchObject({ plan: { tier: "B", speaking: "phonon", models: ["vad", "whisper", "phonon"] } });
    });

    it("tells Safari on the Mac how to turn WebGPU on", () => {
        const result = planWebVoice(caps({ webkit: true, webgpu: "no-adapter" }), local);
        expect(result).toMatchObject({ plan: { tier: "B" } });
        if (result.available) expect(result.plan.sentence).toContain(SAFARI_WEBGPU_HINT);
        // WebKit stays off the GPU even with WebGPU on (browserModels.ts), without the hint.
        const on = planWebVoice(caps({ webkit: true }), local);
        expect(on).toMatchObject({ plan: { tier: "B" } });
        if (on.available) expect(on.plan.sentence).not.toContain(SAFARI_WEBGPU_HINT);
    });

    it("uses the browser's on-device recognition on iPhone, with little memory or after a crash (C)", () => {
        for (const lighter of [{ appleMobile: true, webkit: true }, { lowMemory: true }, { priorCrash: true }]) {
            const result = planWebVoice(caps({ ...lighter, onDeviceRecognition: true }), local);
            expect(result).toMatchObject({ available: true, plan: { tier: "C", words: "web-speech", speaking: "system", models: ["vad"] } });
        }
    });

    it("uses the speech server only when the person has allowed it (D)", () => {
        expect(planWebVoice(caps({ appleMobile: true }), local)).toEqual({
            available: false,
            reason: "needs-server",
            message: WEB_VOICE_NEEDS_SERVER_MESSAGE,
        });
        expect(planWebVoice(caps({ appleMobile: true }), { serverSpeech: true })).toMatchObject({
            plan: { tier: "D", words: "server", speaking: "system", models: ["vad"] },
        });
        expect(planWebVoice(caps({ appleMobile: true, systemVoices: false }), { serverSpeech: true })).toMatchObject({
            plan: { tier: "D", speaking: "server" },
        });
        // Allowed, but not needed: everything stays on the device.
        expect(planWebVoice(caps(), { serverSpeech: true })).toMatchObject({ plan: { tier: "A" } });
    });

    it("is unavailable without the basics", () => {
        expect(planWebVoice(caps({ basics: false }), { serverSpeech: true })).toMatchObject({ available: false, reason: "unsupported" });
    });

    it("never names a model in the sentence", () => {
        const all = [
            planWebVoice(caps(), local),
            planWebVoice(caps({ webgpu: "missing", webkit: true }), local),
            planWebVoice(caps({ appleMobile: true, onDeviceRecognition: true }), local),
            planWebVoice(caps({ appleMobile: true, systemVoices: false }), { serverSpeech: true }),
        ];
        for (const result of all) {
            expect(result.available).toBe(true);
            if (result.available) expect(result.plan.sentence).not.toMatch(/whisper|phonon|silero|kokoro|MB\b/i);
        }
    });

    it("sizes the downloads for the estimate", () => {
        expect(modelBytes("vad", false)).toBeGreaterThan(2e6);
        expect(modelBytes("whisper", true)).toBeLessThan(modelBytes("whisper", false));
        expect(modelBytes("phonon", false)).toBeGreaterThan(6e7);
    });
});

describe("user agents", () => {
    it("tells Chrome, Safari and iPhone apart", async () => {
        const base = { basics: () => true };
        expect((await probeVoiceCapabilities({ ...base, navigator: { userAgent: CHROME } })).webkit).toBe(false);
        expect((await probeVoiceCapabilities({ ...base, navigator: { userAgent: SAFARI } })).webkit).toBe(true);
        expect((await probeVoiceCapabilities({ ...base, navigator: { userAgent: SAFARI } })).appleMobile).toBe(false);
        // An iPad presents itself as a Mac with touch.
        expect((await probeVoiceCapabilities({ ...base, navigator: { userAgent: SAFARI, maxTouchPoints: 5 } })).appleMobile).toBe(true);
    });
});
