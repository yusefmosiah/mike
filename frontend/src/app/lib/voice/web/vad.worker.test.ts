import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_SAMPLES } from "./vadCore";

type Handler = (event: { data: unknown }) => void;
interface FakePort {
    onmessage: Handler | null;
    close: ReturnType<typeof vi.fn>;
}

const ORT_URL = "/voice-web/ort/fake-ort.mjs";
const scope = self as unknown as { onmessage: Handler | null; postMessage: unknown; close: unknown };
const originals = { postMessage: scope.postMessage, close: scope.close, onmessage: scope.onmessage };

let posted: { message: { type: string; [key: string]: unknown }; transfer?: Transferable[] }[];
let closeSelf: ReturnType<typeof vi.fn>;
let created: unknown[];

const fakeOrt = (create: () => Promise<unknown>) => ({
    env: { wasm: {} as Record<string, unknown> },
    Tensor: class {
        constructor(
            readonly type: string,
            readonly data: unknown,
            readonly dims: number[],
        ) {}
    },
    InferenceSession: {
        create: vi.fn(async (...args: unknown[]) => {
            created.push(args);
            return create();
        }),
    },
});

async function load() {
    vi.resetModules();
    await import("./vad.worker");
    return scope.onmessage as Handler;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const port = (): FakePort => ({ onmessage: null, close: vi.fn() });
const waitFor = async (type: string, nth = 0) => {
    for (let i = 0; i < 50 && posted.filter((p) => p.message.type === type).length <= nth; i++) await flush();
    return posted.filter((p) => p.message.type === type)[nth];
};

beforeEach(() => {
    posted = [];
    created = [];
    closeSelf = vi.fn();
    scope.postMessage = (message: never, transfer?: Transferable[]) => posted.push({ message, transfer });
    scope.close = closeSelf;
});

afterEach(() => {
    scope.postMessage = originals.postMessage;
    scope.close = originals.close;
    scope.onmessage = originals.onmessage;
    vi.doUnmock(ORT_URL);
});

describe("vad worker", () => {
    it("starts an energy detector, posts ready, and answers frames with probabilities", async () => {
        const onmessage = await load();
        const p = port();
        onmessage({ data: { type: "init", port: p, mode: "energy" } });
        await waitFor("ready");

        const loud = new Float32Array(FRAME_SAMPLES).fill(0.1);
        p.onmessage?.({ data: { type: "frame", samples: loud } });
        const vad = await waitFor("vad");
        expect(vad.message).toEqual({ type: "vad", index: 0, probability: 0.9 });

        // Ignored: wrong type, no samples, no data at all.
        p.onmessage?.({ data: { type: "other", samples: loud } });
        p.onmessage?.({ data: { type: "frame" } });
        p.onmessage?.({ data: undefined });
        await flush();
        expect(posted.filter((x) => x.message.type === "vad")).toHaveLength(1);

        onmessage({ data: { type: "audio", id: 7, fromMs: 0, toMs: 1000 } });
        const audio = (await waitFor("audio")).message as unknown as { id: number; samples: Float32Array };
        expect(audio.id).toBe(7);
        expect(audio.samples.length).toBe(FRAME_SAMPLES);
    });

    it("returns empty audio before init and ignores frames once stopped", async () => {
        const onmessage = await load();
        onmessage({ data: { type: "audio", id: 1, fromMs: 0, toMs: 10 } });
        const audio = (await waitFor("audio")).message as unknown as { samples: Float32Array };
        expect(audio.samples.length).toBe(0);

        const p = port();
        onmessage({ data: { type: "init", port: p, mode: "energy" } });
        await waitFor("ready");
        const handler = p.onmessage;
        onmessage({ data: { type: "stop" } });
        expect(p.close).toHaveBeenCalled();
        expect(closeSelf).toHaveBeenCalled();
        handler?.({ data: { type: "frame", samples: new Float32Array(FRAME_SAMPLES) } });
        await flush();
        expect(posted.some((x) => x.message.type === "vad")).toBe(false);

        // Stop with nothing running still closes the worker.
        onmessage({ data: { type: "stop" } });
        expect(closeSelf).toHaveBeenCalledTimes(2);
    });

    it("loads ONNX Runtime by URL for silero and runs the model", async () => {
        const ort = fakeOrt(async () => ({
            run: async () => ({ output: { data: Float32Array.of(0.6) }, stateN: { data: new Float32Array(256) } }),
        }));
        vi.doMock(ORT_URL, () => ort);
        const onmessage = await load();
        const p = port();
        onmessage({ data: { type: "init", port: p, mode: "silero", model: new ArrayBuffer(8), ortUrl: ORT_URL } });
        await waitFor("ready");
        expect(ort.env.wasm.numThreads).toBe(1);
        expect(ort.env.wasm.proxy).toBe(false);
        expect(String(ort.env.wasm.wasmPaths)).toMatch(/\/voice-web\/ort\/$/);
        expect(created).toHaveLength(1);

        p.onmessage?.({ data: { type: "frame", samples: new Float32Array(FRAME_SAMPLES) } });
        const vad = await waitFor("vad");
        expect(vad.message.probability).toBeCloseTo(0.6);
    });

    it("posts failed when silero lacks a model or url, or the runtime throws", async () => {
        const onmessage = await load();
        onmessage({ data: { type: "init", port: port(), mode: "silero", ortUrl: ORT_URL } });
        await waitFor("failed");
        onmessage({ data: { type: "init", port: port(), mode: "silero", model: new ArrayBuffer(1) } });
        await waitFor("failed", 1);

        vi.doMock(ORT_URL, () => fakeOrt(async () => Promise.reject(new Error("bad model"))));
        const again = await load();
        again({ data: { type: "init", port: port(), mode: "silero", model: new ArrayBuffer(1), ortUrl: ORT_URL } });
        await waitFor("failed", 2);
        expect(posted.some((x) => x.message.type === "ready")).toBe(false);
    });
});
