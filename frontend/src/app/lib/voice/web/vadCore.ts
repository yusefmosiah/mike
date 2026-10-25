/**
 * What the voice worker (vad.worker.ts) does with each microphone frame, kept
 * apart from the worker's messaging so it can be tested: the last couple of
 * minutes of 16 kHz audio in a ring buffer, and a speech probability for
 * every 512-sample frame from Silero v5 (or, for tests through the browser
 * seam, from the frame's loudness).
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 512;
/** Milliseconds of audio per frame (32). */
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

/** The newest `capacity` samples, addressed by their index since the start. */
export class RingBuffer {
    private readonly data: Float32Array;
    private written = 0;

    constructor(readonly capacity: number) {
        this.data = new Float32Array(capacity);
    }

    /** Samples written since the start. */
    get total(): number {
        return this.written;
    }

    write(samples: Float32Array): void {
        let input = samples;
        if (input.length > this.capacity) input = input.subarray(input.length - this.capacity);
        const at = (this.written + samples.length - input.length) % this.capacity;
        const first = Math.min(input.length, this.capacity - at);
        this.data.set(input.subarray(0, first), at);
        if (first < input.length) this.data.set(input.subarray(first), 0);
        this.written += samples.length;
    }

    /** Samples `from..<to`, clamped to what is still held. */
    read(from: number, to: number): Float32Array {
        const start = Math.max(from, this.written - this.capacity, 0);
        const end = Math.min(to, this.written);
        if (end <= start) return new Float32Array(0);
        const out = new Float32Array(end - start);
        const at = start % this.capacity;
        const first = Math.min(out.length, this.capacity - at);
        out.set(this.data.subarray(at, at + first), 0);
        if (first < out.length) out.set(this.data.subarray(0, out.length - first), first);
        return out;
    }
}

/** A speech detector: one probability per 512-sample frame. */
export interface SpeechDetector {
    probability(frame: Float32Array): Promise<number>;
}

/** The parts of onnxruntime-web this module uses. */
export interface OrtLike {
    Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown;
}
export interface OrtSessionLike {
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

/**
 * Silero VAD v5 (MIT) on ONNX Runtime, as its own wrapper drives it: each call
 * gets the last 64 samples of the previous frame in front of the 512 new
 * ones, and the recurrent state carries over.
 */
export class SileroDetector implements SpeechDetector {
    static readonly CONTEXT = 64;
    private state = new Float32Array(2 * 1 * 128);
    private context = new Float32Array(SileroDetector.CONTEXT);
    private readonly rate: unknown;

    constructor(
        private readonly ort: OrtLike,
        private readonly session: OrtSessionLike,
    ) {
        this.rate = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
    }

    async probability(frame: Float32Array): Promise<number> {
        const input = new Float32Array(SileroDetector.CONTEXT + frame.length);
        input.set(this.context, 0);
        input.set(frame, SileroDetector.CONTEXT);
        const result = await this.session.run({
            input: new this.ort.Tensor("float32", input, [1, input.length]),
            state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
            sr: this.rate,
        });
        this.state = Float32Array.from(result.stateN.data as Float32Array);
        this.context = frame.slice(frame.length - SileroDetector.CONTEXT);
        return Number((result.output.data as Float32Array)[0]) || 0;
    }
}

/**
 * Loudness instead of a model, for the browser test seam only (synthetic
 * audio in a test does not sound like speech to Silero).
 */
export class EnergyDetector implements SpeechDetector {
    async probability(frame: Float32Array): Promise<number> {
        let sum = 0;
        for (const x of frame) sum += x * x;
        const rms = Math.sqrt(sum / Math.max(1, frame.length));
        return rms >= 0.02 ? 0.9 : rms >= 0.01 ? 0.4 : 0.05;
    }
}

/** Two minutes and a bit: the longest turn plus one it continues. */
export const RING_SECONDS = 130;

export class VadCore {
    readonly ring: RingBuffer;
    private frames = 0;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly detector: SpeechDetector,
        seconds = RING_SECONDS,
    ) {
        this.ring = new RingBuffer(seconds * SAMPLE_RATE);
    }

    /**
     * Stores the frame and resolves its index and speech probability. Frames
     * are processed one at a time, in order.
     */
    push(frame: Float32Array): Promise<{ index: number; probability: number }> {
        const index = this.frames++;
        this.ring.write(frame);
        const next = this.chain.then(() => this.detector.probability(frame)).then(
            (probability) => ({ index, probability }),
            () => ({ index, probability: 0 }),
        );
        this.chain = next;
        return next;
    }

    /** Audio between two times in ms since the start, as 16 kHz samples. */
    audio(fromMs: number, toMs: number): Float32Array {
        return this.ring.read(Math.floor((fromMs * SAMPLE_RATE) / 1000), Math.ceil((toMs * SAMPLE_RATE) / 1000));
    }
}
