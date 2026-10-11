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
 *
 * Safari, and every browser on iPhone and iPad (all WebKit), gets its own
 * runtime (2026-10-11). The ONNX Runtime build that transformers.js loads by
 * default (the JSEP build, which WebGPU needs) is compiled with Asyncify; its
 * largest WebAssembly function is about 1.3 MB, and WebKit's optimizing
 * compiler runs away on functions that size (WebKit bug 304810,
 * microsoft/onnxruntime#26827). Memory climbs until iOS kills the page's
 * process and Safari reloads the page, with no error, on WebGPU and
 * WebAssembly alike. So in WebKit the models run on ONNX Runtime's plain
 * WebAssembly build (largest function about 0.7 MB), on one thread, with
 * 8-bit weights; WebGPU is not used there. On iPhone and iPad only one model
 * is kept in memory at a time. A run the page did not survive is reported on
 * the next attempt instead of failing silently again. Reproduced and checked
 * in Safari on the iOS 26.2 Simulator; see goals/mission-10-voice.md.
 */

import { estimateSetupMinutes, measureDownloadSpeed } from "./pricing";

export type BrowserModelKind = "transcription" | "speech";

/** How the models run in this browser; see browserModelRuntime(). */
export interface BrowserModelRuntime {
    device: "webgpu" | "wasm";
    /** Safari or any iOS browser: ONNX Runtime's plain WebAssembly build. */
    webkit: boolean;
    /** iPhone and iPad: only one model in memory at a time. */
    oneModelAtATime: boolean;
}

type Dtype = "fp32" | "q8" | "q4";
/** transformers.js's file name suffix for each weight type. */
const DTYPE_SUFFIX: Record<Dtype, string> = { fp32: "", q8: "_quantized", q4: "_q4" };

export interface BrowserModelSpec {
    id: string;
    label: string;
    repo: string;
    /** The weights of each ONNX session in the model, by runtime. */
    dtypes: (runtime: BrowserModelRuntime) => Record<string, Dtype>;
}

export const BROWSER_MODELS: Record<BrowserModelKind, BrowserModelSpec> = {
    transcription: {
        id: "whisper-base",
        label: "Whisper Base",
        repo: "onnx-community/whisper-base",
        // 77 MB in WebKit. Elsewhere 206 MB: the q4 decoder keeps its
        // vocabulary embedding in fp32.
        dtypes: (runtime) =>
            runtime.webkit
                ? { encoder_model: "q8", decoder_model_merged: "q8" }
                : { encoder_model: "fp32", decoder_model_merged: "q4" },
    },
    speech: {
        id: "kokoro-82m",
        label: "Kokoro 82M",
        repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
        // 326 MB in fp32 on WebGPU, 92 MB in q8 on WebAssembly.
        dtypes: (runtime) => ({ model: runtime.device === "webgpu" ? "fp32" : "q8" }),
    },
};

const HUB = "https://huggingface.co";
/** A small file on the same host, for the speed test. */
const SPEED_TEST_PATH = "onnx-community/whisper-base/resolve/main/tokenizer.json";
const CONSENT_KEY = "mike.voice.browser-models.v1";
/**
 * Set while a model loads or runs, so a page that died mid-run is noticed.
 * Per tab: Safari keeps a tab's session storage when it reloads the page
 * after its process is killed, and another tab's run does not count.
 */
const RUNNING_KEY = "mike.voice.browser-models.running.v1";
/** Where transformers.js fetches ONNX Runtime's WebAssembly by default. */
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@";

interface NavigatorLike {
    userAgent?: string;
    maxTouchPoints?: number;
    gpu?: unknown;
}

const currentNavigator = (): NavigatorLike | undefined =>
    typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike);

export function webgpuAvailable(nav: NavigatorLike | undefined = currentNavigator()): boolean {
    return !!nav && "gpu" in nav && !!nav.gpu;
}

/**
 * Safari on the Mac, and every browser on iPhone and iPad: Chrome, Firefox
 * and Edge there are WebKit too, without "Chrome/" in their user agent.
 */
export function webkitBrowser(nav: NavigatorLike | undefined = currentNavigator()): boolean {
    return webkitAgent(nav?.userAgent ?? "");
}

const webkitAgent = (agent: string) => /AppleWebKit\//.test(agent) && !/(Chrome|Chromium)\//.test(agent);

/** iPhone, iPod, or an iPad (which may present itself as a Mac). */
function appleMobile(agent: string, maxTouchPoints = 0): boolean {
    return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && maxTouchPoints > 1);
}

export function browserModelRuntime(nav: NavigatorLike | undefined = currentNavigator()): BrowserModelRuntime {
    const agent = nav?.userAgent ?? "";
    const webkit = webkitAgent(agent);
    return {
        device: !webkit && webgpuAvailable(nav) ? "webgpu" : "wasm",
        webkit,
        oneModelAtATime: webkit && appleMobile(agent, nav?.maxTouchPoints),
    };
}

/** The weight files `kind` fetches and runs on `runtime`. */
export function browserModelFiles(
    kind: BrowserModelKind,
    runtime: BrowserModelRuntime = browserModelRuntime(),
): string[] {
    return Object.entries(BROWSER_MODELS[kind].dtypes(runtime)).map(
        ([session, dtype]) => `onnx/${session}${DTYPE_SUFFIX[dtype]}.onnx`,
    );
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

/**
 * Consent is per model and per runtime: a WebKit browser that agreed before
 * its runtime changed is asked again, so its setup fetches the files it runs.
 */
const consentId = (kind: BrowserModelKind) => BROWSER_MODELS[kind].id + (browserModelRuntime().webkit ? "-webkit" : "");

export function hasBrowserModelConsent(kind: BrowserModelKind): boolean {
    return readConsent()[consentId(kind)] === true;
}

export function setBrowserModelConsent(kind: BrowserModelKind, granted: boolean): void {
    const next = { ...readConsent(), [consentId(kind)]: granted };
    try {
        window.localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
    } catch {
        // Without storage the consent lasts until the page reloads.
    }
    sessionConsent[consentId(kind)] = granted;
}

const sessionConsent: Record<string, boolean> = {};
const consented = (kind: BrowserModelKind) => sessionConsent[consentId(kind)] ?? hasBrowserModelConsent(kind);

/** A failure whose message is written for the user. */
export class BrowserModelError extends Error {}

export class BrowserModelConsentError extends BrowserModelError {
    constructor() {
        super("Set up the browser model in Settings → Voice first.");
    }
}

export const BROWSER_MODEL_FAILED_MESSAGE =
    "The open model could not run in this browser. Try again, or choose another engine in Settings → Voice.";
export const BROWSER_MODEL_RESTARTED_MESSAGE =
    "The page restarted while the open model was running, most likely because this device ran out of memory. Try again, or choose another engine in Settings → Voice.";

/** Total bytes of the files `kind` will fetch, from the Hugging Face API. */
export async function browserModelBytes(
    kind: BrowserModelKind,
    deps: { fetch?: typeof fetch; runtime?: BrowserModelRuntime } = {},
): Promise<number> {
    const spec = BROWSER_MODELS[kind];
    const doFetch = deps.fetch ?? fetch;
    const wanted = new Set(browserModelFiles(kind, deps.runtime));
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
    deps: { fetch?: typeof fetch; now?: () => number; runtime?: BrowserModelRuntime } = {},
): Promise<number> {
    const [bytes, bytesPerSecond] = await Promise.all([
        browserModelBytes(kind, deps),
        measureDownloadSpeed(`${HUB}/${SPEED_TEST_PATH}`, deps),
    ]);
    return estimateSetupMinutes(bytes, bytesPerSecond);
}

export type SetupProgress = (fraction: number) => void;

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

/** The parts of transformers.js's `env` this module sets. */
interface TransformersEnv {
    allowLocalModels: boolean;
    backends?: { onnx?: { versions?: { web?: string }; wasm?: { wasmPaths?: unknown; numThreads?: number } } };
}

/**
 * In WebKit, ONNX Runtime's plain WebAssembly build (the same version as the
 * bundled ONNX Runtime) on one thread, instead of the JSEP build. Must run
 * before the first model loads: ONNX Runtime starts its WebAssembly once.
 */
function configureRuntime(env: TransformersEnv, runtime: BrowserModelRuntime): void {
    env.allowLocalModels = false;
    if (!runtime.webkit) return;
    const onnx = env.backends?.onnx;
    const version = onnx?.versions?.web;
    if (!onnx?.wasm || !version) throw new Error("ONNX Runtime Web is missing");
    const dist = `${ORT_CDN}${version}/dist/`;
    onnx.wasm.wasmPaths = { mjs: `${dist}ort-wasm-simd-threaded.mjs`, wasm: `${dist}ort-wasm-simd-threaded.wasm` };
    onnx.wasm.numThreads = 1;
}

type Transcriber = ((audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>) & {
    dispose?: () => Promise<unknown>;
};
let transcriber: Promise<Transcriber> | null = null;

function transcriberInstance(runtime: BrowserModelRuntime, onProgress?: SetupProgress): Promise<Transcriber> {
    transcriber ??= (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        configureRuntime(env as unknown as TransformersEnv, runtime);
        const run = await pipeline("automatic-speech-recognition", BROWSER_MODELS.transcription.repo, {
            device: runtime.device,
            dtype: BROWSER_MODELS.transcription.dtypes(runtime),
            progress_callback: progressReporter(onProgress),
        });
        return run as unknown as Transcriber;
    })().catch((error: unknown) => {
        transcriber = null;
        throw error;
    });
    return transcriber;
}

interface KokoroModel {
    generate(text: string, options: { voice?: string; speed?: number }): Promise<{ toBlob(): Blob }>;
    model?: { dispose?: () => Promise<unknown> };
}
let kokoro: Promise<KokoroModel> | null = null;

/**
 * Kokoro's phonemizer unpacks its WebAssembly with `for await` over a
 * ReadableStream, which Safari 26.2 cannot iterate: the import rejects in the
 * background and every `generate` waits forever. This adds the iteration
 * where the browser lacks it, before kokoro-js is imported.
 */
function ensureStreamIteration(): void {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    if (typeof proto[Symbol.asyncIterator] === "function") return;
    Object.defineProperty(proto, Symbol.asyncIterator, {
        configurable: true,
        writable: true,
        value: async function* (this: ReadableStream<unknown>) {
            const reader = this.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) return;
                    yield value;
                }
            } finally {
                reader.releaseLock();
            }
        },
    });
}

function speakerInstance(runtime: BrowserModelRuntime, onProgress?: SetupProgress): Promise<KokoroModel> {
    kokoro ??= (async () => {
        ensureStreamIteration();
        const [{ KokoroTTS }, { env }] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
        configureRuntime(env as unknown as TransformersEnv, runtime);
        const model = await KokoroTTS.from_pretrained(BROWSER_MODELS.speech.repo, {
            dtype: BROWSER_MODELS.speech.dtypes(runtime).model,
            device: runtime.device,
            progress_callback: progressReporter(onProgress) as never,
        });
        return model as unknown as KokoroModel;
    })().catch((error: unknown) => {
        kokoro = null;
        throw error;
    });
    return kokoro;
}

/** Frees the model that is not `kind`, so only one is in memory. */
async function releaseOther(kind: BrowserModelKind): Promise<void> {
    if (kind === "transcription" && kokoro) {
        const held = kokoro;
        kokoro = null;
        await held.then((model) => model.model?.dispose?.()).catch(() => undefined);
    }
    if (kind === "speech" && transcriber) {
        const held = transcriber;
        transcriber = null;
        await held.then((run) => run.dispose?.()).catch(() => undefined);
    }
}

let running = 0;

function markRunning(kind: BrowserModelKind | null): void {
    try {
        if (kind) window.sessionStorage.setItem(RUNNING_KEY, kind);
        else window.sessionStorage.removeItem(RUNNING_KEY);
    } catch {
        // Without storage a page that dies mid-run is not reported.
    }
}

function previousRunDied(): boolean {
    try {
        return running === 0 && window.sessionStorage.getItem(RUNNING_KEY) !== null;
    } catch {
        return false;
    }
}

let watchingPagehide = false;
function watchPagehide(): void {
    if (watchingPagehide) return;
    watchingPagehide = true;
    // Leaving the page mid-run is not a crash; only a killed page skips this.
    window.addEventListener("pagehide", () => {
        if (running > 0) markRunning(null);
    });
}

/**
 * Runs `work` with the marker that notices a page that dies mid-run (iOS
 * gives the page no error; Safari just reloads it). On iPhone and iPad the
 * work is queued and the other model released first.
 */
let queue: Promise<unknown> = Promise.resolve();
function withModel<T>(kind: BrowserModelKind, work: (runtime: BrowserModelRuntime) => Promise<T>): Promise<T> {
    const runtime = browserModelRuntime();
    watchPagehide();
    const guarded = async () => {
        if (previousRunDied()) {
            markRunning(null);
            throw new BrowserModelError(BROWSER_MODEL_RESTARTED_MESSAGE);
        }
        if (runtime.oneModelAtATime) await releaseOther(kind);
        running += 1;
        markRunning(kind);
        try {
            return await work(runtime);
        } finally {
            running -= 1;
            if (running === 0) markRunning(null);
        }
    };
    if (!runtime.oneModelAtATime) return guarded();
    const next = queue.then(guarded);
    queue = next.catch(() => undefined);
    return next;
}

/** Downloads (first time) and loads Whisper. Requires consent. */
export function loadBrowserTranscriber(onProgress?: SetupProgress): Promise<Transcriber> {
    if (!consented("transcription")) return Promise.reject(new BrowserModelConsentError());
    return withModel("transcription", (runtime) => transcriberInstance(runtime, onProgress));
}

/** Downloads (first time) and loads Kokoro. Requires consent. */
export function loadBrowserSpeaker(onProgress?: SetupProgress): Promise<KokoroModel> {
    if (!consented("speech")) return Promise.reject(new BrowserModelConsentError());
    return withModel("speech", (runtime) => speakerInstance(runtime, onProgress));
}

/** Errors from the libraries become one message written for the user. */
function forUser(error: unknown): BrowserModelError {
    return error instanceof BrowserModelError ? error : new BrowserModelError(BROWSER_MODEL_FAILED_MESSAGE);
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
    if (!consented("transcription")) throw new BrowserModelConsentError();
    try {
        return await withModel("transcription", async (runtime) => {
            const run = await transcriberInstance(runtime);
            const output = await run(await decodeForWhisper(blob));
            const text = Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text;
            return text.trim();
        });
    } catch (error) {
        throw forUser(error);
    }
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
    if (!consented("speech")) throw new BrowserModelConsentError();
    try {
        return await withModel("speech", async (runtime) => {
            const model = await speakerInstance(runtime);
            const audio = await model.generate(text, { voice: options.voice ?? DEFAULT_KOKORO_VOICE, speed: options.speed });
            return audio.toBlob();
        });
    } catch (error) {
        throw forUser(error);
    }
}
