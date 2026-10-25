import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceEvent } from "../voiceEngine";
import type { VoiceCapabilities } from "./capabilities";
import type { AudioLike } from "./player";
import { FRAME_MS } from "./vadCore";
import { PAD_AFTER_MS, PAD_BEFORE_MS, WebVoiceBackend, cleanTranscript, policyConfig, type VoiceTestSeam } from "./webBackend";

const CAPS: VoiceCapabilities = {
    basics: true,
    webgpu: "usable",
    webkit: false,
    appleMobile: false,
    lowMemory: false,
    priorCrash: false,
    onDeviceRecognition: false,
    systemVoices: true,
};

class FakeAudio implements AudioLike {
    src = "";
    volume = 1;
    preload = "";
    currentTime = 0;
    duration = 2;
    private listeners = new Map<string, Set<() => void>>();
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    load = vi.fn();
    removeAttribute() {
        this.src = "";
    }
    addEventListener(type: string, listener: () => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
    }
    fire(type: string) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    }
}

/** A listening worker that answers `init` and hands back silence of the asked length for `audio`. */
class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    messages: Record<string, unknown>[] = [];
    terminated = false;
    postMessage(message: Record<string, unknown>) {
        this.messages.push(message);
        if (message.type === "init") queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
        if (message.type === "audio") {
            const samples = new Float32Array(Math.round((((message.toMs as number) - (message.fromMs as number)) * 16_000) / 1000));
            queueMicrotask(() => this.onmessage?.({ data: { type: "audio", id: message.id, samples } }));
        }
    }
    terminate() {
        this.terminated = true;
    }
    frame(index: number, probability: number) {
        this.onmessage?.({ data: { type: "vad", index, probability } });
    }
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function setup(seam: VoiceTestSeam = {}, caps: Partial<VoiceCapabilities> = {}) {
    (window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest = {
        vad: "energy",
        speak: "silent",
        models: "installed",
        transcribe: () => "what does clause four say",
        ...seam,
    };
    const events: VoiceEvent[] = [];
    const worker = new FakeWorker();
    const audios: FakeAudio[] = [];
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    const context = {
        state: "running",
        resume: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        destination: {},
        audioWorklet: { addModule: vi.fn(async () => undefined) },
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    };
    const node = { port: { postMessage: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
    const getUserMedia = vi.fn(async () => stream);
    const backend = new WebVoiceBackend((event) => events.push(event), {
        probe: async () => ({ ...CAPS, ...caps }),
        getUserMedia,
        createWorker: () => worker as unknown as Worker,
        createAudioContext: () => context as unknown as AudioContext,
        createWorkletNode: () => node as unknown as AudioWorkletNode,
        createAudio: () => {
            const audio = new FakeAudio();
            audios.push(audio);
            return audio;
        },
        now: () => 0,
    });
    let frame = 0;
    const frames = (probability: number, count: number) => {
        for (let i = 0; i < count; i++) worker.frame(frame++, probability);
    };
    return { backend, events, worker, audios, track, context, node, getUserMedia, frames };
}

const types = (events: VoiceEvent[]) => events.map((event) => (event.type === "state" ? `state:${event.state}` : event.type));

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:clause");
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    delete (window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest;
    window.localStorage.clear();
});

describe("WebVoiceBackend status and setup", () => {
    it("reports the plan's sentence and that nothing is missing", async () => {
        const { backend } = setup();
        const status = await backend.status();
        expect(status.available).toBe(true);
        expect(status.missing).toEqual([]);
        expect(status.sentence).toMatch(/graphics processor/);
    });

    it("lists the downloads as minutes, and the install is the consent", async () => {
        const { backend, events } = setup({ models: "missing" });
        const status = await backend.status();
        expect(status).toMatchObject({ available: false, missing: ["vad"] });
        expect(status.downloadMinutes).toBeGreaterThanOrEqual(1);
        expect(await backend.install()).toBe(true);
        expect(events).toEqual([{ type: "install", fraction: 1 }]);
        expect((await backend.status()).available).toBe(true);
    });

    it("says why voice mode cannot run, without the speech server allowed", async () => {
        const { backend } = setup({}, { appleMobile: true });
        const status = await backend.status();
        expect(status.available).toBe(false);
        expect(status.missing).toEqual([]);
        expect(status.unavailableMessage).toMatch(/speech server/);
    });
});

describe("WebVoiceBackend conversation", () => {
    it("emits the contract's events for a turn and its spoken answer", async () => {
        const { backend, events, worker, audios, frames } = setup();
        await backend.start({});
        expect(types(events)).toEqual(["state:listening"]);
        expect(worker.messages[0]).toMatchObject({ type: "init", mode: "energy" });

        // 640 ms of speech, then the 900 ms silence rule.
        frames(0.9, 20);
        frames(0.05, 29);
        await flush();
        expect(types(events)).toEqual(["state:listening", "state:user-speaking", "state:confirming-end", "turn", "state:thinking", "metrics"]);
        const turn = events.find((event) => event.type === "turn")!;
        expect(turn).toMatchObject({ type: "turn", text: "what does clause four say", audioMs: 20 * FRAME_MS });
        // The audio asked for is the turn padded on both sides.
        expect(worker.messages.find((message) => message.type === "audio")).toMatchObject({
            fromMs: 0,
            toMs: 20 * FRAME_MS + PAD_AFTER_MS,
        });
        const turnId = (turn as { turnId: string }).turnId;

        events.length = 0;
        backend.speak(turnId, 0, "Clause four says the rent is due.", false);
        backend.endAnswer(turnId);
        await flush();
        expect(types(events)).toEqual(["clauseStarted", "state:speaking"]);

        // Half-duplex: speech heard while the answer plays is ignored.
        frames(0.9, 30);
        expect(types(events)).toEqual(["clauseStarted", "state:speaking"]);

        audios.find((audio) => audio.play.mock.calls.length > 0)!.fire("ended");
        await flush();
        expect(types(events)).toEqual(["clauseStarted", "state:speaking", "clausePlayed", "answerFinished", "state:listening"]);

        // Listening resumes a moment after playback, not at once.
        events.length = 0;
        frames(0.9, 5);
        expect(types(events)).toEqual([]);
        frames(0.9, 10);
        expect(types(events)).toEqual(["state:user-speaking"]);
    });

    it("reports how much of the clause was heard when the answer is cancelled", async () => {
        const { backend, events, audios, frames } = setup();
        await backend.start({});
        frames(0.9, 20);
        frames(0.05, 29);
        await flush();
        const turnId = (events.find((event) => event.type === "turn") as { turnId: string }).turnId;
        backend.speak(turnId, 0, "Clause four says the rent is due.", false);
        await flush();
        const playing = audios.find((audio) => audio.play.mock.calls.length > 0)!;
        playing.currentTime = 0.5;
        events.length = 0;
        await backend.cancelAnswer(turnId);
        expect(events).toEqual([
            { type: "interrupted", turnId, clauseId: 0, fraction: 0.25 },
            { type: "state", state: "listening" },
        ]);
    });

    it("drops a turn with no words and goes back to listening", async () => {
        const { backend, events, frames } = setup({ transcribe: () => " [BLANK_AUDIO] " });
        await backend.start({});
        frames(0.9, 20);
        frames(0.05, 29);
        await flush();
        expect(types(events)).toEqual(["state:listening", "state:user-speaking", "state:confirming-end", "state:listening"]);
    });

    it("barges in on speech while the answer is awaited, and continues the turn", async () => {
        const { backend, events, frames } = setup();
        await backend.start({});
        frames(0.9, 20);
        frames(0.05, 29);
        await flush();
        const first = (events.find((event) => event.type === "turn") as { turnId: string }).turnId;
        events.length = 0;
        frames(0.9, 23);
        expect(events).toEqual([
            { type: "bargeIn", turnId: first },
            { type: "state", state: "user-speaking" },
        ]);
        frames(0.05, 29);
        await flush();
        expect(events.find((event) => event.type === "turn")).toMatchObject({ continues: first });
    });

    it("maps a refused microphone to permission-denied and releases nothing it did not take", async () => {
        const { backend, getUserMedia, context } = setup();
        getUserMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
        await expect(backend.start({})).rejects.toMatchObject({ code: "permission-denied" });
        expect(context.close).toHaveBeenCalled();
        getUserMedia.mockRejectedValueOnce(Object.assign(new Error("none"), { name: "NotFoundError" }));
        await expect(backend.start({})).rejects.toMatchObject({ code: "no-microphone" });
    });

    it("refuses to start where voice mode cannot run", async () => {
        const { backend } = setup({}, { appleMobile: true });
        await expect(backend.start({})).rejects.toMatchObject({ code: "unavailable" });
        const missing = setup({ models: "missing" });
        await expect(missing.backend.start({})).rejects.toMatchObject({ code: "unavailable" });
    });

    it("stops: releases the microphone, the worker and the audio, and ignores late frames", async () => {
        const { backend, events, worker, track, context, frames } = setup();
        await backend.start({});
        await backend.stop();
        expect(track.stop).toHaveBeenCalled();
        expect(worker.terminated).toBe(true);
        expect(context.close).toHaveBeenCalled();
        events.length = 0;
        frames(0.9, 30);
        expect(events).toEqual([]);
        await expect(backend.remove()).resolves.toMatchObject({ available: true });
    });

    it("is busy for removal while it runs, and ends with a reason when the microphone goes", async () => {
        const { backend, events, track } = setup();
        await backend.start({});
        await expect(backend.remove()).rejects.toMatchObject({ code: "busy" });
        const ended = (track.addEventListener.mock.calls as unknown as [string, () => void][]).find(([type]) => type === "ended")![1];
        ended();
        expect(events.at(-1)).toEqual({ type: "ended", reason: "route" });
    });
});

describe("policyConfig and cleanTranscript", () => {
    it("takes the contract's thresholds the web policy shares, and the hold as the wordless barge-in", () => {
        expect(
            policyConfig({ vadThreshold: 0.6, maxTurnMs: 200_000, holdSpeechMs: 500, fallbackSilenceMs: 700, speakerModel: "both", pauseMs: "x" }),
        ).toEqual({ vadThreshold: 0.6, maxTurnMs: undefined, bargeInSpeechMs: 500, fallbackSilenceMs: 700 });
    });

    it("drops Whisper's non-speech markers", () => {
        expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
        expect(cleanTranscript("(music) Hello  there *coughs*")).toBe("Hello there");
    });

    it("pads the turn's audio", () => {
        expect(PAD_BEFORE_MS).toBeGreaterThan(0);
    });
});
