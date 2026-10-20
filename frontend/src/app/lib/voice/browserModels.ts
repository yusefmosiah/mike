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
 *
 * The models run in a Web Worker (browserModels.engine.ts, through
 * browserModels.worker.ts): on one WebAssembly thread Kokoro takes seconds
 * per sentence, and on the page's main thread that froze the iPhone app.
 * Consent, the one-model queue and the crash marker stay on the page.
 */

import type { EngineRequest } from "./browserModels.engine";
import { loadPhonon, releasePhonon, speakWithPhonon } from "./browserModels.phonon";
import { estimateSetupMinutes, measureDownloadSpeed } from "./pricing";

export {
    BROWSER_MODELS,
    BROWSER_SPEECH_MODELS,
    DEFAULT_KOKORO_VOICE,
    DEFAULT_PHONON_VOICE,
    PHONON_MODEL_CARD_URL,
    PHONON_VOICES,
    isPhononVoice,
    type BrowserModelKind,
    type BrowserModelRuntime,
    type BrowserModelSpec,
    type BrowserSpeechModel,
    type PhononVoice,
    type SetupProgress,
} from "./browserModels.spec";
import {
    BROWSER_MODELS,
    DEFAULT_KOKORO_VOICE,
    DTYPE_SUFFIX,
    type BrowserModelKind,
    type BrowserModelRuntime,
    type BrowserSpeechModel,
    type SetupProgress,
} from "./browserModels.spec";

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
    const spec = BROWSER_MODELS[kind];
    return [
        ...Object.entries(spec.dtypes(runtime)).map(([session, dtype]) => `onnx/${session}${DTYPE_SUFFIX[dtype]}.onnx`),
        ...(spec.fixedFiles ?? []),
    ];
}

/** WebAssembly is enough to run any of the models, slowly; WebGPU is faster. */
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
    const directory = spec.weightsDir ? `/${spec.weightsDir}` : "";
    const response = await doFetch(`${HUB}/api/models/${spec.repo}/tree/${spec.revision}${directory}`);
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

/**
 * The engine's worker, started on first use. A worker that dies (an error
 * it could not report) fails its pending requests and is started again on
 * the next one.
 */
let engineWorker: Worker | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; onProgress?: SetupProgress }
>();

function startEngineWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    if (engineWorker) return engineWorker;
    const worker = new Worker(new URL("./browserModels.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; type: string; fraction?: number; result?: unknown }>) => {
        const { id, type } = event.data;
        const pending = pendingRequests.get(id);
        if (!pending) return;
        if (type === "progress") {
            pending.onProgress?.(event.data.fraction ?? 0);
            return;
        }
        pendingRequests.delete(id);
        if (type === "done") pending.resolve(event.data.result);
        else pending.reject(new Error("The open model failed."));
    };
    worker.onerror = (event) => {
        event.preventDefault();
        const failed = [...pendingRequests.values()];
        pendingRequests.clear();
        worker.terminate();
        engineWorker = null;
        for (const pending of failed) pending.reject(new Error("The open model's worker stopped."));
    };
    engineWorker = worker;
    return worker;
}

/** Runs a request in the engine's worker, or here where there are no workers. */
async function runEngine<T>(request: EngineRequest, onProgress?: SetupProgress): Promise<T> {
    const worker = startEngineWorker();
    if (!worker) {
        const { handleEngineRequest } = await import("./browserModels.engine");
        return (await handleEngineRequest(request, onProgress)) as T;
    }
    const id = ++nextRequestId;
    return new Promise<T>((resolve, reject) => {
        pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
        worker.postMessage({ id, ...request });
    });
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
        if (runtime.oneModelAtATime) {
            // Phonon lives on the page; the others in the engine's worker.
            if (kind !== "phonon") await releasePhonon();
            await runEngine({ op: "release-other", kind });
        }
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
export function loadBrowserTranscriber(onProgress?: SetupProgress): Promise<void> {
    if (!consented("transcription")) return Promise.reject(new BrowserModelConsentError());
    return withModel("transcription", (runtime) => runEngine<void>({ op: "load", kind: "transcription", runtime }, onProgress));
}

/** Downloads (first time) and loads Kokoro. Requires consent. */
export function loadBrowserSpeaker(onProgress?: SetupProgress): Promise<void> {
    if (!consented("speech")) return Promise.reject(new BrowserModelConsentError());
    return withModel("speech", (runtime) => runEngine<void>({ op: "load", kind: "speech", runtime }, onProgress));
}

/** Downloads (first time) and loads Phonon. Requires consent. */
export function loadBrowserPhonon(onProgress?: SetupProgress): Promise<void> {
    if (!consented("phonon")) return Promise.reject(new BrowserModelConsentError());
    return withModel("phonon", () => loadPhonon(onProgress));
}

/** The in-browser read-aloud model a speech preference names: Kokoro unless it says Phonon. */
export const browserSpeechModel = (model: string | undefined): BrowserSpeechModel =>
    model === "phonon" ? "phonon" : "kokoro";

/** The consent kind of a read-aloud model. */
export const browserSpeechKind = (model: string | undefined): BrowserModelKind =>
    browserSpeechModel(model) === "phonon" ? "phonon" : "speech";

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
        return await withModel("transcription", async (runtime) =>
            runEngine<string>({ op: "transcribe", runtime, samples: await decodeForWhisper(blob) }),
        );
    } catch (error) {
        throw forUser(error);
    }
}

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

/**
 * A WAV blob of `text` spoken in this browser by Kokoro (the default) or, with
 * `model: "phonon"`, by Phonon (whose `speed` is not adjustable: the player
 * changes the speed).
 */
export async function speakWithBrowserModel(
    text: string,
    options: { voice?: string; speed?: number; model?: string } = {},
): Promise<Blob> {
    const kind = browserSpeechKind(options.model);
    if (!consented(kind)) throw new BrowserModelConsentError();
    try {
        if (kind === "phonon") {
            return await withModel(kind, () => speakWithPhonon(text, options.voice));
        }
        return await withModel("speech", (runtime) =>
            runEngine<Blob>({ op: "speak", runtime, text, voice: options.voice, speed: options.speed }),
        );
    } catch (error) {
        throw forUser(error);
    }
}
