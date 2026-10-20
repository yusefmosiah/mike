/**
 * Phonon 31m (Gradium; Apache-2.0) in this browser, through the `phonon-tts`
 * package. The package runs the model in its own worker, so unlike Whisper and
 * Kokoro it is driven from the page and not from browserModels.worker.ts.
 *
 * `device: "auto"` generates on WebGPU where the browser hands out a hardware
 * adapter (q8 weights, 64.5 MB) and on the CPU otherwise. Without cross-origin
 * isolation the CPU build runs on one thread; the app does not serve the
 * isolation headers, which would break its cross-origin loads. The package
 * keeps the downloaded files in the Cache API. Nothing is served by Mike.
 */

import {
    DEFAULT_PHONON_VOICE,
    PHONON_REPO,
    PHONON_REVISION,
    PHONON_VOICES,
    phononVoiceUrl,
    type PhononVoice,
    type SetupProgress,
} from "./browserModels.spec";

/**
 * Where the package is served from: frontend/scripts/copy-phonon-tts.mjs
 * copies it into public/phonon-tts/ when the app is built. It is imported by
 * URL, not bundled (Turbopack never finished compiling it; see that script),
 * so its worker and WebAssembly files resolve beside it, as they do in its
 * own README.
 */
export const PHONON_PACKAGE_URL = "/phonon-tts/index.js";

/** The parts of `PhononTTS` this module uses. */
interface Phonon {
    readonly device: string;
    readonly voices: string[];
    addVoice(name: string, source: string): Promise<void>;
    synthWav(text: string, options?: { voice?: string }): Promise<Blob>;
    dispose(): void;
}

let instance: Promise<Phonon> | null = null;
/** The voice URLs being fetched, so two sentences do not fetch one voice twice. */
const voiceLoads = new Map<string, Promise<void>>();

/** Folds the package's per-file progress into one fraction of the bytes known so far. */
function progressReporter(onProgress?: SetupProgress) {
    const files = new Map<string, { loaded: number; total: number }>();
    return (event: { file: string; loaded: number; total: number | null }) => {
        if (!onProgress) return;
        files.set(event.file, { loaded: event.loaded, total: event.total ?? 0 });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
            // A file whose size is not known yet is left out of both sums.
            if (file.total <= 0) continue;
            loaded += file.loaded;
            total += file.total;
        }
        if (total > 0) onProgress(Math.min(1, loaded / total));
    };
}

function phononInstance(onProgress?: SetupProgress): Promise<Phonon> {
    instance ??= (async () => {
        const { PhononTTS } = (await import(
            /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ PHONON_PACKAGE_URL
        )) as typeof import("phonon-tts");
        return (await PhononTTS.load({
            lang: "en",
            model: `hf://${PHONON_REPO}@${PHONON_REVISION}`,
            quant: "q8",
            device: "auto",
            onProgress: progressReporter(onProgress),
        })) as Phonon;
    })().catch((error: unknown) => {
        instance = null;
        throw error;
    });
    return instance;
}

const voiceNamed = (name: string | undefined): PhononVoice =>
    PHONON_VOICES.find((voice) => voice.id === name) ?? PHONON_VOICES.find((voice) => voice.id === DEFAULT_PHONON_VOICE)!;

/** Downloads (first time) and loads Phonon, with its first voice. */
export async function loadPhonon(onProgress?: SetupProgress): Promise<void> {
    await ensureVoice(await phononInstance(onProgress), voiceNamed(undefined));
}

async function ensureVoice(tts: Phonon, voice: PhononVoice): Promise<void> {
    if (tts.voices.includes(voice.id)) return;
    let load = voiceLoads.get(voice.id);
    if (!load) {
        load = tts.addVoice(voice.id, phononVoiceUrl(voice)).finally(() => voiceLoads.delete(voice.id));
        voiceLoads.set(voice.id, load);
    }
    await load;
}

/**
 * A WAV blob of `text`. A voice outside the curated list (an Apple voice
 * chosen earlier, say) is ignored: the default voice speaks.
 */
export async function speakWithPhonon(text: string, voice?: string): Promise<Blob> {
    const tts = await phononInstance();
    const chosen = voiceNamed(voice);
    await ensureVoice(tts, chosen);
    return tts.synthWav(text, { voice: chosen.id });
}

/** Where the loaded model generates ("webgpu" or "cpu"), once it is loaded. */
export async function phononDevice(): Promise<string | null> {
    return instance ? (await instance.catch(() => null))?.device ?? null : null;
}

/** Frees the model (and its worker); the next use loads it again. */
export async function releasePhonon(): Promise<void> {
    const held = instance;
    instance = null;
    voiceLoads.clear();
    if (held) (await held.catch(() => null))?.dispose();
}
