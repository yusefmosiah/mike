import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The capture worklet (public/voice-web/capture-worklet.js) is a plain script
 * for the AudioWorklet; here it runs in a VM context with the worklet's
 * globals stubbed.
 */
const SOURCE = readFileSync(join(process.cwd(), "public/voice-web/capture-worklet.js"), "utf8");

interface Port {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (message: unknown) => void;
}
interface Processor {
    port: Port;
    process(inputs: Float32Array[][]): boolean;
}
interface ResamplerLike {
    push(input: Float32Array): Float32Array;
}

function load(rate: number) {
    const registered: Record<string, new () => Processor> = {};
    const context = vm.createContext({
        sampleRate: rate,
        Float32Array,
        Math,
        AudioWorkletProcessor: class {
            port: Port = { onmessage: null, postMessage: () => undefined };
        },
        registerProcessor: (name: string, ctor: new () => Processor) => {
            registered[name] = ctor;
        },
    });
    vm.runInContext(SOURCE, context);
    const Resampler = vm.runInContext("Resampler", context) as new (input: number, output?: number) => ResamplerLike;
    return { Processor: registered["mike-voice-capture"], Resampler };
}

const sine = (frequency: number, rate: number, seconds: number, amplitude = 0.5) =>
    Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));

const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / Math.max(1, samples.length));

/** Feeds `input` in 128-sample render quanta and collects the output. */
function resampleInQuanta(resampler: ResamplerLike, input: Float32Array): Float32Array {
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...resampler.push(input.subarray(i, i + 128)));
    return Float32Array.from(parts);
}

function zeroCrossings(samples: Float32Array): number {
    let count = 0;
    for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) count++;
    return count;
}

describe("capture worklet resampler", () => {
    for (const rate of [48_000, 44_100, 24_000]) {
        it(`turns ${rate} Hz into 16 kHz, keeping speech frequencies`, () => {
            const { Resampler } = load(rate);
            const out = resampleInQuanta(new Resampler(rate), sine(440, rate, 1));
            expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(2);
            // 440 Hz: 880 zero crossings a second.
            expect(Math.abs(zeroCrossings(out.subarray(1600)) - 880 * 0.9)).toBeLessThanOrEqual(4);
            expect(rms(out.subarray(1600))).toBeGreaterThan(0.3);
        });
    }

    it("attenuates what would alias above 8 kHz", () => {
        const { Resampler } = load(48_000);
        const out = resampleInQuanta(new Resampler(48_000), sine(12_000, 48_000, 0.5));
        expect(rms(out.subarray(800))).toBeLessThan(0.05);
    });

    it("passes 16 kHz through unchanged", () => {
        const { Resampler } = load(16_000);
        const input = sine(300, 16_000, 0.1);
        expect(Array.from(resampleInQuanta(new Resampler(16_000), input))).toEqual(Array.from(input));
    });

    it("gives the same output however the input is split", () => {
        const { Resampler } = load(44_100);
        const input = sine(1000, 44_100, 0.2);
        const whole = new Resampler(44_100).push(input);
        const pieces = new Resampler(44_100);
        const split = [...pieces.push(input.subarray(0, 1000)), ...pieces.push(input.subarray(1000, 1001)), ...pieces.push(input.subarray(1001))];
        expect(split.length).toBe(whole.length);
        split.forEach((value, i) => expect(value).toBeCloseTo(whole[i], 6));
    });
});

describe("capture worklet processor", () => {
    it("posts 512-sample frames to the port it is connected to, until stopped", () => {
        const { Processor } = load(48_000);
        const processor = new Processor();
        const frames: Float32Array[] = [];
        const target = { postMessage: (message: { samples: Float32Array }) => frames.push(message.samples) };
        // Not connected yet: nothing is posted.
        expect(processor.process([[new Float32Array(128)]])).toBe(true);
        processor.port.onmessage?.({ data: { type: "connect", port: target } });
        const input = sine(440, 48_000, 0.5);
        for (let i = 0; i < input.length; i += 128) processor.process([[input.subarray(i, i + 128), input.subarray(i, i + 128)]]);
        // 0.5 s at 16 kHz is 8000 samples: 15 whole frames.
        expect(frames.length).toBe(15);
        expect(frames.every((frame) => frame.length === 512)).toBe(true);
        expect(processor.process([[]])).toBe(true);
        processor.port.onmessage?.({ data: { type: "stop" } });
        expect(processor.process([[new Float32Array(128)]])).toBe(false);
    });
});
