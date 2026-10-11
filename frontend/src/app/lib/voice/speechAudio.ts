/**
 * Turns a response into one audio file for read-aloud: the text is
 * synthesized in chunks (each engine has a length limit), each chunk is
 * decoded to mono samples at one rate, and the samples are joined, with a
 * short pause between chunks, into a single WAV. One file plays in one
 * audio element, so it can be sought, paused, sped up and kept playing
 * while the page is in the background.
 */

/** The rate every chunk is resampled to; Kokoro and most TTS voices are 24 kHz. */
export const RENDER_SAMPLE_RATE = 24_000;
/** Pause between chunks, in seconds; sentences inside a chunk keep the engine's own. */
const GAP_SECONDS = 0.15;

/**
 * Joins sentences into chunks of at most `maxChars`. A sentence longer than
 * that is cut between words (or, failing that, at `maxChars`).
 */
export function chunkSentences(sentences: string[], maxChars: number): string[] {
    const chunks: string[] = [];
    let current = "";
    const push = (piece: string) => {
        if (!current) current = piece;
        else if (current.length + 1 + piece.length <= maxChars) current += ` ${piece}`;
        else {
            chunks.push(current);
            current = piece;
        }
    };
    for (const sentence of sentences) {
        if (sentence.length <= maxChars) {
            push(sentence);
            continue;
        }
        let rest = sentence;
        while (rest.length > maxChars) {
            const space = rest.lastIndexOf(" ", maxChars);
            const cut = space > 0 ? space : maxChars;
            push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
        }
        push(rest);
    }
    if (current) chunks.push(current);
    return chunks;
}

type OfflineContextConstructor = new (channels: number, length: number, sampleRate: number) => BaseAudioContext;

function offlineContext(sampleRate: number): BaseAudioContext {
    const scope = globalThis as unknown as {
        OfflineAudioContext?: OfflineContextConstructor;
        webkitOfflineAudioContext?: OfflineContextConstructor;
    };
    const Context = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
    if (!Context) throw new Error("This browser cannot decode audio.");
    return new Context(1, 1, sampleRate);
}

/** Mono samples of an audio file, resampled to `sampleRate`. */
export async function decodeToMono(blob: Blob, sampleRate = RENDER_SAMPLE_RATE): Promise<Float32Array> {
    const context = offlineContext(sampleRate);
    const bytes = await blob.arrayBuffer();
    // Older Safari only calls back; newer browsers may only settle the
    // promise. Either settles this one (a second settle is ignored).
    const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        const pending = context.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
        pending?.then(resolve, reject);
    });
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return mono;
}

/** 16-bit mono PCM WAV of the pieces in order, `gapSamples` of silence between them. */
export function encodeWav(pieces: Float32Array[], sampleRate = RENDER_SAMPLE_RATE, gapSamples = 0): Blob {
    const samples = pieces.reduce((sum, piece) => sum + piece.length, 0) + gapSamples * Math.max(pieces.length - 1, 0);
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // bytes per second
    view.setUint16(32, 2, true); // bytes per frame
    view.setUint16(34, 16, true); // bits per sample
    text(36, "data");
    view.setUint32(40, samples * 2, true);
    let offset = 44;
    pieces.forEach((piece, index) => {
        if (index > 0) offset += gapSamples * 2; // already zero
        for (let i = 0; i < piece.length; i++, offset += 2) {
            const sample = Math.max(-1, Math.min(1, piece[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }
    });
    return new Blob([view.buffer], { type: "audio/wav" });
}

/** A tenth of a second of silence: played inside a tap so iOS lets the element play later. */
export function silentWav(): Blob {
    return encodeWav([new Float32Array(RENDER_SAMPLE_RATE / 10)]);
}

/** Thrown by renderSpeech when `cancelled()` turned true while it ran. */
export class SpeechRenderCancelled extends Error {
    constructor() {
        super("Read-aloud was stopped.");
    }
}

export interface RenderSpeechOptions {
    /** Chunks synthesized at once. */
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    /** Checked before each chunk starts and at the end. */
    cancelled?: () => boolean;
}

/** Synthesizes every chunk and returns them as one WAV, in order. */
export async function renderSpeech(
    chunks: string[],
    synthesize: (text: string) => Promise<Blob>,
    options: RenderSpeechOptions = {},
): Promise<Blob> {
    const { concurrency = 1, onProgress, cancelled = () => false } = options;
    const pieces: Float32Array[] = new Array(chunks.length);
    let next = 0;
    let done = 0;
    let failed = false;
    const worker = async () => {
        while (next < chunks.length && !failed) {
            if (cancelled()) throw new SpeechRenderCancelled();
            const index = next++;
            try {
                pieces[index] = await decodeToMono(await synthesize(chunks[index]));
            } catch (error) {
                failed = true;
                throw error;
            }
            done += 1;
            onProgress?.(done, chunks.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, worker));
    if (cancelled()) throw new SpeechRenderCancelled();
    return encodeWav(pieces, RENDER_SAMPLE_RATE, Math.round(GAP_SECONDS * RENDER_SAMPLE_RATE));
}
