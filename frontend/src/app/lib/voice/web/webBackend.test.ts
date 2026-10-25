import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_PREFERENCES_KEY } from "../preferences";
import type { VoiceEvent } from "../voiceEngine";
import type { VoiceCapabilities } from "./capabilities";
import type { AudioLike } from "./player";
import { FRAME_MS } from "./vadCore";
import { PAD_AFTER_MS, PAD_BEFORE_MS, WebVoiceBackend, cleanTranscript, policyConfig, testSeam, type VoiceTestSeam, type WebBackendDeps } from "./webBackend";

const mocks = vi.hoisted(() => ({
    cached: false,
    consent: new Set<string>(),
    primed: null as unknown,
    sileroCached: vi.fn(),
    downloadSilero: vi.fn(),
    loadSilero: vi.fn(),
    removeVoiceModels: vi.fn(),
    requestPersistentStorage: vi.fn(),
    loadBrowserTranscriber: vi.fn(),
    loadBrowserPhonon: vi.fn(),
    transcribeSamplesInBrowser: vi.fn(),
    speakWithBrowserModel: vi.fn(),
    setBrowserModelConsent: vi.fn(),
    previousBrowserModelRunDied: vi.fn(),
    onDeviceRecognitionStatus: vi.fn(),
    browserSpeechSupported: vi.fn(),
    startOnDeviceRecognition: vi.fn(),
    transcribeAudio: vi.fn(),
    synthesizeSpeech: vi.fn(),
    webVoiceSupported: vi.fn(),
}));

vi.mock("./models", async (importActual) => ({
    ...(await importActual<typeof import("./models")>()),
    sileroCached: mocks.sileroCached,
    downloadSilero: mocks.downloadSilero,
    loadSilero: mocks.loadSilero,
    removeVoiceModels: mocks.removeVoiceModels,
    requestPersistentStorage: mocks.requestPersistentStorage,
}));
vi.mock("../browserModels", () => ({
    hasBrowserModelConsent: (kind: string) => mocks.consent.has(kind),
    setBrowserModelConsent: mocks.setBrowserModelConsent,
    loadBrowserTranscriber: mocks.loadBrowserTranscriber,
    loadBrowserPhonon: mocks.loadBrowserPhonon,
    transcribeSamplesInBrowser: mocks.transcribeSamplesInBrowser,
    speakWithBrowserModel: mocks.speakWithBrowserModel,
    previousBrowserModelRunDied: mocks.previousBrowserModelRunDied,
}));
vi.mock("../browserSpeech", () => ({
    onDeviceRecognitionStatus: mocks.onDeviceRecognitionStatus,
    browserSpeechSupported: mocks.browserSpeechSupported,
    startOnDeviceRecognition: mocks.startOnDeviceRecognition,
}));
vi.mock("@/app/lib/mikeApi", () => ({
    transcribeAudio: mocks.transcribeAudio,
    synthesizeSpeech: mocks.synthesizeSpeech,
}));
vi.mock("./prime", () => ({ takePrimedAudio: () => mocks.primed }));
vi.mock("./support", () => ({ webVoiceSupported: mocks.webVoiceSupported }));

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
    reply: "ready" | "failed" | "error" | "none" = "ready";
    postMessage(message: Record<string, unknown>) {
        this.messages.push(message);
        if (message.type === "init") {
            if (this.reply === "ready" || this.reply === "failed") {
                const type = this.reply;
                queueMicrotask(() => this.onmessage?.({ data: { type } }));
            } else if (this.reply === "error") queueMicrotask(() => this.onerror?.());
        }
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

function setup(seam: VoiceTestSeam = {}, caps: Partial<VoiceCapabilities> = {}, extra: WebBackendDeps = {}) {
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
        ...extra,
    });
    let frame = 0;
    const frames = (probability: number, count: number) => {
        for (let i = 0; i < count; i++) worker.frame(frame++, probability);
    };
    return { backend, events, worker, audios, track, context, node, getUserMedia, frames };
}

const types = (events: VoiceEvent[]) => events.map((event) => (event.type === "state" ? `state:${event.state}` : event.type));

beforeEach(() => {
    mocks.cached = false;
    mocks.consent.clear();
    mocks.primed = null;
    for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) (mock as ReturnType<typeof vi.fn>).mockReset();
    mocks.sileroCached.mockImplementation(async () => mocks.cached);
    mocks.downloadSilero.mockImplementation(async (progress?: (f: number) => void) => {
        progress?.(0.5);
        mocks.cached = true;
        return new ArrayBuffer(8);
    });
    mocks.loadSilero.mockResolvedValue(new ArrayBuffer(8));
    mocks.removeVoiceModels.mockResolvedValue(undefined);
    mocks.requestPersistentStorage.mockResolvedValue(undefined);
    mocks.loadBrowserTranscriber.mockImplementation(async (progress?: (f: number) => void) => progress?.(0.5));
    mocks.loadBrowserPhonon.mockImplementation(async (progress?: (f: number) => void) => progress?.(0.5));
    mocks.setBrowserModelConsent.mockImplementation((kind: string) => void mocks.consent.add(kind));
    mocks.previousBrowserModelRunDied.mockReturnValue(false);
    mocks.onDeviceRecognitionStatus.mockResolvedValue("available");
    mocks.browserSpeechSupported.mockReturnValue(true);
    mocks.webVoiceSupported.mockReturnValue(true);
    URL.createObjectURL = vi.fn(() => "blob:clause");
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

const speak = async (h: ReturnType<typeof setup>) => {
    h.frames(0.9, 20);
    h.frames(0.05, 29);
    await flush();
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};
const prefs = (value: unknown) => window.localStorage.setItem(VOICE_PREFERENCES_KEY, JSON.stringify(value));
const speakAfterRecognition = async (h: ReturnType<typeof setup>) => {
    h.frames(0.9, 20);
    await flush();
    h.frames(0.05, 29);
    await flush();
};
const noSeam = { vad: undefined, speak: undefined, transcribe: undefined } as const;
const turnIdOf = (events: VoiceEvent[]) => (events.find((event) => event.type === "turn") as { turnId: string }).turnId;

describe("testSeam", () => {
    it("is null without the seam", () => {
        delete (window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest;
        expect(testSeam()).toBeNull();
    });
});

describe("WebVoiceBackend probing", () => {
    it("probes the browser once, and merges the seam's capabilities", async () => {
        mocks.previousBrowserModelRunDied.mockReturnValue(true);
        const backend = new WebVoiceBackend(() => undefined);
        (window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest = { models: "installed", capabilities: { systemVoices: true } };
        const status = await backend.status();
        expect(status.sentence).toMatch(/on-device speech recognition/);
        expect(mocks.onDeviceRecognitionStatus).toHaveBeenCalledTimes(1);
        await backend.status();
        expect(mocks.onDeviceRecognitionStatus).toHaveBeenCalledTimes(1);
    });

    it("forgets a failed probe and tries again", async () => {
        const probe = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValue(CAPS);
        const backend = new WebVoiceBackend(() => undefined, { probe });
        (window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest = { models: "installed" };
        await expect(backend.status()).rejects.toThrow("no");
        expect((await backend.status()).available).toBe(true);
    });
});

describe("WebVoiceBackend install and status without the seam", () => {
    it("reports the missing downloads and installs them with progress", async () => {
        const { backend, events } = setup({ models: undefined });
        const status = await backend.status();
        expect(status.missing).toEqual(["vad", "whisper", "phonon"]);
        expect(status.available).toBe(false);
        expect(status.downloadMinutes).toBeGreaterThanOrEqual(1);
        expect(await backend.install()).toBe(true);
        expect(mocks.requestPersistentStorage).toHaveBeenCalled();
        expect(mocks.setBrowserModelConsent).toHaveBeenCalledWith("transcription", true);
        expect(mocks.setBrowserModelConsent).toHaveBeenCalledWith("phonon", true);
        expect(events.at(-1)).toEqual({ type: "install", fraction: 1 });
        expect(events.filter((event) => event.type === "install").length).toBeGreaterThan(3);
        const after = await backend.status();
        expect(after).toMatchObject({ available: true, missing: [], downloadBytes: 0 });
        expect(after.downloadMinutes).toBeUndefined();
    });

    it("maps a failed download to failed, and refuses where voice mode cannot run", async () => {
        const { backend } = setup({ models: undefined });
        mocks.downloadSilero.mockRejectedValueOnce(new Error("offline"));
        await expect(backend.install()).rejects.toMatchObject({ code: "failed" });
        const unavailable = setup({ models: undefined }, { appleMobile: true });
        await expect(unavailable.backend.install()).rejects.toMatchObject({ code: "unavailable" });
    });

    it("installs nothing when nothing is missing", async () => {
        mocks.cached = true;
        mocks.consent.add("transcription");
        mocks.consent.add("phonon");
        const { backend } = setup({ models: undefined });
        expect(await backend.install()).toBe(true);
    });

    it("removes the models and forgets the seam's install", async () => {
        const { backend } = setup({ models: "missing" });
        await backend.install();
        const status = await backend.remove();
        expect(mocks.removeVoiceModels).toHaveBeenCalled();
        expect(status.missing).toEqual(["vad"]);
    });
});

describe("WebVoiceBackend start failures", () => {
    it("maps the other microphone errors", async () => {
        const { backend, getUserMedia } = setup();
        for (const [name, code] of [
            ["SecurityError", "permission-denied"],
            ["OverconstrainedError", "no-microphone"],
            ["NotReadableError", "no-microphone"],
            ["AbortError", "failed"],
        ] as const) {
            getUserMedia.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
            await expect(backend.start({})).rejects.toMatchObject({ code });
        }
        getUserMedia.mockRejectedValueOnce(null);
        await expect(backend.start({})).rejects.toMatchObject({ code: "failed" });
    });

    it("asks the browser for the microphone when no function is injected", async () => {
        const stream = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
        const getUserMedia = vi.fn(async () => stream);
        vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
        const { backend } = setup({}, {}, { getUserMedia: undefined });
        await backend.start({});
        expect(getUserMedia).toHaveBeenCalled();
    });

    it("reports an unexpected failure as failed, even when cleanup throws", async () => {
        const h = setup();
        h.track.stop.mockImplementation(() => {
            throw new Error("stuck");
        });
        h.worker.reply = "failed";
        await expect(h.backend.start({})).rejects.toMatchObject({ code: "failed" });
        const second = setup();
        second.context.resume.mockImplementationOnce(() => {
            throw new Error("boom");
        });
        await expect(second.backend.start({})).rejects.toMatchObject({ code: "failed" });
    });

    it("fails when the listening worker fails, errors or never answers", async () => {
        const failed = setup();
        failed.worker.reply = "failed";
        await expect(failed.backend.start({})).rejects.toMatchObject({ code: "failed" });
        const errored = setup();
        errored.worker.reply = "error";
        await expect(errored.backend.start({})).rejects.toMatchObject({ code: "failed" });
        vi.useFakeTimers();
        const silent = setup();
        silent.worker.reply = "none";
        const started = silent.backend.start({});
        const assertion = expect(started).rejects.toMatchObject({ code: "failed" });
        await vi.advanceTimersByTimeAsync(20_001);
        await assertion;
    });

    it("ignores worker messages of other kinds while waiting", async () => {
        const h = setup();
        h.worker.reply = "none";
        const started = h.backend.start({});
        await flush();
        h.worker.onmessage?.({ data: { type: "other" } });
        h.worker.onmessage?.({ data: undefined });
        h.worker.onmessage?.({ data: { type: "ready" } });
        await started;
    });

    it("cancels a start that is stopped at each step", async () => {
        // While probing.
        const probe = deferred<VoiceCapabilities>();
        const a = setup({}, {}, { probe: () => probe.promise });
        const startA = a.backend.start({});
        await flush();
        await a.backend.stop();
        probe.resolve(CAPS);
        await expect(startA).rejects.toMatchObject({ code: "cancelled" });

        // While the microphone opens.
        const mic = deferred<MediaStream>();
        const b = setup();
        b.getUserMedia.mockReturnValueOnce(mic.promise);
        const startB = b.backend.start({});
        await flush();
        await b.backend.stop();
        mic.resolve({ getTracks: () => [b.track], getAudioTracks: () => [b.track] } as unknown as MediaStream);
        await expect(startB).rejects.toMatchObject({ code: "cancelled" });
        expect(b.track.stop).toHaveBeenCalled();

        // While Silero loads.
        const silero = deferred<ArrayBuffer>();
        mocks.loadSilero.mockReturnValueOnce(silero.promise);
        const c = setup({ ...noSeam, transcribe: () => "x", speak: "silent" });
        const startC = c.backend.start({});
        await flush();
        await c.backend.stop();
        silero.resolve(new ArrayBuffer(8));
        await expect(startC).rejects.toMatchObject({ code: "cancelled" });

        // While the worker starts.
        const d = setup();
        d.worker.reply = "none";
        const startD = d.backend.start({});
        await flush();
        await d.backend.stop();
        d.worker.onmessage?.({ data: { type: "ready" } });
        await expect(startD).rejects.toMatchObject({ code: "cancelled" });

        // While the voice loads.
        const phonon = deferred<void>();
        mocks.loadBrowserPhonon.mockReturnValueOnce(phonon.promise);
        const e = setup({ speak: undefined });
        const startE = e.backend.start({});
        await flush();
        await e.backend.stop();
        phonon.resolve();
        await expect(startE).rejects.toMatchObject({ code: "cancelled" });
    });

    it("starting again stops the session before", async () => {
        const h = setup();
        await h.backend.start({});
        await h.backend.start({});
        expect(h.worker.terminated).toBe(true);
        await h.backend.stop();
    });

    it("maps a Silero that cannot load to unavailable", async () => {
        mocks.loadSilero.mockRejectedValueOnce(new Error("no"));
        const h = setup(noSeam);
        await expect(h.backend.start({})).rejects.toMatchObject({ code: "unavailable" });
    });
});

describe("WebVoiceBackend engines", () => {
    it("runs Silero and the models of the GPU tier", async () => {
        const model = new ArrayBuffer(8);
        mocks.loadSilero.mockResolvedValue(model);
        mocks.transcribeSamplesInBrowser.mockResolvedValue("hello from whisper");
        mocks.speakWithBrowserModel.mockResolvedValue(new Blob(["x"]));
        const addModule = vi.fn(async () => undefined);
        class FakeNode {
            port = { postMessage: vi.fn() };
            connect = vi.fn();
            disconnect = vi.fn();
        }
        vi.stubGlobal("AudioWorkletNode", FakeNode);
        const h = setup(noSeam, {}, { createWorkletNode: undefined });
        h.context.audioWorklet.addModule = addModule;
        await h.backend.start({}, "af_sky");
        expect(addModule).toHaveBeenCalled();
        expect(h.worker.messages[0]).toMatchObject({ type: "init", mode: "silero", model });
        await speak(h);
        expect(h.events.find((event) => event.type === "turn")).toMatchObject({ text: "hello from whisper" });
        h.backend.speak(turnIdOf(h.events), 0, "Hi there.", false);
        await flush();
        expect(mocks.speakWithBrowserModel).toHaveBeenCalledWith("Hi there.", { model: "phonon", voice: "af_sky" });
    });

    it("maps models that cannot load to unavailable", async () => {
        mocks.loadBrowserTranscriber.mockRejectedValueOnce(new Error("no"));
        const a = setup({ ...noSeam, speak: "silent" });
        await expect(a.backend.start({})).rejects.toMatchObject({ code: "unavailable" });
        mocks.loadBrowserPhonon.mockRejectedValueOnce(new Error("no"));
        const b = setup({ speak: undefined });
        await expect(b.backend.start({})).rejects.toMatchObject({ code: "unavailable" });
    });

    it("uses the primed audio, and makes its own when it was closed", async () => {
        const primedContext = {
            state: "running",
            resume: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            destination: {},
            audioWorklet: { addModule: vi.fn(async () => undefined) },
            createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        };
        mocks.primed = { context: primedContext, elements: [new FakeAudio()] };
        const a = setup();
        await a.backend.start({});
        expect(a.context.resume).not.toHaveBeenCalled();
        expect(primedContext.resume).toHaveBeenCalled();
        await a.backend.stop();
        mocks.primed = { context: { ...primedContext, state: "closed" }, elements: [] };
        const b = setup();
        await b.backend.start({});
        expect(b.context.resume).toHaveBeenCalled();
    });

    it("builds its own audio context and audio elements by default", async () => {
        class Context {
            state = "running";
            destination = {};
            audioWorklet = { addModule: vi.fn(async () => undefined) };
            resume = vi.fn(async () => undefined);
            close = vi.fn(async () => undefined);
            createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
        }
        vi.stubGlobal("AudioContext", Context);
        const h = setup({}, {}, { createAudioContext: undefined, createAudio: undefined });
        await h.backend.start({});
        await speak(h);
        h.backend.speak(turnIdOf(h.events), 0, "Hello.", false);
        await flush();
        expect(h.events.some((event) => event.type === "clauseStarted")).toBe(true);
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", Context);
        const g = setup({}, {}, { createAudioContext: undefined });
        await g.backend.start({});
    });

    it("runs the speech server tier: opt-in, with the server's words and voice", async () => {
        prefs({ voiceMode: { serverSpeech: true }, transcription: { language: "fr" } });
        mocks.transcribeAudio.mockResolvedValue({ text: "bonjour" });
        mocks.synthesizeSpeech.mockResolvedValue(new Blob(["x"]));
        const h = setup({ ...noSeam }, { appleMobile: true, systemVoices: false });
        expect((await h.backend.status()).sentence).toMatch(/speech server/);
        await h.backend.start({});
        await speak(h);
        expect(mocks.transcribeAudio).toHaveBeenCalledWith(expect.any(Blob), { language: "fr" });
        h.backend.speak(turnIdOf(h.events), 0, "Salut.", false);
        await flush();
        expect(mocks.synthesizeSpeech).toHaveBeenCalledWith("Salut.");
    });

    it("sends no language when none is set, and speaks with the system's voice", async () => {
        prefs({ voiceMode: { serverSpeech: true }, speech: { engine: "browser", voice: "voice-1" } });
        mocks.transcribeAudio.mockResolvedValue({ text: "hello" });
        const h = setup({ ...noSeam }, { appleMobile: true, systemVoices: true });
        await h.backend.start({});
        await speak(h);
        expect(mocks.transcribeAudio).toHaveBeenCalledWith(expect.any(Blob), undefined);
        vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
        vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] });
        h.backend.speak(turnIdOf(h.events), 0, "Hello.", false);
        await flush();
        expect(h.events.some((event) => event.type === "clauseStarted")).toBe(true);
    });
});

describe("WebVoiceBackend browser recognition (tier C)", () => {
    const tierC = { appleMobile: true, onDeviceRecognition: true, systemVoices: true };

    it("starts recognition with the turn and takes its words", async () => {
        const recognition = { stop: vi.fn(async () => "  hello browser "), cancel: vi.fn() };
        mocks.startOnDeviceRecognition.mockReturnValue(recognition);
        prefs({ transcription: { language: "de" } });
        const h = setup(noSeam, tierC);
        await h.backend.start({});
        await speakAfterRecognition(h);
        expect(mocks.startOnDeviceRecognition).toHaveBeenCalledWith("de");
        expect(mocks.startOnDeviceRecognition).toHaveBeenCalledTimes(1);
        expect(h.events.find((event) => event.type === "turn")).toMatchObject({ text: "hello browser" });
    });

    it("drops the turn when recognition could not start or is gone", async () => {
        mocks.startOnDeviceRecognition.mockImplementation(() => {
            throw new Error("not here");
        });
        const h = setup(noSeam, tierC);
        await h.backend.start({});
        await speakAfterRecognition(h);
        expect(h.events.find((event) => event.type === "turn")).toBeUndefined();
        expect(types(h.events).at(-1)).toBe("state:listening");
    });

    it("cancels recognition when stopped, and ignores one that arrives late", async () => {
        const recognition = { stop: vi.fn(async () => "x"), cancel: vi.fn() };
        mocks.startOnDeviceRecognition.mockReturnValue(recognition);
        const h = setup(noSeam, tierC);
        await h.backend.start({});
        h.frames(0.9, 3);
        await flush();
        await h.backend.stop();
        expect(recognition.cancel).toHaveBeenCalled();

        mocks.startOnDeviceRecognition.mockClear();
        const late = setup(noSeam, tierC);
        await late.backend.start({});
        late.frames(0.9, 3);
        await late.backend.stop();
        await flush();
        expect(mocks.startOnDeviceRecognition).not.toHaveBeenCalled();
    });

    it("renders clauses for the system's voice", async () => {
        mocks.startOnDeviceRecognition.mockReturnValue({ stop: async () => "hi", cancel: vi.fn() });
        vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
        vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] });
        const h = setup({ ...noSeam }, tierC);
        await h.backend.start({});
        await speakAfterRecognition(h);
        h.backend.speak(turnIdOf(h.events), 0, "Hello.", false);
        await flush();
        expect(h.events.some((event) => event.type === "clauseStarted")).toBe(true);
    });
});

describe("WebVoiceBackend listening edge cases", () => {
    it("drops a turn whose words fail, and one that was stopped meanwhile", async () => {
        const failing = setup({ transcribe: () => Promise.reject(new Error("no")) });
        await failing.backend.start({});
        await speak(failing);
        expect(types(failing.events).at(-1)).toBe("state:listening");
        expect(failing.events.find((event) => event.type === "turn")).toBeUndefined();

        const pending = deferred<string>();
        const stopped = setup({ transcribe: () => pending.promise });
        await stopped.backend.start({});
        await speak(stopped);
        await stopped.backend.stop();
        pending.resolve("late words");
        await flush();
        expect(stopped.events.find((event) => event.type === "turn")).toBeUndefined();

        const rejecting = deferred<string>();
        const stoppedFail = setup({ transcribe: () => rejecting.promise });
        await stoppedFail.backend.start({});
        await speak(stoppedFail);
        await stoppedFail.backend.stop();
        rejecting.reject(new Error("late"));
        await flush();
        expect(stoppedFail.events.find((event) => event.type === "turn")).toBeUndefined();
    });

    it("resolves a pending audio request when stopped, and ignores unknown audio and other messages", async () => {
        const h = setup();
        h.worker.postMessage = (message: Record<string, unknown>) => {
            h.worker.messages.push(message);
            if (message.type === "init") queueMicrotask(() => h.worker.onmessage?.({ data: { type: "ready" } }));
        };
        await h.backend.start({});
        h.worker.onmessage?.({ data: { type: "audio", id: 99 } });
        h.worker.onmessage?.({ data: { type: "audio", id: 99, samples: new Float32Array(1) } });
        h.worker.onmessage?.({ data: { type: "noise" } });
        h.worker.onmessage?.({ data: { type: "vad" } });
        await speak(h);
        expect(h.worker.messages.some((message) => message.type === "audio")).toBe(true);
        await h.backend.stop();
        await flush();
        expect(h.events.find((event) => event.type === "turn")).toBeUndefined();
    });

    it("ends with an error when the worker fails after starting", async () => {
        const h = setup();
        await h.backend.start({});
        h.worker.onerror?.();
        expect(h.events.at(-1)).toEqual({ type: "ended", reason: "error" });
        h.worker.onerror?.();
        expect(h.events.filter((event) => event.type === "ended")).toHaveLength(1);
    });

    it("releases even when the audio graph is already torn down", async () => {
        const h = setup();
        await h.backend.start({});
        h.node.port.postMessage.mockImplementation(() => {
            throw new Error("gone");
        });
        await h.backend.stop();
        expect(h.worker.terminated).toBe(true);
    });

    it("does nothing for the answer without a session", async () => {
        const { backend, events } = setup();
        backend.speak("t", 0, "x", false);
        backend.endAnswer("t");
        await backend.cancelAnswer("t");
        expect(events).toEqual([]);
    });

    it("ends the answer's queue", async () => {
        const h = setup();
        await h.backend.start({});
        await speak(h);
        const turnId = turnIdOf(h.events);
        h.backend.speak(turnId, 0, "One.", true);
        h.backend.endAnswer(turnId);
        await flush();
        h.audios.find((audio) => audio.play.mock.calls.length > 0)?.fire("ended");
        await flush();
        expect(h.events.some((event) => event.type === "answerFinished")).toBe(true);
    });

    it("ignores queue events of a session that is gone", async () => {
        const h = setup();
        await h.backend.start({});
        await speak(h);
        h.backend.speak(turnIdOf(h.events), 0, "One.", false);
        await flush();
        const playing = h.audios.find((audio) => audio.play.mock.calls.length > 0)!;
        await h.backend.stop();
        h.events.length = 0;
        playing.fire("ended");
        await flush();
        expect(h.events).toEqual([]);
    });

    it("reports metrics with the real clock", async () => {
        const h = setup({}, {}, { now: undefined });
        await h.backend.start({ maxSilenceMs: 500 });
        await speak(h);
        expect(h.events.find((event) => event.type === "metrics")).toBeDefined();
    });
});

describe("policyConfig branches", () => {
    it("keeps a maxTurnMs within the limit", () => {
        expect(policyConfig({ maxTurnMs: 1000, vadThreshold: "x" })).toEqual({ maxTurnMs: 1000 });
    });
});

describe("WebVoiceBackend remaining branches", () => {
    it("has no seam on the server", () => {
        vi.stubGlobal("window", undefined);
        expect(testSeam()).toBeNull();
    });

    it("tolerates a context that refuses to resume or close", async () => {
        const h = setup();
        h.context.resume.mockRejectedValue(new Error("no"));
        h.context.close.mockRejectedValue(new Error("no"));
        h.worker.reply = "failed";
        await expect(h.backend.start({})).rejects.toMatchObject({ code: "failed" });
        const g = setup();
        g.context.resume.mockRejectedValue(new Error("no"));
        g.context.close.mockRejectedValue(new Error("no"));
        await g.backend.start({});
        await g.backend.stop();
        await flush();
        expect(g.context.close).toHaveBeenCalled();
    });

    it("creates the listening worker itself by default", async () => {
        vi.stubGlobal("Worker", class extends FakeWorker {});
        const h = setup({}, {}, { createWorker: undefined });
        await h.backend.start({});
        await h.backend.stop();
    });

    it("reports cancelled for an unexpected failure after a stop", async () => {
        const probe = deferred<VoiceCapabilities>();
        const h = setup({}, {}, { probe: () => probe.promise });
        const started = h.backend.start({});
        await flush();
        await h.backend.stop();
        probe.reject(new Error("late"));
        await expect(started).rejects.toMatchObject({ code: "cancelled" });
    });

    it("treats audio without samples and frames without a probability as silence", async () => {
        const h = setup();
        h.worker.postMessage = (message: Record<string, unknown>) => {
            h.worker.messages.push(message);
            if (message.type === "init") queueMicrotask(() => h.worker.onmessage?.({ data: { type: "ready" } }));
        };
        await h.backend.start({});
        h.worker.onmessage?.({ data: { type: "vad", index: 0 } });
        await speak(h);
        const request = h.worker.messages.find((message) => message.type === "audio")!;
        h.worker.onmessage?.({ data: { type: "audio", id: request.id } });
        await flush();
        expect(h.events.find((event) => event.type === "turn")).toMatchObject({ audioMs: 20 * FRAME_MS });
    });

    it("stops deciding once an event handler stopped the session", async () => {
        const h = setup();
        await h.backend.start({});
        await speak(h);
        const first = turnIdOf(h.events);
        const push = h.events.push.bind(h.events);
        h.events.push = (...items: VoiceEvent[]) => {
            if (items[0].type === "bargeIn") void h.backend.stop();
            return push(...items);
        };
        h.frames(0.9, 23);
        expect(h.events.some((event) => event.type === "bargeIn" && event.turnId === first)).toBe(true);
        expect(h.events.filter((event) => event.type === "state" && event.state === "user-speaking")).toHaveLength(1);
    });

    it("ignores a clause that finishes rendering after the session stopped", async () => {
        const pending = deferred<Blob>();
        mocks.speakWithBrowserModel.mockReturnValue(pending.promise);
        const h = setup({ speak: undefined, transcribe: () => "hi" });
        await h.backend.start({});
        await speak(h);
        h.backend.speak(turnIdOf(h.events), 0, "Hello.", false);
        await h.backend.stop();
        h.events.length = 0;
        pending.resolve(new Blob(["x"]));
        await flush();
        expect(h.events).toEqual([]);
    });

    it("drops a queue event that outlives its session", async () => {
        const h = setup();
        await h.backend.start({});
        await speak(h);
        h.backend.speak(turnIdOf(h.events), 0, "One.", false);
        await flush();
        const playing = h.audios.find((audio) => audio.play.mock.calls.length > 0)!;
        // The session is replaced without the queue being cleared: the guard is the only thing between the two.
        (h.backend as unknown as { session: unknown }).session = null;
        h.events.length = 0;
        playing.fire("ended");
        await flush();
        expect(h.events).toEqual([]);
    });
});
