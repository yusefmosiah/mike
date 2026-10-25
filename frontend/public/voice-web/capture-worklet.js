// Voice mode's microphone capture in the browser (docs/voice-web.md, "Audio
// pipeline"). Runs in the AudioWorklet: mixes the microphone to mono,
// low-passes and resamples it from the context's rate to 16 kHz, and posts
// 512-sample frames (32 ms, what Silero v5 takes) to the voice worker over the
// MessagePort it is handed, transferring each frame's buffer. Plain script, no
// imports: it is loaded by URL with audioWorklet.addModule.
// Tested by src/app/lib/voice/web/captureWorklet.test.ts.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 512;

/** One RBJ low-pass biquad section (direct form I). */
class Biquad {
    constructor(rate, cutoff, q) {
        const w = (2 * Math.PI * cutoff) / rate;
        const alpha = Math.sin(w) / (2 * q);
        const cos = Math.cos(w);
        const a0 = 1 + alpha;
        this.b0 = (1 - cos) / 2 / a0;
        this.b1 = (1 - cos) / a0;
        this.b2 = (1 - cos) / 2 / a0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }

    run(x) {
        const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1;
        this.x1 = x;
        this.y2 = this.y1;
        this.y1 = y;
        return y;
    }
}

/**
 * Streaming resampler: two low-pass sections at 7 kHz (a 4th-order filter
 * under the 8 kHz Nyquist limit of the output) when downsampling, then linear
 * interpolation. Good enough for speech detection and recognition.
 */
class Resampler {
    constructor(inputRate, outputRate = TARGET_RATE) {
        this.ratio = inputRate / outputRate;
        this.filters = inputRate > outputRate ? [new Biquad(inputRate, 7000, 0.5412), new Biquad(inputRate, 7000, 1.3066)] : [];
        // Position of the next output sample in input samples, relative to
        // the start of the next chunk (-1 is the previous chunk's last sample).
        this.position = 0;
        this.last = 0;
    }

    /** The output samples this chunk of input completes. */
    push(input) {
        const n = input.length;
        if (n === 0) return new Float32Array(0);
        let filtered = input;
        if (this.filters.length > 0) {
            filtered = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                let x = input[i];
                for (const filter of this.filters) x = filter.run(x);
                filtered[i] = x;
            }
        }
        if (this.ratio === 1) return Float32Array.from(filtered);
        const out = new Float32Array(Math.ceil((n - this.position) / this.ratio) + 1);
        let count = 0;
        let position = this.position;
        while (position <= n - 1) {
            const index = Math.floor(position);
            const fraction = position - index;
            const a = index < 0 ? this.last : filtered[index];
            const b = index + 1 < n ? filtered[index + 1] : a;
            out[count++] = a + (b - a) * fraction;
            position += this.ratio;
        }
        this.last = filtered[n - 1];
        this.position = position - n;
        return out.subarray(0, count);
    }
}

class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.resampler = new Resampler(sampleRate, TARGET_RATE);
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.fill = 0;
        this.target = null;
        this.stopped = false;
        this.port.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === "connect" && data.port) this.target = data.port;
            if (data.type === "stop") this.stopped = true;
        };
    }

    process(inputs) {
        if (this.stopped) return false;
        const channels = inputs[0];
        if (!channels || channels.length === 0 || !channels[0]) return true;
        const length = channels[0].length;
        let mono = channels[0];
        if (channels.length > 1) {
            mono = new Float32Array(length);
            for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
        }
        const samples = this.resampler.push(mono);
        for (let i = 0; i < samples.length; i++) {
            this.frame[this.fill++] = samples[i];
            if (this.fill === FRAME_SAMPLES) {
                const frame = this.frame;
                this.frame = new Float32Array(FRAME_SAMPLES);
                this.fill = 0;
                if (this.target) this.target.postMessage({ type: "frame", samples: frame }, [frame.buffer]);
            }
        }
        return true;
    }
}

registerProcessor("mike-voice-capture", CaptureProcessor);
