/**
 * What the open models are, shared by the page (browserModels.ts) and the
 * engine in its worker (browserModels.engine.ts). Kept apart so the worker's
 * bundle does not import the page module that starts the worker.
 */

/**
 * "speech" is Kokoro, "phonon" is Phonon 31m: the two read-aloud models of the
 * "webgpu" engine, chosen with the speech preference's `model`.
 */
export type BrowserModelKind = "transcription" | "speech" | "phonon";

/** The read-aloud models of the in-browser engine, as stored in the speech preference's `model`. */
export type BrowserSpeechModel = "kokoro" | "phonon";
export const BROWSER_SPEECH_MODELS: readonly BrowserSpeechModel[] = ["kokoro", "phonon"];

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
    /** The repository commit or branch the files come from. */
    revision: string;
    /** The directory of the repository holding the weight files ("" for its root). */
    weightsDir: string;
    /** The weights of each ONNX session in the model, by runtime. */
    dtypes: (runtime: BrowserModelRuntime) => Record<string, Dtype>;
    /** Files fetched whatever the runtime, as "path" (Phonon: not ONNX sessions). */
    fixedFiles?: readonly string[];
    /** A size to tell the person before the download, where the spec knows it. */
    downloadSize?: string;
}

/** Phonon 31m (Gradium, Apache-2.0), pinned to a commit. */
export const PHONON_REPO = "gradium/phonon-31m-en";
export const PHONON_REVISION = "52433c46975bfa13144c56204c9f4ee1c5b148aa";
/** The model card, which the credit line links. */
export const PHONON_MODEL_CARD_URL = `https://huggingface.co/${PHONON_REPO}`;
/** The voice catalogue (Apache-2.0), pinned to a commit. */
const PHONON_VOICES_REVISION = "0ee17205f254b5abc43b266c8a0f215565c352f7";

export interface PhononVoice {
    /** The voice's name in the catalogue (voices.jsonl), which `PhononTTS` and the phone's bundle call it. */
    id: string;
    label: string;
    detail: string;
    /** The file in gradium/phonon-voices at the pinned commit. */
    file: string;
}

const phononVoice = (id: string, detail: string, file: string): PhononVoice => ({ id, label: id, detail, file });

/**
 * The English voices Settings offers, out of the catalogue's 25 (provisional:
 * picked from voices.jsonl for balance, 4 female and 4 male across American
 * and British, and to be adjusted after listening). The iPhone's model
 * download holds the same eight, plus its default voice.
 */
export const PHONON_VOICES: readonly PhononVoice[] = [
    phononVoice("Harper", "American · female · modern, confident", "4SZHfMpw-p46Ywgs"),
    phononVoice("Hadley", "American · female · even-toned, kind", "bXwrkHhURL1VFJdG"),
    phononVoice("Miles", "American · male · resonant, decisive", "d9XCyhjo4JhkHF1d"),
    phononVoice("Preston", "American · male · trim, focused", "qIxlZ7Ei8KvWlyQH"),
    phononVoice("Maeve", "British · female · attentive, to the point", "6PWnV0Nq4wu7RVBT"),
    phononVoice("Bryony", "British · female · full, relaxed", "gfP44RlHwr2kEwk7"),
    phononVoice("Edwin", "British · male · efficient, firm", "zUCxzrOrugTSis03"),
    phononVoice("Hugh", "British · male · soft, sincere", "YyKcxPG7iIgS3jsK"),
];
export const DEFAULT_PHONON_VOICE = "Harper";

export const phononVoiceUrl = (voice: PhononVoice) =>
    `https://huggingface.co/gradium/phonon-voices/resolve/${PHONON_VOICES_REVISION}/voices/${voice.file}.safetensors`;

export const isPhononVoice = (id: string | undefined): id is string => PHONON_VOICES.some((voice) => voice.id === id);

export const BROWSER_MODELS: Record<BrowserModelKind, BrowserModelSpec> = {
    transcription: {
        id: "whisper-base",
        label: "Whisper Base",
        repo: "onnx-community/whisper-base",
        revision: "main",
        weightsDir: "onnx",
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
        revision: "main",
        weightsDir: "onnx",
        // 326 MB in fp32 on WebGPU, 92 MB in q8 on WebAssembly.
        dtypes: (runtime) => ({ model: runtime.device === "webgpu" ? "fp32" : "q8" }),
    },
    phonon: {
        id: "phonon-31m",
        label: "Phonon 31M",
        repo: PHONON_REPO,
        revision: PHONON_REVISION,
        weightsDir: "",
        // q8 weights (64.5 MB) on the GPU and the CPU alike.
        dtypes: () => ({}),
        downloadSize: "about 65 MB",
        fixedFiles: ["model.q8.gguf", "config.json", "tokenizer.json", "default-voice.safetensors"],
    },
};

export type SetupProgress = (fraction: number) => void;

export const DEFAULT_KOKORO_VOICE = "af_heart";
