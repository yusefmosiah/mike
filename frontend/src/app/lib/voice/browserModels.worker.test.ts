import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page side of the worker (browserModels.ts with a stand-in Worker) and
// the worker's message loop (browserModels.worker.ts with a stand-in engine).

const engine = vi.hoisted(() => ({ handleEngineRequest: vi.fn() }));
vi.mock("./browserModels.engine", () => engine);

class FakeWorker {
    static instances: FakeWorker[] = [];
    posted: Array<Record<string, unknown>> = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: { preventDefault(): void }) => void) | null = null;
    terminate = vi.fn();

    constructor(
        public url: URL,
        public options: WorkerOptions,
    ) {
        FakeWorker.instances.push(this);
    }

    postMessage(message: Record<string, unknown>) {
        this.posted.push(message);
    }

    reply(data: Record<string, unknown>) {
        this.onmessage?.({ data } as MessageEvent);
    }
}

type Module = typeof import("./browserModels");
let mod: Module;

beforeEach(async () => {
    vi.resetModules();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", {});
    mod = await import("./browserModels");
    mod.setBrowserModelConsent("speech", true);
    mod.setBrowserModelConsent("transcription", true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the page side", () => {
    it("runs speech in one module worker and returns its audio", async () => {
        const audio = new Blob(["wav"], { type: "audio/wav" });
        const spoken = mod.speakWithBrowserModel("Hello.", { voice: "bf_emma", speed: 1.2 });
        await settle();
        const worker = FakeWorker.instances[0];
        expect(worker.url.pathname).toMatch(/browserModels\.worker\.ts$/);
        expect(worker.options).toEqual({ type: "module" });
        expect(worker.posted[0]).toMatchObject({ id: 1, op: "speak", text: "Hello.", voice: "bf_emma", speed: 1.2 });
        worker.reply({ id: 1, type: "done", result: audio });
        await expect(spoken).resolves.toBe(audio);

        void mod.speakWithBrowserModel("Again.");
        await settle();
        expect(FakeWorker.instances).toHaveLength(1);
    });

    it("forwards download progress and ignores messages for no request", async () => {
        const progress: number[] = [];
        const loading = mod.loadBrowserSpeaker((fraction) => progress.push(fraction));
        await settle();
        const worker = FakeWorker.instances[0];
        expect(worker.posted[0]).toMatchObject({ op: "load", kind: "speech" });
        worker.reply({ id: 99, type: "done" });
        worker.reply({ id: 1, type: "progress", fraction: 0.5 });
        worker.reply({ id: 1, type: "progress" });
        worker.reply({ id: 1, type: "done" });
        await expect(loading).resolves.toBeUndefined();
        expect(progress).toEqual([0.5, 0]);

        const quiet = mod.loadBrowserTranscriber();
        await settle();
        worker.reply({ id: 2, type: "progress", fraction: 0.3 });
        worker.reply({ id: 2, type: "done" });
        await expect(quiet).resolves.toBeUndefined();
    });

    it("shows one plain message when the model fails", async () => {
        const spoken = mod.speakWithBrowserModel("Hello.");
        await settle();
        FakeWorker.instances[0].reply({ id: 1, type: "error" });
        await expect(spoken).rejects.toThrow(mod.BROWSER_MODEL_FAILED_MESSAGE);
    });

    it("fails pending work when the worker dies, and starts a new one next time", async () => {
        const spoken = mod.speakWithBrowserModel("Hello.");
        await settle();
        const first = FakeWorker.instances[0];
        const preventDefault = vi.fn();
        first.onerror?.({ preventDefault });
        await expect(spoken).rejects.toThrow(mod.BROWSER_MODEL_FAILED_MESSAGE);
        expect(preventDefault).toHaveBeenCalled();
        expect(first.terminate).toHaveBeenCalled();

        void mod.speakWithBrowserModel("Again.");
        await settle();
        expect(FakeWorker.instances).toHaveLength(2);
    });
});

describe("the worker's message loop", () => {
    it("answers each request with progress, then the result or a failure", async () => {
        const posted: unknown[] = [];
        vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
        await import("./browserModels.worker");
        const onmessage = (self as unknown as { onmessage: (event: MessageEvent) => void }).onmessage;

        engine.handleEngineRequest.mockImplementationOnce(async (_request: unknown, onProgress: (f: number) => void) => {
            onProgress(0.25);
            return "text";
        });
        onmessage({ data: { id: 7, op: "transcribe", samples: new Float32Array(1) } } as MessageEvent);
        await settle();
        expect(engine.handleEngineRequest).toHaveBeenCalledWith(
            { op: "transcribe", samples: new Float32Array(1) },
            expect.any(Function),
        );
        expect(posted).toEqual([
            { id: 7, type: "progress", fraction: 0.25 },
            { id: 7, type: "done", result: "text" },
        ]);

        engine.handleEngineRequest.mockRejectedValueOnce(new Error("internal library text"));
        onmessage({ data: { id: 8, op: "speak", text: "x" } } as MessageEvent);
        await settle();
        expect(posted.at(-1)).toEqual({ id: 8, type: "error" });
    });
});
