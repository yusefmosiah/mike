"use client";

/**
 * Open speech models that run inside this browser (goals/mission-10-voice.md):
 * Whisper for dictation (transformers.js) and Kokoro for reading aloud
 * (kokoro-js), on WebGPU where the browser has it and WebAssembly otherwise.
 *
 * Nothing is downloaded until the user agrees. Before asking, the setup is
 * described as "about N minutes": N comes from the model's real file sizes
 * (the Hugging Face API) and a short speed test against the same host. The
 * libraries are imported only when a model is used, so they are not in the
 * page's main bundle. The browser keeps the downloaded weights in its cache;
 * recordings and transcripts are never stored.
 */

import { estimateSetupMinutes, measureDownloadSpeed } from "./pricing";

export type BrowserModelKind = "transcription" | "speech";

export interface BrowserModelSpec {
    id: string;
    label: string;
    repo: string;
    /** The weight files this browser will fetch, by backend. */
    files: (webgpu: boolean) => string[];
}

export const BROWSER_MODELS: Record<BrowserModelKind, BrowserModelSpec> = {
    transcription: {
        id: "whisper-base",
        label: "Whisper Base",
        repo: "onnx-community/whisper-base",
        files: () => ["onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"],
    },
    speech: {
        id: "kokoro-82m",
        label: "Kokoro 82M",
        repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
        files: (webgpu) => [webgpu ? "onnx/model.onnx" : "onnx/model_quantized.onnx"],
    },
};

const HUB = "https://huggingface.co";
/** A small file on the same host, for the speed test. */
const SPEED_TEST_PATH = "onnx-community/whisper-base/resolve/main/tokenizer.json";
const CONSENT_KEY = "mike.voice.browser-models.v1";

export function webgpuAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** WebAssembly is enough to run either model, slowly; WebGPU is faster. */
export function browserModelsSupported(): boolean {
    return typeof window !== "undefined" && typeof WebAssembly !== "undefined";
}

function readConsent(): Record<string, boolean> {
    try {
        const raw = window.localStorage.getItem(CONSENT_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : {};
        return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
    } catch {
        return {};
    }
}

export function hasBrowserModelConsent(kind: BrowserModelKind): boolean {
    return readConsent()[BROWSER_MODELS[kind].id] === true;
}

export function setBrowserModelConsent(kind: BrowserModelKind, granted: boolean): void {
    const next = { ...readConsent(), [BROWSER_MODELS[kind].id]: granted };
    try {
        window.localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
    } catch {
        // Without storage the consent lasts until the page reloads.
    }
    sessionConsent[BROWSER_MODELS[kind].id] = granted;
}

const sessionConsent: Record<string, boolean> = {};
const consented = (kind: BrowserModelKind) =>
    sessionConsent[BROWSER_MODELS[kind].id] ?? hasBrowserModelConsent(kind);

export class BrowserModelConsentError extends Error {
    constructor() {
        super("Set up the browser model in Settings → Voice first.");
    }
}

/** Total bytes of the files `kind` will fetch, from the Hugging Face API. */
export async function browserModelBytes(
    kind: BrowserModelKind,
    deps: { fetch?: typeof fetch; webgpu?: boolean } = {},
): Promise<number> {
    const spec = BROWSER_MODELS[kind];
    const doFetch = deps.fetch ?? fetch;
    const wanted = new Set(spec.files(deps.webgpu ?? webgpuAvailable()));
    const response = await doFetch(`${HUB}/api/models/${spec.repo}/tree/main/onnx`);
    if (!response.ok) throw new Error("model size lookup failed");
    const files = (await response.json()) as Array<{ path: string; size?: number; lfs?: { size?: number } }>;
    return files
        .filter((file) => wanted.has(file.path))
        .reduce((sum, file) => sum + (file.lfs?.size ?? file.size ?? 0), 0);
}

/** "About N minutes" for this browser on this connection. */
export async function estimateBrowserModelSetup(
    kind: BrowserModelKind,
    deps: { fetch?: typeof fetch; now?: () => number; webgpu?: boolean } = {},
): Promise<number> {
    const [bytes, bytesPerSecond] = await Promise.all([
        browserModelBytes(kind, deps),
        measureDownloadSpeed(`${HUB}/${SPEED_TEST_PATH}`, deps),
    ]);
    return estimateSetupMinutes(bytes, bytesPerSecond);
}

export type SetupProgress = (fraction: number) => void;

type Transcriber = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>;
let transcriber: Promise<Transcriber> | null = null;

function progressReporter(onProgress?: SetupProgress) {
    const files = new Map<string, { loaded: number; total: number }>();
    return (event: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (!onProgress || event.status !== "progress" || !event.file) return;
        files.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
            loaded += file.loaded;
            total += file.total;
        }
        if (total > 0) onProgress(Math.min(1, loaded / total));
    };
}

/** Downloads (first time) and loads Whisper. Requires consent. */
export function loadBrowserTranscriber(onProgress?: SetupProgress): Promise<Transcriber> {
    if (!consented("transcription")) return Promise.reject(new BrowserModelConsentError());
    transcriber ??= (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.allowLocalModels = false;
        const gpu = webgpuAvailable();
        const run = await pipeline("automatic-speech-recognition", BROWSER_MODELS.transcription.repo, {
            device: gpu ? "webgpu" : "wasm",
            dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
            progress_callback: progressReporter(onProgress),
        });
        return run as unknown as Transcriber;
    })().catch((error: unknown) => {
        transcriber = null;
        throw error;
    });
    return transcriber;
}

/** 16 kHz mono samples, as Whisper expects. */
async function decodeForWhisper(blob: Blob): Promise<Float32Array> {
    const context = new AudioContext({ sampleRate: 16_000 });
    try {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        const mono = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
        return mono;
    } finally {
        void context.close();
    }
}

export async function transcribeInBrowser(blob: Blob): Promise<string> {
    const run = await loadBrowserTranscriber();
    const output = await run(await decodeForWhisper(blob));
    const text = Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text;
    return text.trim();
}

interface KokoroModel {
    generate(text: string, options: { voice?: string; speed?: number }): Promise<{ toBlob(): Blob }>;
}
let kokoro: Promise<KokoroModel> | null = null;

/** Downloads (first time) and loads Kokoro. Requires consent. */
export function loadBrowserSpeaker(onProgress?: SetupProgress): Promise<KokoroModel> {
    if (!consented("speech")) return Promise.reject(new BrowserModelConsentError());
    kokoro ??= (async () => {
        const { KokoroTTS } = await import("kokoro-js");
        const gpu = webgpuAvailable();
        const model = await KokoroTTS.from_pretrained(BROWSER_MODELS.speech.repo, {
            dtype: gpu ? "fp32" : "q8",
            device: gpu ? "webgpu" : "wasm",
            progress_callback: progressReporter(onProgress) as never,
        });
        return model as unknown as KokoroModel;
    })().catch((error: unknown) => {
        kokoro = null;
        throw error;
    });
    return kokoro;
}

export const DEFAULT_KOKORO_VOICE = "af_heart";

/** Kokoro's voices, by name, from the model repository. */
export async function browserModelVoices(deps: { fetch?: typeof fetch } = {}): Promise<string[]> {
    const response = await (deps.fetch ?? fetch)(`${HUB}/api/models/${BROWSER_MODELS.speech.repo}/tree/main/voices`);
    if (!response.ok) return [DEFAULT_KOKORO_VOICE];
    const files = (await response.json()) as Array<{ path: string }>;
    const voices = files
        .map((file) => /voices\/([a-z]{2}_[a-z]+)\.bin$/.exec(file.path)?.[1])
        .filter((name): name is string => !!name);
    return voices.length ? voices : [DEFAULT_KOKORO_VOICE];
}

/** A WAV blob of `text` spoken by Kokoro in this browser. */
export async function speakWithBrowserModel(text: string, options: { voice?: string; speed?: number } = {}): Promise<Blob> {
    const model = await loadBrowserSpeaker();
    const audio = await model.generate(text, { voice: options.voice ?? DEFAULT_KOKORO_VOICE, speed: options.speed });
    return audio.toBlob();
}
