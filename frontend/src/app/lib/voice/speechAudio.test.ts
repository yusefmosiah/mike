import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    chunkSentences,
    decodeToMono,
    encodeWav,
    RENDER_SAMPLE_RATE,
    renderSpeech,
    silentWav,
    SpeechRenderCancelled,
} from "./speechAudio";

/** An OfflineAudioContext whose decode returns `channels` of `length` samples, each filled with its channel number + 1 over 10. */
function stubContext({ channels = 1, length = 4, promise = false, fail = false } = {}) {
    const created: number[] = [];
    class Context {
        constructor(_channels: number, _length: number, sampleRate: number) {
            created.push(sampleRate);
        }
        decodeAudioData(_bytes: ArrayBuffer, ok: (buffer: AudioBuffer) => void, bad: (error: unknown) => void) {
            const buffer = {
                numberOfChannels: channels,
                length,
                getChannelData: (channel: number) => new Float32Array(length).fill((channel + 1) / 10),
            } as unknown as AudioBuffer;
            if (promise) return fail ? Promise.reject(new Error("bad audio")) : Promise.resolve(buffer);
            if (fail) bad(new Error("bad audio"));
            else ok(buffer);
            return undefined;
        }
    }
    return { Context, created };
}

async function bytesOf(blob: Blob): Promise<DataView> {
    return new DataView(await blob.arrayBuffer());
}

const ascii = (view: DataView, offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("chunkSentences", () => {
    it("joins sentences up to the limit without splitting one", () => {
        expect(chunkSentences(["One two.", "Three four.", "Five."], 20)).toEqual(["One two. Three four.", "Five."]);
    });

    it("cuts a long sentence between words, or at the limit when there is no space", () => {
        expect(chunkSentences(["alpha beta gamma delta"], 11)).toEqual(["alpha beta", "gamma delta"]);
        expect(chunkSentences(["abcdefghij"], 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    it("returns nothing for no sentences", () => {
        expect(chunkSentences([], 10)).toEqual([]);
    });
});

describe("decodeToMono", () => {
    it("returns a mono file's samples at the render rate", async () => {
        const { Context, created } = stubContext();
        vi.stubGlobal("OfflineAudioContext", Context);
        const samples = await decodeToMono(new Blob(["x"]));
        expect(Array.from(samples)).toEqual([0.1, 0.1, 0.1, 0.1].map(Math.fround));
        expect(created).toEqual([RENDER_SAMPLE_RATE]);
    });

    it("mixes stereo down to mono", async () => {
        vi.stubGlobal("OfflineAudioContext", stubContext({ channels: 2, length: 2 }).Context);
        const samples = await decodeToMono(new Blob(["x"]), 16_000);
        expect(samples[0]).toBeCloseTo(0.15);
    });

    it("uses the prefixed context in older Safari and its promise when it returns one", async () => {
        vi.stubGlobal("OfflineAudioContext", undefined);
        vi.stubGlobal("webkitOfflineAudioContext", stubContext({ promise: true }).Context);
        expect((await decodeToMono(new Blob(["x"]))).length).toBe(4);
    });

    it("rejects audio the browser cannot decode", async () => {
        vi.stubGlobal("OfflineAudioContext", stubContext({ fail: true }).Context);
        await expect(decodeToMono(new Blob(["x"]))).rejects.toThrow("bad audio");
        vi.stubGlobal("OfflineAudioContext", stubContext({ fail: true, promise: true }).Context);
        await expect(decodeToMono(new Blob(["x"]))).rejects.toThrow("bad audio");
    });

    it("explains when the browser has no audio decoding", async () => {
        vi.stubGlobal("OfflineAudioContext", undefined);
        vi.stubGlobal("webkitOfflineAudioContext", undefined);
        await expect(decodeToMono(new Blob(["x"]))).rejects.toThrow("This browser cannot decode audio.");
    });
});

describe("encodeWav", () => {
    it("writes a 16-bit mono PCM header and the samples, clamped, with gaps between pieces", async () => {
        const blob = encodeWav([new Float32Array([0.5, -2]), new Float32Array([2])], 8_000, 3);
        expect(blob.type).toBe("audio/wav");
        const view = await bytesOf(blob);
        const samples = 2 + 3 + 1;
        expect(ascii(view, 0, 4)).toBe("RIFF");
        expect(view.getUint32(4, true)).toBe(36 + samples * 2);
        expect(ascii(view, 8, 8)).toBe("WAVEfmt ");
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8_000);
        expect(view.getUint32(28, true)).toBe(16_000);
        expect(view.getUint16(34, true)).toBe(16);
        expect(ascii(view, 36, 4)).toBe("data");
        expect(view.getUint32(40, true)).toBe(samples * 2);
        const pcm = Array.from({ length: samples }, (_, i) => view.getInt16(44 + i * 2, true));
        expect(pcm).toEqual([Math.trunc(0.5 * 0x7fff), -0x8000, 0, 0, 0, 0x7fff]);
    });

    it("encodes nothing as an empty file with a header", async () => {
        const view = await bytesOf(encodeWav([]));
        expect(view.byteLength).toBe(44);
        expect(view.getUint32(24, true)).toBe(RENDER_SAMPLE_RATE);
    });
});

describe("silentWav", () => {
    it("is a tenth of a second of silence", async () => {
        const view = await bytesOf(silentWav());
        expect(view.getUint32(40, true)).toBe((RENDER_SAMPLE_RATE / 10) * 2);
    });
});

describe("renderSpeech", () => {
    beforeEach(() => {
        vi.stubGlobal("OfflineAudioContext", stubContext({ length: 2 }).Context);
    });

    it("synthesizes every chunk, a few at a time, and joins them in order", async () => {
        const order: string[] = [];
        let running = 0;
        let most = 0;
        const progress: string[] = [];
        const synthesize = vi.fn(async (text: string) => {
            running += 1;
            most = Math.max(most, running);
            await new Promise((resolve) => setTimeout(resolve, text === "a" ? 5 : 1));
            running -= 1;
            order.push(text);
            return new Blob([text]);
        });
        const blob = await renderSpeech(["a", "b", "c"], synthesize, {
            concurrency: 2,
            onProgress: (done, total) => progress.push(`${done}/${total}`),
        });
        expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["a", "b", "c"]);
        expect(most).toBe(2);
        expect(order[0]).not.toBe("a");
        expect(progress).toEqual(["1/3", "2/3", "3/3"]);
        // Three pieces of two samples and two gaps of 0.15 s.
        const view = await bytesOf(blob);
        expect(view.getUint32(40, true)).toBe((3 * 2 + 2 * Math.round(0.15 * RENDER_SAMPLE_RATE)) * 2);
    });

    it("runs one at a time by default and without a progress callback", async () => {
        const synthesize = vi.fn(async (text: string) => new Blob([text]));
        await renderSpeech(["a", "b"], synthesize);
        expect(synthesize).toHaveBeenCalledTimes(2);
    });

    it("stops starting chunks after one fails", async () => {
        const synthesize = vi.fn(async (text: string) => {
            if (text === "a") throw new Error("engine down");
            return new Blob([text]);
        });
        await expect(renderSpeech(["a", "b", "c"], synthesize)).rejects.toThrow("engine down");
        expect(synthesize).toHaveBeenCalledTimes(1);
    });

    it("stops when cancelled, before a chunk or at the end", async () => {
        let cancel = false;
        const synthesize = vi.fn(async (text: string) => {
            cancel = true;
            return new Blob([text]);
        });
        await expect(renderSpeech(["a", "b"], synthesize, { cancelled: () => cancel })).rejects.toBeInstanceOf(
            SpeechRenderCancelled,
        );
        expect(synthesize).toHaveBeenCalledTimes(1);

        cancel = false;
        await expect(renderSpeech(["a"], synthesize, { cancelled: () => cancel })).rejects.toThrow(
            "Read-aloud was stopped.",
        );
    });
});
