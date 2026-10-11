/**
 * What the open models are, shared by the page (browserModels.ts) and the
 * engine in its worker (browserModels.engine.ts). Kept apart so the worker's
 * bundle does not import the page module that starts the worker.
 */

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
export const DTYPE_SUFFIX: Record<Dtype, string> = { fp32: "", q8: "_quantized", q4: "_q4" };

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

export type SetupProgress = (fraction: number) => void;

export const DEFAULT_KOKORO_VOICE = "af_heart";
