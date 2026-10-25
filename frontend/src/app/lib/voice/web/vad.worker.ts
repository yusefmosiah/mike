/**
 * Voice mode's listening worker in the browser (docs/voice-web.md, "Audio
 * pipeline"). The capture worklet posts 16 kHz frames to it over a
 * MessagePort; it keeps them in a ring buffer, runs Silero v5 on each one on
 * ONNX Runtime's plain WebAssembly build (one thread, separate from the
 * models' worker, browserModels.worker.ts) and posts the page each frame's
 * speech probability. The page's turn policy decides when a turn ends and
 * asks for that stretch of audio back.
 *
 * ONNX Runtime is loaded by URL from the copy under public/voice-web/ort/
 * (frontend/scripts/copy-voice-web.mjs), not bundled.
 *
 * Messages in: `init` { port, mode: "silero" | "energy", model?, ortUrl? },
 * `audio` { id, fromMs, toMs }, `stop`. Out: `ready`, `failed`,
 * `vad` { index, probability }, `audio` { id, samples }.
 */

import { EnergyDetector, SileroDetector, VadCore, type OrtLike, type OrtSessionLike, type SpeechDetector } from "./vadCore";

type Incoming =
    | { type: "init"; port: MessagePort; mode: "silero" | "energy"; model?: ArrayBuffer; ortUrl?: string }
    | { type: "audio"; id: number; fromMs: number; toMs: number }
    | { type: "stop" };

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<Incoming>) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
    close: () => void;
};

let core: VadCore | null = null;
let port: MessagePort | null = null;

interface OrtModule extends OrtLike {
    env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
    InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike> };
}

async function detector(message: Extract<Incoming, { type: "init" }>): Promise<SpeechDetector> {
    if (message.mode === "energy") return new EnergyDetector();
    if (!message.model || !message.ortUrl) throw new Error("missing model");
    const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ message.ortUrl)) as OrtModule;
    ort.env.wasm.wasmPaths = new URL(".", new URL(message.ortUrl, self.location.href)).href;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(new Uint8Array(message.model), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    });
    return new SileroDetector(ort, session);
}

scope.onmessage = (event) => {
    const message = event.data;
    switch (message.type) {
        case "init":
            void detector(message).then(
                (found) => {
                    core = new VadCore(found);
                    port = message.port;
                    port.onmessage = (frameEvent: MessageEvent<{ type: string; samples?: Float32Array }>) => {
                        const samples = frameEvent.data?.samples;
                        if (!core || frameEvent.data?.type !== "frame" || !samples) return;
                        void core.push(samples).then(({ index, probability }) =>
                            scope.postMessage({ type: "vad", index, probability }),
                        );
                    };
                    scope.postMessage({ type: "ready" });
                },
                () => scope.postMessage({ type: "failed" }),
            );
            return;
        case "audio": {
            const samples = core ? core.audio(message.fromMs, message.toMs) : new Float32Array(0);
            scope.postMessage({ type: "audio", id: message.id, samples }, [samples.buffer]);
            return;
        }
        case "stop":
            port?.close();
            port = null;
            core = null;
            scope.close();
            return;
    }
};
