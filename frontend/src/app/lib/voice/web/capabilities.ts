/**
 * What this browser can do for voice mode, probed when voice mode starts, and
 * the plan that follows from it (docs/voice-web.md, "Tiers"). Each piece is
 * picked on its own and falls back on its own; the person is told which way
 * voice mode runs here in a plain sentence, without model names.
 *
 * Phase 1 uses only the models already wired: Whisper Base for the words
 * (on the GPU or the CPU), Phonon for the voice on the GPU, the browser's own
 * on-device recognition and the system's voices otherwise, and the
 * deployment's speech server only when the person has turned it on.
 */

import { webVoiceSupported } from "./support";

/** Why WebGPU is or is not used. */
export type WebGpuStatus = "usable" | "missing" | "no-adapter" | "fallback" | "limits" | "device-failed" | "timeout";

export interface VoiceCapabilities {
    /** A secure page with a microphone API, an AudioWorklet, WebAssembly and workers. */
    basics: boolean;
    webgpu: WebGpuStatus;
    /** Safari, or any browser on iPhone and iPad. */
    webkit: boolean;
    /** iPhone or iPad. */
    appleMobile: boolean;
    /** The browser reports under 4 GB of memory. */
    lowMemory: boolean;
    /** The page died while a model ran in this tab. */
    priorCrash: boolean;
    /** The browser can recognise speech on this device without sending it anywhere. */
    onDeviceRecognition: boolean;
    /** The system's voices (`speechSynthesis`). */
    systemVoices: boolean;
}

/** A, B, C and D of docs/voice-web.md: from everything on the GPU to the speech server. */
export type WebVoiceTier = "A" | "B" | "C" | "D";
export type WordsEngine = "whisper-gpu" | "whisper-cpu" | "web-speech" | "server";
export type SpeakingEngine = "phonon" | "system" | "server";
/** The models a plan downloads into the browser. */
export type WebVoiceModel = "vad" | "whisper" | "phonon";

export interface WebVoicePlan {
    tier: WebVoiceTier;
    words: WordsEngine;
    speaking: SpeakingEngine;
    /** Everything the plan downloads (the caller leaves out what is already here). */
    models: WebVoiceModel[];
    /** The sentence that tells the person how voice mode runs here. */
    sentence: string;
}

export type WebVoicePlanResult =
    | { available: true; plan: WebVoicePlan }
    /** `needs-server`: nothing here can turn speech into text; the speech server could, if allowed. */
    | { available: false; reason: "unsupported" | "needs-server"; message: string };

/** Download sizes, for the "about N minutes" estimate (never shown as sizes). */
export const SILERO_BYTES = 2_243_022;
export function modelBytes(model: WebVoiceModel, webkit: boolean): number {
    switch (model) {
        case "vad":
            return SILERO_BYTES;
        case "whisper":
            // The weights browserModels.spec.ts picks: q8 in WebKit, fp32 encoder and q4 decoder elsewhere.
            return webkit ? 77_000_000 : 206_000_000;
        case "phonon":
            return 64_500_000;
    }
}

export interface GpuAdapterLike {
    isFallbackAdapter?: boolean;
    info?: { isFallbackAdapter?: boolean };
    limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
    requestDevice(): Promise<{ destroy?: () => void }>;
}

interface NavigatorLike {
    userAgent?: string;
    maxTouchPoints?: number;
    deviceMemory?: number;
    gpu?: { requestAdapter?: (options?: Record<string, unknown>) => Promise<GpuAdapterLike | null> };
}

/** What WebGPU needs to offer for Whisper's encoder: the WebGPU defaults, at least. */
const MIN_BUFFER = 256 * 2 ** 20;
const MIN_STORAGE_BINDING = 128 * 2 ** 20;
const PROBE_TIMEOUT_MS = 2500;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
    Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);

/**
 * Whether WebGPU really works here: an adapter exists (Safari can have the API
 * with WebGPU turned off), it is not a software fallback, its limits are big
 * enough, and a device can be created (then released at once).
 */
export async function probeWebGpu(nav: NavigatorLike | undefined, timeoutMs = PROBE_TIMEOUT_MS): Promise<WebGpuStatus> {
    const gpu = nav?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return "missing";
    try {
        const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: "high-performance" }), timeoutMs);
        if (adapter === "timeout") return "timeout";
        if (!adapter) return "no-adapter";
        if (adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter) return "fallback";
        const limits = adapter.limits ?? {};
        if ((limits.maxBufferSize ?? 0) < MIN_BUFFER || (limits.maxStorageBufferBindingSize ?? 0) < MIN_STORAGE_BINDING) {
            return "limits";
        }
        const device = await withTimeout(adapter.requestDevice(), timeoutMs);
        if (device === "timeout") return "timeout";
        device.destroy?.();
        return "usable";
    } catch {
        return "device-failed";
    }
}

const webkitAgent = (agent: string) => /AppleWebKit\//.test(agent) && !/(Chrome|Chromium)\//.test(agent);
const appleMobileAgent = (agent: string, touchPoints = 0) =>
    /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1);

export interface ProbeDeps {
    navigator?: NavigatorLike;
    basics?: () => boolean;
    priorCrash?: () => boolean;
    onDeviceRecognition?: () => Promise<boolean>;
    systemVoices?: () => boolean;
    timeoutMs?: number;
}

export async function probeVoiceCapabilities(deps: ProbeDeps = {}): Promise<VoiceCapabilities> {
    const nav = deps.navigator ?? (typeof navigator === "undefined" ? undefined : (navigator as unknown as NavigatorLike));
    const agent = nav?.userAgent ?? "";
    const basics = (deps.basics ?? webVoiceSupported)();
    const [webgpu, onDeviceRecognition] = await Promise.all([
        basics ? probeWebGpu(nav, deps.timeoutMs) : Promise.resolve<WebGpuStatus>("missing"),
        basics && deps.onDeviceRecognition ? deps.onDeviceRecognition().catch(() => false) : Promise.resolve(false),
    ]);
    return {
        basics,
        webgpu,
        webkit: webkitAgent(agent),
        appleMobile: appleMobileAgent(agent, nav?.maxTouchPoints),
        lowMemory: typeof nav?.deviceMemory === "number" && nav.deviceMemory < 4,
        priorCrash: deps.priorCrash?.() ?? false,
        onDeviceRecognition,
        systemVoices: deps.systemVoices?.() ?? false,
    };
}

const STAYS_HERE = "What you say stays in this browser.";

/**
 * Safari with WebGPU turned off. The wording follows Safari's Feature Flags
 * (Develop menu on the Mac; Settings → Apps → Safari → Advanced on iPhone and
 * iPad); recent Safari versions have WebGPU on already.
 */
export const SAFARI_WEBGPU_HINT = "Turning on WebGPU in Safari’s Feature Flags (Develop menu) makes it faster.";

export const WEB_VOICE_UNSUPPORTED_MESSAGE =
    "Voice mode needs a microphone and a newer browser. Try the latest Chrome, Edge, Firefox or Safari.";
export const WEB_VOICE_NEEDS_SERVER_MESSAGE =
    "This browser cannot turn speech into text on this device. To use voice mode here, allow the speech server in Settings → Voice.";

/** How voice mode runs in this browser, or why it cannot. */
export function planWebVoice(caps: VoiceCapabilities, options: { serverSpeech: boolean }): WebVoicePlanResult {
    if (!caps.basics) return { available: false, reason: "unsupported", message: WEB_VOICE_UNSUPPORTED_MESSAGE };
    const lighter = caps.appleMobile || caps.lowMemory || caps.priorCrash;
    const gpu = caps.webgpu === "usable" && !caps.webkit;
    const localVoice: SpeakingEngine | null = caps.systemVoices ? "system" : null;

    if (!lighter && gpu) {
        return {
            available: true,
            plan: {
                tier: "A",
                words: "whisper-gpu",
                speaking: "phonon",
                models: ["vad", "whisper", "phonon"],
                sentence: `Voice mode runs on this device, using its graphics processor. ${STAYS_HERE}`,
            },
        };
    }
    if (!lighter) {
        // Without the GPU, Phonon is too slow on one CPU thread; the system's voices speak.
        const speaking: SpeakingEngine = localVoice ?? "phonon";
        const hint = caps.webkit && caps.webgpu !== "usable" ? ` ${SAFARI_WEBGPU_HINT}` : "";
        return {
            available: true,
            plan: {
                tier: "B",
                words: "whisper-cpu",
                speaking,
                models: speaking === "phonon" ? ["vad", "whisper", "phonon"] : ["vad", "whisper"],
                sentence:
                    `Voice mode runs on this device, without graphics acceleration, so replies take a little longer` +
                    (speaking === "system" ? " and are read in your system’s voice." : ".") +
                    ` ${STAYS_HERE}${hint}`,
            },
        };
    }
    if (caps.onDeviceRecognition && localVoice) {
        return {
            available: true,
            plan: {
                tier: "C",
                words: "web-speech",
                speaking: localVoice,
                models: ["vad"],
                sentence: "Voice mode uses this browser’s on-device speech recognition and your system’s voice. What you say stays on this device.",
            },
        };
    }
    if (!options.serverSpeech) return { available: false, reason: "needs-server", message: WEB_VOICE_NEEDS_SERVER_MESSAGE };
    const speaking: SpeakingEngine = localVoice ?? "server";
    return {
        available: true,
        plan: {
            tier: "D",
            words: "server",
            speaking,
            models: ["vad"],
            sentence:
                "Voice mode listens on this device and sends what you say to this workspace’s speech server to turn it into text" +
                (speaking === "server" ? ", and to read answers aloud." : ". Answers are read in your system’s voice."),
        },
    };
}
