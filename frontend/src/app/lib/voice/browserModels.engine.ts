/**
 * The open models themselves: loading Whisper and Kokoro with the runtime
 * this browser needs, running them, and freeing one. browserModels.ts runs
 * this in a Web Worker (browserModels.worker.ts), so a model that takes
 * seconds per sentence never freezes the page; where there are no workers
 * (tests) it runs here directly. Consent, the one-model queue and the
 * crash marker stay with the page, in browserModels.ts.
 */

import {
    BROWSER_MODELS,
    DEFAULT_KOKORO_VOICE,
    type BrowserModelKind,
    type BrowserModelRuntime,
    type SetupProgress,
} from "./browserModels.spec";

/** Where transformers.js fetches ONNX Runtime's WebAssembly by default. */
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@";

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
export async function releaseOther(kind: BrowserModelKind): Promise<void> {
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

/** One piece of work for the engine, as the page sends it. */
export type EngineRequest =
    | { op: "load"; kind: BrowserModelKind; runtime: BrowserModelRuntime }
    | { op: "release-other"; kind: BrowserModelKind }
    | { op: "transcribe"; runtime: BrowserModelRuntime; samples: Float32Array }
    | { op: "speak"; runtime: BrowserModelRuntime; text: string; voice?: string; speed?: number };

/** Runs one request; the result is structured-cloneable (a string, a Blob or nothing). */
export async function handleEngineRequest(request: EngineRequest, onProgress?: SetupProgress): Promise<unknown> {
    switch (request.op) {
        case "load":
            if (request.kind === "transcription") await transcriberInstance(request.runtime, onProgress);
            else await speakerInstance(request.runtime, onProgress);
            return undefined;
        case "release-other":
            await releaseOther(request.kind);
            return undefined;
        case "transcribe": {
            const run = await transcriberInstance(request.runtime);
            const output = await run(request.samples);
            const text = Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text;
            return text.trim();
        }
        case "speak": {
            const model = await speakerInstance(request.runtime);
            const audio = await model.generate(request.text, {
                voice: request.voice ?? DEFAULT_KOKORO_VOICE,
                speed: request.speed,
            });
            return audio.toBlob();
        }
    }
}
