import { describe, expect, it, vi } from "vitest";
import { EnergyDetector, RingBuffer, SileroDetector, VadCore, type OrtLike } from "./vadCore";

const ramp = (from: number, count: number) => Float32Array.from({ length: count }, (_, i) => from + i);

describe("RingBuffer", () => {
    it("reads back what it holds, by index since the start, across the wrap", () => {
        const ring = new RingBuffer(10);
        ring.write(ramp(0, 6));
        expect(Array.from(ring.read(2, 5))).toEqual([2, 3, 4]);
        ring.write(ramp(6, 7)); // 13 written; holds 3..12
        expect(ring.total).toBe(13);
        expect(Array.from(ring.read(0, 13))).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect(Array.from(ring.read(8, 20))).toEqual([8, 9, 10, 11, 12]);
        expect(ring.read(15, 20).length).toBe(0);
    });

    it("keeps the newest samples of a write longer than itself", () => {
        const ring = new RingBuffer(4);
        ring.write(ramp(0, 3));
        ring.write(ramp(3, 9)); // 12 written; holds 8..11
        expect(Array.from(ring.read(0, 12))).toEqual([8, 9, 10, 11]);
        ring.write(ramp(12, 1));
        expect(Array.from(ring.read(0, 13))).toEqual([9, 10, 11, 12]);
    });
});

class FakeTensor {
    constructor(
        readonly type: string,
        readonly data: Float32Array | BigInt64Array,
        readonly dims: number[],
    ) {}
}

describe("SileroDetector", () => {
    it("feeds 64 samples of context before each frame and carries the state over", async () => {
        const feeds: Record<string, FakeTensor>[] = [];
        const session = {
            run: vi.fn(async (input: Record<string, unknown>) => {
                feeds.push(input as Record<string, FakeTensor>);
                return {
                    output: { data: Float32Array.of(0.8) },
                    stateN: { data: new Float32Array(256).fill(feeds.length) },
                };
            }),
        };
        const detector = new SileroDetector({ Tensor: FakeTensor } as unknown as OrtLike, session);
        expect(await detector.probability(ramp(0, 512))).toBeCloseTo(0.8);
        await detector.probability(ramp(1000, 512));
        const [first, second] = feeds;
        expect(first.input.dims).toEqual([1, 576]);
        expect(Array.from((first.input.data as Float32Array).slice(0, 64))).toEqual(new Array(64).fill(0));
        expect(Array.from((second.input.data as Float32Array).slice(0, 64))).toEqual(Array.from(ramp(448, 64)));
        expect(second.input.data[64]).toBe(1000);
        expect(first.state.dims).toEqual([2, 1, 128]);
        expect(second.state.data[0]).toBe(1);
        expect(first.sr.data[0]).toBe(BigInt(16000));
    });
});

describe("EnergyDetector", () => {
    it("reads loud frames as speech and quiet ones as silence", async () => {
        const detector = new EnergyDetector();
        expect(await detector.probability(new Float32Array(512).fill(0.1))).toBeGreaterThan(0.5);
        expect(await detector.probability(new Float32Array(512).fill(0.015))).toBeLessThan(0.5);
        expect(await detector.probability(new Float32Array(512))).toBeLessThan(0.35);
    });
});

describe("VadCore", () => {
    it("numbers frames in order, keeps their audio, and survives a failing frame", async () => {
        let calls = 0;
        const core = new VadCore(
            {
                probability: async () => {
                    calls += 1;
                    if (calls === 2) throw new Error("boom");
                    return 0.7;
                },
            },
            1,
        );
        const results = await Promise.all([core.push(ramp(0, 512)), core.push(ramp(512, 512)), core.push(ramp(1024, 512))]);
        expect(results).toEqual([
            { index: 0, probability: 0.7 },
            { index: 1, probability: 0 },
            { index: 2, probability: 0.7 },
        ]);
        // 32 ms is 512 samples.
        const audio = core.audio(32, 64);
        expect(audio.length).toBe(512);
        expect(audio[0]).toBe(512);
    });
});
