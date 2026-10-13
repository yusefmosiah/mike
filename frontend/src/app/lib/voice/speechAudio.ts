/**
 * Audio for read-aloud: the text is synthesized in chunks (each engine has a
 * length limit, and a short first chunk starts the reading sooner), each
 * chunk is decoded to mono samples at one rate and written as its own WAV
 * segment, ending in a short pause. The segments play one after another in
 * one audio element, so it can be paused, sped up and kept playing while the
 * page is in the background (components/assistant/useReadAloud.ts).

/** The rate every chunk is resampled to; Kokoro and most TTS voices are 24 kHz. */
export const RENDER_SAMPLE_RATE = 24_000;
/** Pause between chunks, in seconds; sentences inside a chunk keep the engine's own. */
const GAP_SECONDS = 0.15;

/**
 * Joins sentences into chunks of at most `maxChars`, the first of at most
 * `firstMaxChars`. A sentence longer than its chunk's limit is cut between
 * words (or, failing that, at the limit).
 */
export function chunkSentences(sentences: string[], maxChars: number, firstMaxChars = maxChars): string[] {
    const chunks: string[] = [];
    let current = "";
    const limit = () => (chunks.length === 0 ? Math.min(firstMaxChars, maxChars) : maxChars);
    const flush = () => {
        if (current) chunks.push(current);
        current = "";
    };
    for (const sentence of sentences) {
        let rest = sentence;
        while (rest) {
            if (current && current.length + 1 + rest.length <= limit()) {
                current += ` ${rest}`;
                break;
            }
            flush();
            const max = limit();
            if (rest.length <= max) {
                current = rest;
                break;
            }
            const space = rest.lastIndexOf(" ", max);
            const cut = space > 0 ? space : max;
            chunks.push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
        }
    }
    flush();
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

/** One segment of a reading: the chunk's samples, then the pause before the next. */
export function segmentWav(samples: Float32Array, sampleRate = RENDER_SAMPLE_RATE): Blob {
    return encodeWav([samples, new Float32Array(Math.round(GAP_SECONDS * sampleRate))], sampleRate);
}

/** Seconds a segment of `samples` plays for, its closing pause included. */
export function segmentSeconds(samples: Float32Array, sampleRate = RENDER_SAMPLE_RATE): number {
    return samples.length / sampleRate + GAP_SECONDS;
}
