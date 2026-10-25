"use client";

/**
 * Hands-free voice mode in a plain browser (docs/voice-web.md, phase 1): the
 * web counterpart of the iPhone engine, behind the same functions in
 * voiceEngine.ts and emitting the same events (docs/voice-chat-contract.md).
 * voiceEngine.ts imports this module only when voice mode starts in a
 * browser, so none of it is in the page's main bundle.
 *
 * The microphone goes through an AudioWorklet (16 kHz frames) to the
 * listening worker (Silero in a ring buffer); the turn policy (a port of the
 * iPhone's) decides from Silero's probabilities when a turn ends, and that
 * stretch of audio is transcribed by the engine the plan picked
 * (capabilities.ts). Answers are spoken clause by clause through the clause
 * queue. Phase 1 is half-duplex: while an answer plays (and a moment after)
 * the microphone is not listened to; the panel's "Tap to interrupt" ends it.
 */

import { encodeWav } from "../speechAudio";
import type { VoiceEvent, VoiceStatus } from "../voiceEngine";
import { planWebVoice, probeVoiceCapabilities, modelBytes, type VoiceCapabilities, type WebVoicePlan } from "./capabilities";
import { ClauseQueue, type ClauseRenderer, type RenderedClause } from "./clauseQueue";
import {
    CAPTURE_WORKLET_URL,
    ORT_URL,
    downloadSilero,
    estimatedBytesPerSecond,
    loadSilero,
    removeVoiceModels,
    requestPersistentStorage,
    sileroCached,
} from "./models";
import { WebClausePlayer, type AudioLike } from "./player";
import { takePrimedAudio } from "./prime";
import { silentWavBytes } from "./silentWav";
import { MAX_TURN_LIMIT_MS, TurnPolicy, type PolicyCommit, type PolicyDecision, type TurnPolicyConfig } from "./turnPolicy";
import { FRAME_MS } from "./vadCore";
import { estimateSetupMinutes } from "../pricing";
import { loadVoicePreferences, voiceModeServerSpeech } from "../preferences";

/** What voice mode in the browser adds to the engine's status. */
export interface WebVoiceStatus extends VoiceStatus {
    /** How voice mode runs here, in a sentence. */
    sentence?: string;
    /** The downloads, as "about N minutes" (never shown as a size). */
    downloadMinutes?: number;
    /** Why voice mode cannot run here, for the person. */
    unavailableMessage?: string;
}

/** An error the engine's callers map to a message by its `code`. */
export class WebVoiceError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

/**
 * The test seam (e2e/voice-web.spec.ts): set on `window` before the page
 * loads, it replaces the pieces a test browser cannot run. Synthetic audio
 * does not sound like speech to Silero, so `vad: "energy"` detects speech by
 * loudness; `transcribe` and `speak` stand in for the models; `models`
 * pretends they are downloaded ("installed") or still to download
 * ("missing", and the download does nothing).
 */
export interface VoiceTestSeam {
    vad?: "energy";
    transcribe?: (turn: { audioMs: number; samples: number }) => string | Promise<string>;
    speak?: "silent";
    models?: "installed" | "missing";
    capabilities?: Partial<VoiceCapabilities>;
}

export const testSeam = (): VoiceTestSeam | null =>
    typeof window === "undefined" ? null : ((window as unknown as { __mikeVoiceTest?: VoiceTestSeam }).__mikeVoiceTest ?? null);

/** Listening resumes this long after the answer stops playing, so its tail is not heard as speech. */
export const PLAYBACK_TAIL_MS = 300;
/** Audio kept before the VAD's start of speech and after its end, for the transcription. */
export const PAD_BEFORE_MS = 300;
export const PAD_AFTER_MS = 200;
const WORKER_READY_MS = 20_000;

/** Outputs Whisper gives for silence or noise, which are not words. */
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;
export const cleanTranscript = (text: string): string => text.replace(NON_SPEECH, " ").replace(/\s+/g, " ").trim();

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The contract's config, as the web turn policy takes it (see turnPolicy.ts for the differences). */
export function policyConfig(config: Record<string, unknown>): Partial<TurnPolicyConfig> {
    const out: Partial<TurnPolicyConfig> = {};
    for (const key of ["vadThreshold", "maxSilenceMs", "continueMs", "bargeInVadThreshold", "fallbackSilenceMs"] as const) {
        if (finite(config[key])) out[key] = config[key] as number;
    }
    if (finite(config.maxTurnMs)) out.maxTurnMs = (config.maxTurnMs as number) > MAX_TURN_LIMIT_MS ? undefined : (config.maxTurnMs as number);
    // No words to go on: the barge-in waits for the speech that would hold playback on the iPhone.
    if (finite(config.holdSpeechMs)) out.bargeInSpeechMs = config.holdSpeechMs as number;
    return out;
}

type Words = (turn: { samples: Float32Array; audioMs: number }) => Promise<string>;

interface Session {
    token: number;
    plan: WebVoicePlan;
    context: AudioContext;
    stream: MediaStream;
    node: AudioWorkletNode;
    source: MediaStreamAudioSourceNode;
    worker: Worker;
    policy: TurnPolicy;
    queue: ClauseQueue;
    player: WebClausePlayer;
    words: Words;
    gateUntilMs: number;
    audioRequests: Map<number, (samples: Float32Array) => void>;
    nextAudioId: number;
    recognition: { stop(): Promise<string>; cancel(): void } | null;
    nowMs: number;
    turnCount: number;
}

export interface WebBackendDeps {
    probe?: () => Promise<VoiceCapabilities>;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    createWorker?: () => Worker;
    createAudioContext?: () => AudioContext;
    createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
    createAudio?: () => AudioLike;
    now?: () => number;
}

export class WebVoiceBackend {
    private session: Session | null = null;
    private token = 0;
    private starting = false;
    private capabilities: Promise<VoiceCapabilities> | null = null;

    constructor(
        private readonly emit: (event: VoiceEvent) => void,
        private readonly deps: WebBackendDeps = {},
    ) {}

    // MARK: - Status and setup

    private async probe(): Promise<VoiceCapabilities> {
        const seam = testSeam();
        // WebGPU's probe creates a device; once per page is enough.
        this.capabilities ??= (async () => {
            if (this.deps.probe) return this.deps.probe();
            const [{ onDeviceRecognitionStatus, browserSpeechSupported }, { previousBrowserModelRunDied }] = await Promise.all([
                import("../browserSpeech"),
                import("../browserModels"),
            ]);
            return probeVoiceCapabilities({
                priorCrash: previousBrowserModelRunDied,
                onDeviceRecognition: async () => (await onDeviceRecognitionStatus()) === "available",
                systemVoices: browserSpeechSupported,
            });
        })().catch((error: unknown) => {
            this.capabilities = null;
            throw error;
        });
        const found = await this.capabilities;
        return seam?.capabilities ? { ...found, ...seam.capabilities } : found;
    }

    private serverSpeech: Promise<boolean> | null = null;

    /** Whether this deployment has a speech server; asked only when a plan would use it. */
    private serverAvailable(): Promise<boolean> {
        this.serverSpeech ??= import("@/app/lib/mikeApi")
            .then(({ getVoiceOptions }) => getVoiceOptions())
            .then((options) => !!options.operator.transcription)
            .catch(() => {
                this.serverSpeech = null;
                return false;
            });
        return this.serverSpeech;
    }

    private async plan() {
        const caps = await this.probe();
        const serverSpeech = voiceModeServerSpeech(loadVoicePreferences());
        const result = planWebVoice(caps, { serverSpeech });
        // Only a plan that needs the speech server checks that there is one.
        const needsServer = result.available ? result.plan.words === "server" : result.reason === "needs-server";
        if (!needsServer || (await this.serverAvailable())) return result;
        return planWebVoice(caps, { serverSpeech, serverAvailable: false });
    }

    private async missing(plan: WebVoicePlan): Promise<string[]> {
        const seam = testSeam();
        if (seam?.models) return seam.models === "missing" && !this.seamInstalled ? ["vad"] : [];
        const { hasBrowserModelConsent } = await import("../browserModels");
        const missing: string[] = [];
        if (plan.models.includes("vad") && !(await sileroCached())) missing.push("vad");
        if (plan.models.includes("whisper") && !hasBrowserModelConsent("transcription")) missing.push("whisper");
        if (plan.models.includes("phonon") && !hasBrowserModelConsent("phonon")) missing.push("phonon");
        return missing;
    }

    private seamInstalled = false;

    async status(): Promise<WebVoiceStatus> {
        const idle = { preparing: false, firstTime: false, ready: [] as string[], speakerLearned: false };
        const result = await this.plan();
        if (!result.available) {
            return { ...idle, available: false, missing: [], downloadBytes: 0, unavailableMessage: result.message };
        }
        const missing = await this.missing(result.plan);
        const webkit = (await this.probe()).webkit;
        const downloadBytes = missing.reduce(
            (sum, model) => sum + (model === "vad" || model === "whisper" || model === "phonon" ? modelBytes(model, webkit) : 0),
            0,
        );
        return {
            ...idle,
            available: missing.length === 0,
            missing,
            downloadBytes,
            sentence: result.plan.sentence,
            ...(downloadBytes > 0 ? { downloadMinutes: estimateSetupMinutes(downloadBytes, estimatedBytesPerSecond()) } : {}),
        };
    }

    /** Downloads what the plan needs (the person's tap is their consent). */
    async install(): Promise<boolean> {
        const result = await this.plan();
        if (!result.available) throw new WebVoiceError("unavailable");
        const missing = await this.missing(result.plan);
        if (testSeam()?.models) {
            this.emit({ type: "install", fraction: 1 });
            this.seamInstalled = true;
            return true;
        }
        await requestPersistentStorage();
        const webkit = (await this.probe()).webkit;
        const sizes = missing.map((model) => modelBytes(model as "vad" | "whisper" | "phonon", webkit));
        const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
        let done = 0;
        const progress = (index: number) => (fraction: number) =>
            this.emit({ type: "install", fraction: Math.min(1, (done + sizes[index] * fraction) / total) });
        const models = await import("../browserModels");
        try {
            for (const [index, model] of missing.entries()) {
                if (model === "vad") await downloadSilero(progress(index));
                if (model === "whisper") {
                    models.setBrowserModelConsent("transcription", true);
                    await models.loadBrowserTranscriber(progress(index));
                }
                if (model === "phonon") {
                    models.setBrowserModelConsent("phonon", true);
                    await models.loadBrowserPhonon(progress(index));
                }
                done += sizes[index];
            }
        } catch {
            throw new WebVoiceError("failed");
        }
        this.emit({ type: "install", fraction: 1 });
        return (await this.missing(result.plan)).length === 0;
    }

    async remove(): Promise<WebVoiceStatus> {
        if (this.session || this.starting) throw new WebVoiceError("busy");
        await removeVoiceModels();
        this.seamInstalled = false;
        return this.status();
    }

    // MARK: - Start and stop

    async start(config: Record<string, unknown>, voice?: string): Promise<void> {
        if (this.session || this.starting) await this.stop();
        const token = ++this.token;
        this.starting = true;
        const primed = takePrimedAudio();
        const cleanups: (() => void)[] = [];
        const cancelled = () => token !== this.token;
        try {
            const result = await this.plan();
            if (!result.available) throw new WebVoiceError("unavailable");
            const { plan } = result;
            if ((await this.missing(plan)).length > 0) throw new WebVoiceError("unavailable");
            if (cancelled()) throw new WebVoiceError("cancelled");

            const context = primed?.context && primed.context.state !== "closed" ? primed.context : this.createContext();
            cleanups.push(() => void context.close().catch(() => undefined));
            void context.resume().catch(() => undefined);

            const stream = await this.openMicrophone();
            cleanups.push(() => stream.getTracks().forEach((track) => track.stop()));
            if (cancelled()) throw new WebVoiceError("cancelled");

            const seam = testSeam();
            const [model] = await Promise.all([
                seam?.vad === "energy" ? Promise.resolve(null) : loadSilero().catch(() => Promise.reject(new WebVoiceError("unavailable"))),
                this.deps.createWorkletNode ? Promise.resolve() : context.audioWorklet.addModule(CAPTURE_WORKLET_URL),
            ]);
            if (cancelled()) throw new WebVoiceError("cancelled");

            const node = this.deps.createWorkletNode?.(context) ?? new AudioWorkletNode(context, "mike-voice-capture", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 1,
                channelCountMode: "explicit",
            });
            const source = context.createMediaStreamSource(stream);
            source.connect(node);
            // The node outputs silence; connecting it keeps it rendering in every browser.
            node.connect(context.destination);
            cleanups.push(() => {
                node.port.postMessage({ type: "stop" });
                source.disconnect();
                node.disconnect();
            });

            const worker = this.deps.createWorker?.() ?? new Worker(new URL("./vad.worker.ts", import.meta.url), { type: "module" });
            cleanups.push(() => {
                worker.postMessage({ type: "stop" });
                worker.terminate();
            });
            const channel = new MessageChannel();
            node.port.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
            await this.workerReady(worker, channel.port2, model);
            if (cancelled()) throw new WebVoiceError("cancelled");

            const words = await this.wordsEngine(plan);
            const renderer = await this.renderer(plan, voice);
            if (cancelled()) throw new WebVoiceError("cancelled");

            const elements = primed?.elements ?? [];
            const player = new WebClausePlayer({
                createAudio: () => (elements.shift() as unknown as AudioLike | undefined) ?? this.createAudio(),
            });
            const preferences = loadVoicePreferences();
            if (plan.speaking === "system" && preferences.speech.engine === "browser") player.voiceURI = preferences.speech.voice;

            const session: Session = {
                token,
                plan,
                context,
                stream,
                node,
                source,
                worker,
                policy: new TurnPolicy(policyConfig(config)),
                player,
                queue: null as unknown as ClauseQueue,
                words,
                gateUntilMs: 0,
                audioRequests: new Map(),
                nextAudioId: 0,
                recognition: null,
                nowMs: 0,
                turnCount: 0,
            };
            session.queue = new ClauseQueue({ renderer, player, emit: (event) => this.onQueueEvent(session, event) });
            worker.onmessage = (event: MessageEvent<{ type: string; index?: number; probability?: number; id?: number; samples?: Float32Array }>) =>
                this.onWorkerMessage(session, event.data);
            worker.onerror = () => this.fail(session, "error");
            stream.getAudioTracks()[0]?.addEventListener("ended", () => this.fail(session, "route"));
            this.session = session;
            this.emit({ type: "state", state: "listening" });
        } catch (error) {
            for (const cleanup of cleanups.reverse()) {
                try {
                    cleanup();
                } catch {
                    // Already released.
                }
            }
            throw error instanceof WebVoiceError ? error : new WebVoiceError(cancelled() ? "cancelled" : "failed");
        } finally {
            if (token === this.token) this.starting = false;
        }
    }

    async stop(): Promise<void> {
        this.token += 1;
        this.starting = false;
        const session = this.session;
        this.session = null;
        if (!session) return;
        this.release(session);
    }

    private release(session: Session): void {
        session.queue.clear();
        session.player.reset();
        session.recognition?.cancel();
        session.recognition = null;
        for (const resolve of session.audioRequests.values()) resolve(new Float32Array(0));
        session.audioRequests.clear();
        try {
            session.node.port.postMessage({ type: "stop" });
            session.source.disconnect();
            session.node.disconnect();
        } catch {
            // Already disconnected.
        }
        session.worker.postMessage({ type: "stop" });
        session.worker.terminate();
        session.stream.getTracks().forEach((track) => track.stop());
        void session.context.close().catch(() => undefined);
    }

    private fail(session: Session, reason: "error" | "route"): void {
        if (this.session !== session) return;
        this.session = null;
        this.token += 1;
        this.release(session);
        this.emit({ type: "ended", reason });
    }

    private createContext(): AudioContext {
        if (this.deps.createAudioContext) return this.deps.createAudioContext();
        const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        return new Context();
    }

    private createAudio(): AudioLike {
        return this.deps.createAudio?.() ?? (new Audio() as unknown as AudioLike);
    }

    private async openMicrophone(): Promise<MediaStream> {
        const getUserMedia = this.deps.getUserMedia ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
        try {
            return await getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            });
        } catch (error) {
            const name = (error as { name?: string } | null)?.name;
            if (name === "NotAllowedError" || name === "SecurityError") throw new WebVoiceError("permission-denied");
            if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
                throw new WebVoiceError("no-microphone");
            }
            throw new WebVoiceError("failed");
        }
    }

    private workerReady(worker: Worker, port: MessagePort, model: ArrayBuffer | null): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new WebVoiceError("failed")), WORKER_READY_MS);
            worker.onmessage = (event: MessageEvent<{ type: string }>) => {
                if (event.data?.type === "ready") {
                    clearTimeout(timer);
                    resolve();
                } else if (event.data?.type === "failed") {
                    clearTimeout(timer);
                    reject(new WebVoiceError("failed"));
                }
            };
            worker.onerror = () => {
                clearTimeout(timer);
                reject(new WebVoiceError("failed"));
            };
            const message = model
                ? { type: "init", port, mode: "silero", model, ortUrl: new URL(ORT_URL, window.location.href).href }
                : { type: "init", port, mode: "energy" };
            worker.postMessage(message, model ? [port, model] : [port]);
        });
    }

    // MARK: - Engines

    private async wordsEngine(plan: WebVoicePlan): Promise<Words> {
        const seam = testSeam();
        if (seam?.transcribe) {
            const transcribe = seam.transcribe;
            return async ({ samples, audioMs }) => transcribe({ audioMs, samples: samples.length });
        }
        switch (plan.words) {
            case "whisper-gpu":
            case "whisper-cpu": {
                const models = await import("../browserModels");
                await models.loadBrowserTranscriber().catch(() => Promise.reject(new WebVoiceError("unavailable")));
                return ({ samples }) => models.transcribeSamplesInBrowser(samples);
            }
            case "server": {
                const { transcribeAudio } = await import("@/app/lib/mikeApi");
                const language = loadVoicePreferences().transcription.language;
                return async ({ samples }) =>
                    (await transcribeAudio(encodeWav([samples], 16_000), language ? { language } : undefined)).text;
            }
            case "web-speech":
                // The browser listens itself, from the start of each turn (see onDecisions).
                return async () => {
                    const session = this.session;
                    const recognition = session?.recognition;
                    if (!session || !recognition) return "";
                    session.recognition = null;
                    return recognition.stop();
                };
        }
    }

    private async renderer(plan: WebVoicePlan, voice?: string): Promise<ClauseRenderer> {
        const seam = testSeam();
        if (seam?.speak === "silent") {
            return {
                // About as long as the words would take to say.
                render: async (text) => ({
                    kind: "audio",
                    blob: new Blob([silentWavBytes(Math.min(48_000, 16_000 * 0.06 * text.length))], { type: "audio/wav" }),
                }),
            };
        }
        switch (plan.speaking) {
            case "phonon": {
                const models = await import("../browserModels");
                await models.loadBrowserPhonon().catch(() => Promise.reject(new WebVoiceError("unavailable")));
                return {
                    render: async (text): Promise<RenderedClause> => ({
                        kind: "audio",
                        blob: await models.speakWithBrowserModel(text, { model: "phonon", voice }),
                    }),
                };
            }
            case "server": {
                const { synthesizeSpeech } = await import("@/app/lib/mikeApi");
                return { render: async (text) => ({ kind: "audio", blob: await synthesizeSpeech(text) }) };
            }
            case "system":
                return { render: async (text) => ({ kind: "utterance", text }) };
        }
    }

    // MARK: - Listening

    private onWorkerMessage(
        session: Session,
        data: { type: string; index?: number; probability?: number; id?: number; samples?: Float32Array },
    ): void {
        if (this.session !== session) return;
        if (data.type === "audio" && typeof data.id === "number") {
            const resolve = session.audioRequests.get(data.id);
            session.audioRequests.delete(data.id);
            resolve?.(data.samples ?? new Float32Array(0));
            return;
        }
        if (data.type !== "vad" || typeof data.index !== "number") return;
        const startMs = data.index * FRAME_MS;
        const endMs = startMs + FRAME_MS;
        session.nowMs = endMs;
        // Half-duplex: while the answer plays, and a moment after, what the
        // microphone hears is the answer.
        if (session.queue.audible) session.gateUntilMs = endMs + PLAYBACK_TAIL_MS;
        const gated = session.queue.audible || endMs < session.gateUntilMs;
        const probability = gated ? 0 : (data.probability ?? 0);
        this.onDecisions(session, [
            ...session.policy.handle({ type: "vad", probability, startMs, endMs }),
            ...session.policy.handle({ type: "tick", nowMs: endMs }),
        ]);
    }

    private onDecisions(session: Session, decisions: PolicyDecision[]): void {
        for (const decision of decisions) {
            if (this.session !== session) return;
            switch (decision.type) {
                case "state":
                    if (decision.state === "user-speaking" && session.plan.words === "web-speech" && !session.recognition) {
                        void this.startRecognition(session);
                    }
                    this.emit({ type: "state", state: decision.state });
                    break;
                case "bargeIn":
                    this.emit({ type: "bargeIn", turnId: decision.turnId });
                    session.queue.cancel(decision.turnId);
                    break;
                case "commit":
                    void this.finalize(session, decision.commit);
                    break;
            }
        }
    }

    private async startRecognition(session: Session): Promise<void> {
        const { startOnDeviceRecognition } = await import("../browserSpeech");
        if (this.session !== session || session.recognition) return;
        try {
            session.recognition = startOnDeviceRecognition(loadVoicePreferences().transcription.language);
        } catch {
            session.recognition = null;
        }
    }

    private requestAudio(session: Session, fromMs: number, toMs: number): Promise<Float32Array> {
        const id = ++session.nextAudioId;
        return new Promise((resolve) => {
            session.audioRequests.set(id, resolve);
            session.worker.postMessage({ type: "audio", id, fromMs, toMs });
        });
    }

    private async finalize(session: Session, commit: PolicyCommit): Promise<void> {
        const now = this.deps.now ?? (() => performance.now());
        const began = now();
        const audioMs = commit.endMs - commit.startMs;
        let text = "";
        try {
            const samples = await this.requestAudio(session, Math.max(0, commit.startMs - PAD_BEFORE_MS), commit.endMs + PAD_AFTER_MS);
            if (this.session !== session) return;
            text = cleanTranscript(await session.words({ samples, audioMs }));
        } catch {
            if (this.session !== session) return;
            // The words could not be made out; the turn is dropped and listening goes on.
            text = "";
        }
        if (this.session !== session) return;
        if (!text) {
            this.onDecisions(session, session.policy.handle({ type: "turnDiscarded" }));
            return;
        }
        const turnId = `web-${Date.now().toString(36)}-${++session.turnCount}`;
        session.queue.begin(turnId);
        this.emit({ type: "turn", turnId, text, audioMs, ...(commit.continues ? { continues: commit.continues } : {}) });
        this.onDecisions(session, session.policy.handle({ type: "turnCommitted", turnId }));
        this.emit({
            type: "metrics",
            turnId,
            stages: { endOfSpeechToCommit: commit.decidedAtMs - commit.endMs, finalPass: Math.round(now() - began) },
        });
    }

    // MARK: - Speaking

    speak(turnId: string, clauseId: number, text: string, step: boolean): void {
        this.session?.queue.accept(turnId, clauseId, text, step);
    }

    endAnswer(turnId: string): void {
        this.session?.queue.end(turnId);
    }

    async cancelAnswer(turnId: string): Promise<void> {
        const session = this.session;
        if (!session) return;
        session.queue.cancel(turnId);
        this.onDecisions(session, session.policy.handle({ type: "answerEnded", turnId }));
    }

    private onQueueEvent(session: Session, event: Parameters<ConstructorParameters<typeof ClauseQueue>[0]["emit"]>[0]): void {
        if (this.session !== session) return;
        this.emit(event);
        if (event.type === "clauseStarted") {
            this.onDecisions(session, session.policy.handle({ type: "clausePlaying", turnId: event.turnId }));
        } else if (event.type === "answerFinished") {
            session.gateUntilMs = session.nowMs + PLAYBACK_TAIL_MS;
            this.onDecisions(session, session.policy.handle({ type: "answerEnded", turnId: event.turnId }));
        }
    }
}
