"use client";

import { errorCode, knownErrorCodeMessage } from "@/app/lib/userFacingError";
import { primeWebAudio } from "./web/prime";
import { webVoiceSupported } from "./web/support";
import type { WebVoiceBackend } from "./web/webBackend";

/**
 * The voice engine for hands-free voice chat (docs/voice-chat.md; the
 * interface is docs/voice-chat-contract.md). The engine listens, decides when
 * a turn ends and when the person speaks over the answer, and plays the
 * clauses this page sends it.
 *
 * Two backends sit behind the same functions and events. In the iPhone app
 * it is the native engine in the `MikeSpeech` plugin, and it always wins
 * where the plugin has it. In a plain browser it is the web engine
 * (web/webBackend.ts, docs/voice-web.md), imported only when voice mode
 * starts. App builds without the native engine (Android for now) have no
 * voice mode.
 */

/** Thresholds the engine runs with; every field is optional and has the engine's default. */
export interface VoiceConfig {
    /** Speech probability, 0.5. */
    vadThreshold: number;
    /** Silence that opens the end-of-turn check, 500 ms. */
    pauseMs: number;
    /** At or above: the turn is complete, 0.6 (below, asked again as the silence goes on). */
    smartTurnThreshold: number;
    /** The turn ends whatever the models say, 3000 ms. */
    maxSilenceMs: number;
    /** Speech resumed this soon after a turn continues it (`turn.continues`), 3000 ms; 0 is off. */
    continueMs: number;
    /** Speech needed for a barge-in, 300 ms. */
    bargeInSpeechMs: number;
    /** Speech needed to hold playback before any words, 700 ms. */
    holdSpeechMs: number;
    /** Speech probability needed to start while the answer is awaited or playing, 0.7. */
    bargeInVadThreshold: number;
    /** Words not in the clause being played needed for a barge-in, 2. */
    bargeInWords: number;
    /** Speech without words after which playback resumes, 1500 ms. */
    falseStartMs: number;
    /** A single turn is cut here, 60000 ms (at most 120000; a larger value falls back to the default). */
    maxTurnMs: number;
    /**
     * Without Smart Turn, the silence that ends the turn: 1500 ms in the
     * iPhone app while Smart Turn loads, 900 ms in a browser (where phase 1
     * has no Smart Turn); never more than `maxSilenceMs`.
     */
    fallbackSilenceMs: number;
    /**
     * The speaker model that decides whether speech is the person's, "wespeaker";
     * "both" decides in the two models' joined space, "off" checks and learns nothing.
     */
    speakerModel: "wespeaker" | "campplus" | "both" | "off";
    /**
     * Once the person's voice is learned, speech with a WeSpeaker score below
     * this is another voice and neither interrupts nor is sent, 0.35.
     */
    speakerThreshold: number;
    /** The same for CAM++, 0.39. */
    campplusThreshold: number;
}

export type VoiceEngineState = "listening" | "user-speaking" | "confirming-end" | "thinking" | "speaking";
const STATES: readonly VoiceEngineState[] = ["listening", "user-speaking", "confirming-end", "thinking", "speaking"];

export type VoiceEndReason = "stopped" | "interruption" | "route" | "error";
const END_REASONS: readonly VoiceEndReason[] = ["stopped", "interruption", "route", "error"];

export type VoiceEvent =
    | { type: "install"; fraction: number }
    /** Voice mode's models started or finished preparing for this phone (see `VoiceStatus.preparing`). */
    | ({ type: "preparation" } & VoicePreparation)
    | { type: "state"; state: VoiceEngineState }
    | { type: "partial"; text: string }
    /**
     * `continues`: the turn before, which the person went on from; `text` is
     * then the whole prompt, that turn's words and the new ones.
     */
    | { type: "turn"; turnId: string; text: string; audioMs: number; continues?: string }
    | { type: "bargeIn"; turnId: string }
    | { type: "clauseStarted"; turnId: string; clauseId: number }
    | { type: "clausePlayed"; turnId: string; clauseId: number }
    | { type: "interrupted"; turnId: string; clauseId: number; fraction: number }
    | { type: "answerFinished"; turnId: string }
    | { type: "ended"; reason: VoiceEndReason }
    /** A finished turn was not sent: it was in another voice ("other-voice"). */
    | { type: "ignored"; reason: string }
    /** Stage timings in ms, by name (for example `micDroppedMs`); unknown names are kept. */
    | { type: "metrics"; turnId: string; stages: Record<string, number> };

/**
 * What voice mode's models are doing for this phone. The first load after an
 * install or an update is slow (the phone compiles each model once and keeps
 * the result); the app does it in the background as early as it can.
 */
export interface VoicePreparation {
    /** Models are loading or warming now. */
    preparing: boolean;
    /** This is that first, slow preparation (after an install, an update, or with cold caches). */
    firstTime: boolean;
    /** Models loaded and warm ("vad", "smart-turn", "eou", "speaker", "phonon", "fluid-mini"). */
    ready: string[];
}

export interface VoiceStatus extends VoicePreparation {
    /** Every model voice mode needs is installed and this device can run it. */
    available: boolean;
    /** Models still to download ("vad", "eou", "smart-turn", "speaker", "speaker-campplus", "phonon", "fluid-mini"). */
    missing: string[];
    /** Their total size. */
    downloadBytes: number;
    /** Voice mode has learned the person's voice and ignores other voices. */
    speakerLearned: boolean;
    /** In a browser: how voice mode runs here, in a sentence. */
    sentence?: string;
    /** In a browser: the downloads, in minutes (said as "about N minutes", never as a size). */
    downloadMinutes?: number;
    /** In a browser: why voice mode cannot run here, written for the person. */
    unavailableMessage?: string;
}

interface CapacitorBridge {
    PluginHeaders?: { name: string; methods?: { name: string }[] }[];
    addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => { remove: () => unknown };
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "MikeSpeech";

export const VOICE_UNAVAILABLE_MESSAGE = "Voice mode is not available on this phone.";
export const VOICE_START_FAILURE_MESSAGE = "Could not start voice mode. Please try again.";
export const VOICE_INSTALL_FAILURE_MESSAGE =
    "Could not download the speech models. Check the connection and try again.";
export const VOICE_MICROPHONE_MESSAGE =
    "The microphone is off for this app. Turn it on in the phone's settings to talk.";
export const VOICE_REMOVE_FAILURE_MESSAGE = "Could not remove the voice mode models. Please try again.";
export const VOICE_BUSY_MESSAGE = "Turn off voice mode before removing its models.";
export const VOICE_FORGET_FAILURE_MESSAGE = "Could not forget your voice. Please try again.";
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "permission-denied": VOICE_MICROPHONE_MESSAGE,
    unavailable: VOICE_UNAVAILABLE_MESSAGE,
};

export const WEB_VOICE_UNAVAILABLE_MESSAGE = "Voice mode is not available in this browser.";
export const WEB_VOICE_MICROPHONE_MESSAGE =
    "This site is not allowed to use the microphone. Allow it in the browser’s site settings (usually the icon beside the address), then try again.";
export const WEB_VOICE_NO_MICROPHONE_MESSAGE = "No microphone was found. Connect one, or check that no other app is using it, then try again.";
const WEB_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "permission-denied": WEB_VOICE_MICROPHONE_MESSAGE,
    "no-microphone": WEB_VOICE_NO_MICROPHONE_MESSAGE,
    unavailable: WEB_VOICE_UNAVAILABLE_MESSAGE,
};

/** "Voice mode is not available" for this device: the phone, or this browser. */
export function voiceUnavailableMessage(): string {
    return backend() === "web" ? WEB_VOICE_UNAVAILABLE_MESSAGE : VOICE_UNAVAILABLE_MESSAGE;
}

/** Why voice mode ended, for the person; null when they ended it themselves. */
export function endedMessage(reason: VoiceEndReason): string | null {
    switch (reason) {
        case "stopped":
            return null;
        case "interruption":
            return "Voice mode ended because a call or another app took over the audio.";
        case "route":
            return backend() === "web"
                ? "Voice mode ended because the microphone was disconnected."
                : "Voice mode ended because the audio output changed.";
        case "error":
            return "Voice mode stopped because of a problem. Please try again.";
    }
}

/** A failure with a message written for the person; `code` is the plugin's, when it sent one. */
export class VoiceEngineError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

function bridge(): CapacitorBridge | null {
    if (typeof window === "undefined") return null;
    const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
    if (typeof cap?.nativePromise !== "function") return null;
    return cap;
}

function hasMethod(name: string): boolean {
    const header = bridge()?.PluginHeaders?.find((entry) => entry.name === PLUGIN);
    return !!header?.methods?.some((method) => method.name === name);
}

/**
 * Which engine voice mode uses here: the app's native engine where its plugin
 * has it, the web engine in a plain browser that can run it, none otherwise
 * (an app build without the native engine, or an old browser).
 */
export function backend(): "native" | "web" | null {
    if (hasMethod("voiceStatus")) return "native";
    if (typeof window === "undefined") return null;
    // Inside the app shell the web engine is not offered: the shell's web
    // view is not a browser the web engine was built for.
    if ((window as unknown as { Capacitor?: unknown }).Capacitor) return null;
    return webVoiceSupported() ? "web" : null;
}

/** True in an app build whose plugin has the voice engine, and in a browser that can run voice mode. */
export function voiceChatSupported(): boolean {
    return backend() !== null;
}

/** The web engine, created on first use (its module is imported then). */
let webEngine: Promise<WebVoiceBackend> | null = null;
function web(): Promise<WebVoiceBackend> {
    webEngine ??= import("./web/webBackend")
        .then(({ WebVoiceBackend }) => new WebVoiceBackend(emit))
        .catch((error: unknown) => {
            webEngine = null;
            throw error;
        });
    return webEngine;
}

/** The web engine if voice mode has already loaded it; for calls that need nothing new. */
function loadedWeb(): Promise<WebVoiceBackend> | null {
    return backend() === "web" ? webEngine : null;
}

/**
 * Call synchronously inside the tap that starts voice mode (or installs its
 * models), before anything is awaited: in a browser it unlocks audio, which
 * browsers allow only from a tap. The app's engine needs nothing.
 */
export function voicePrime(): void {
    if (backend() === "web") primeWebAudio();
}

/** True when the app can open the system's microphone modes (Voice Isolation). */
export function voiceMicrophoneModesSupported(): boolean {
    return voiceChatSupported() && hasMethod("voiceMicrophoneModes");
}

/** True when the app can forget the learned voice. */
export function voiceForgetSpeakerSupported(): boolean {
    return voiceChatSupported() && hasMethod("voiceForgetSpeaker");
}

function call(method: string, options?: Record<string, unknown>): Promise<unknown> {
    const cap = bridge();
    if (!cap || !voiceChatSupported()) return Promise.reject(new VoiceEngineError(VOICE_UNAVAILABLE_MESSAGE, "unavailable"));
    return cap.nativePromise!(PLUGIN, method, options);
}

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const unit = (value: number) => Math.min(1, Math.max(0, value));

/** The preparation fields of a status or an event; an app build without them reads as idle. */
function parsePreparation(result: Record<string, unknown>): VoicePreparation {
    return {
        preparing: result.preparing === true,
        firstTime: result.firstTime === true,
        ready: Array.isArray(result.ready) ? result.ready.filter((name): name is string => typeof name === "string") : [],
    };
}

function parseStatus(value: unknown): VoiceStatus {
    const result = record(value);
    return {
        ...parsePreparation(result),
        available: result.available === true,
        missing: Array.isArray(result.missing) ? result.missing.filter((name): name is string => typeof name === "string") : [],
        downloadBytes: finite(result.downloadBytes) && result.downloadBytes > 0 ? result.downloadBytes : 0,
        speakerLearned: result.speakerLearned === true,
    };
}

/** What the engine can do now. Never rejects: anything wrong reads as unavailable. */
export async function voiceStatus(): Promise<VoiceStatus> {
    try {
        if (backend() === "web") return await (await web()).status();
        return parseStatus(await call("voiceStatus"));
    } catch {
        return { available: false, missing: [], downloadBytes: 0, speakerLearned: false, ...parsePreparation({}) };
    }
}

/**
 * Deletes voice mode's own models (VAD, end of utterance, Smart Turn, the
 * speaker model) and the learned voice, and cancels an install in progress;
 * Phonon has its own removal. Resolves the
 * status afterwards. Rejects while voice mode runs (`busy`).
 */
export async function voiceRemove(): Promise<VoiceStatus> {
    let result: unknown;
    try {
        if (backend() === "web") return await (await web()).remove();
        result = await call("voiceRemove");
    } catch (error) {
        throw new VoiceEngineError(
            knownErrorCodeMessage(error, { busy: VOICE_BUSY_MESSAGE }, VOICE_REMOVE_FAILURE_MESSAGE),
            errorCode(error) ?? undefined,
        );
    }
    return parseStatus(result);
}

/**
 * Forgets the person's learned voice; voice mode learns it again from their
 * next turns. Works while voice mode runs. Resolves the status afterwards.
 */
export async function voiceForgetSpeaker(): Promise<VoiceStatus> {
    try {
        return parseStatus(await call("voiceForgetSpeaker"));
    } catch (error) {
        throw new VoiceEngineError(VOICE_FORGET_FAILURE_MESSAGE, errorCode(error) ?? undefined);
    }
}

/**
 * Opens the system's microphone modes, where Voice Isolation filters out
 * other sounds. The phone lists them only while voice mode has the microphone.
 * Never rejects.
 */
export async function voiceMicrophoneModes(): Promise<void> {
    await call("voiceMicrophoneModes").catch(() => undefined);
}

/**
 * Downloads and prepares the missing models (call from the person's tap).
 * Progress arrives as `install` events. Resolves whether voice mode is now
 * available.
 */
export async function voiceInstall(): Promise<boolean> {
    try {
        if (backend() === "web") return await (await web()).install();
        return record(await call("voiceInstall")).available === true;
    } catch (error) {
        throw new VoiceEngineError(VOICE_INSTALL_FAILURE_MESSAGE, errorCode(error) ?? undefined);
    }
}

/** Starts listening; asks for the microphone if needed. `voice` is a Phonon voice. */
export async function voiceStart(options: { config: Partial<VoiceConfig>; voice?: string }): Promise<void> {
    const inBrowser = backend() === "web";
    try {
        if (inBrowser) await (await web()).start(options.config, options.voice);
        else await call("voiceStart", { config: options.config, ...(options.voice ? { voice: options.voice } : {}) });
    } catch (error) {
        throw new VoiceEngineError(
            knownErrorCodeMessage(error, inBrowser ? WEB_ERROR_MESSAGES : ERROR_MESSAGES, VOICE_START_FAILURE_MESSAGE),
            errorCode(error) ?? undefined,
        );
    }
}

const USED_KEY = "mike.voice.used";
let prewarmed = false;

/**
 * Remembers that the person has started voice mode on this phone, so the app
 * loads its models ahead of the next start (see `voicePrewarm`).
 */
export function markVoiceUsed(): void {
    try {
        window.localStorage.setItem(USED_KEY, "1");
    } catch {
        // Storage can be blocked; the models then load at the tap, as before.
    }
}

/**
 * Asks the phone to load and warm voice mode's models in the background, so
 * the tap finds them ready: loading them takes tens of seconds, and the
 * phone keeps them for later starts. Once per app run, and only for someone
 * who has used voice mode before (the models take memory). Never rejects;
 * app builds without `voicePrewarm` ignore it.
 */
export function voicePrewarm(config: Partial<VoiceConfig> = {}): void {
    if (prewarmed || !hasMethod("voicePrewarm")) return;
    try {
        if (window.localStorage.getItem(USED_KEY) !== "1") return;
    } catch {
        return;
    }
    prewarmed = true;
    void call("voicePrewarm", { config }).catch(() => {
        prewarmed = false;
    });
}

/** Releases the audio and ends any answer being spoken. Never rejects. */
export async function voiceStop(): Promise<void> {
    const engine = loadedWeb();
    if (engine) {
        await engine.then((loaded) => loaded.stop()).catch(() => undefined);
        return;
    }
    if (backend() === "web") return;
    await call("voiceStop").catch(() => undefined);
}

/** Queues one clause of the answer to turn `turnId`. `text` is already speakable. */
export function voiceSpeak(turnId: string, clauseId: number, text: string, final?: boolean): void {
    if (backend() === "web") {
        void loadedWeb()?.then((engine) => engine.speak(turnId, clauseId, text, false)).catch(() => undefined);
        return;
    }
    call("voiceSpeak", { turnId, clauseId, text, ...(final ? { final: true } : {}) }).catch(() => undefined);
}

/**
 * Queues a step said while the answer works (spokenSteps.ts): a clause of the
 * turn that the engine marks with a soft cue, says a little quieter, and fades
 * out when the answer's next clause arrives. An engine without steps speaks
 * it as an ordinary clause.
 */
export function voiceSpeakStep(turnId: string, clauseId: number, text: string): void {
    if (backend() === "web") {
        void loadedWeb()?.then((engine) => engine.speak(turnId, clauseId, text, true)).catch(() => undefined);
        return;
    }
    call("voiceSpeak", { turnId, clauseId, text, kind: "step" }).catch(() => undefined);
}

/** No more clauses for this turn; the engine listens again once the last one has played. */
export function voiceEndAnswer(turnId: string): void {
    if (backend() === "web") {
        void loadedWeb()?.then((engine) => engine.endAnswer(turnId)).catch(() => undefined);
        return;
    }
    call("voiceEndAnswer", { turnId }).catch(() => undefined);
}

/** Drops the turn's answer; resolves once playback has stopped. Never rejects. */
export async function voiceCancelAnswer(turnId: string): Promise<void> {
    if (backend() === "web") {
        await loadedWeb()?.then((engine) => engine.cancelAnswer(turnId)).catch(() => undefined);
        return;
    }
    await call("voiceCancelAnswer", { turnId }).catch(() => undefined);
}

const text = (value: unknown): value is string => typeof value === "string";
const clauseId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** An engine event, or null for anything this page does not understand. */
export function parseVoiceEvent(data: unknown): VoiceEvent | null {
    const event = record(data);
    const { turnId } = event;
    switch (event.type) {
        case "install":
            return finite(event.fraction) ? { type: "install", fraction: unit(event.fraction) } : null;
        case "preparation":
            return { type: "preparation", ...parsePreparation(event) };
        case "state": {
            const state = STATES.find((known) => known === event.state);
            return state ? { type: "state", state } : null;
        }
        case "partial":
            return text(event.text) ? { type: "partial", text: event.text } : null;
        case "turn":
            return text(turnId) && text(event.text)
                ? {
                      type: "turn",
                      turnId,
                      text: event.text,
                      audioMs: finite(event.audioMs) ? event.audioMs : 0,
                      ...(text(event.continues) && event.continues ? { continues: event.continues } : {}),
                  }
                : null;
        case "bargeIn":
        case "answerFinished":
            return text(turnId) ? { type: event.type, turnId } : null;
        case "clauseStarted":
        case "clausePlayed":
            return text(turnId) && clauseId(event.clauseId) ? { type: event.type, turnId, clauseId: event.clauseId } : null;
        case "interrupted":
            return text(turnId) && clauseId(event.clauseId)
                ? {
                      type: "interrupted",
                      turnId,
                      clauseId: event.clauseId,
                      fraction: finite(event.fraction) ? unit(event.fraction) : 0,
                  }
                : null;
        case "ended": {
            const reason = END_REASONS.find((known) => known === event.reason);
            return { type: "ended", reason: reason ?? "error" };
        }
        case "ignored":
            return { type: "ignored", reason: text(event.reason) ? event.reason : "other-voice" };
        case "metrics": {
            const stages = Object.fromEntries(Object.entries(record(event.stages)).filter(([, value]) => finite(value)));
            return text(turnId) ? { type: "metrics", turnId, stages: stages as Record<string, number> } : null;
        }
        default:
            return null;
    }
}

/** The one native listener, shared by every subscriber while any is left. */
let listener: { remove: () => unknown } | null = null;
const handlers = new Set<(event: VoiceEvent) => void>();

function removeListener(): void {
    const current = listener;
    listener = null;
    try {
        void Promise.resolve(current?.remove()).catch(() => undefined);
    } catch {
        // The bridge is gone; there is nothing left to remove.
    }
}

/**
 * Hears the engine's events. Any number of handlers may listen at once (voice
 * mode, and one waiting for an answer's last `interrupted` as it ends); the
 * bridge holds a single listener for them all. Returns the function that
 * removes this handler.
 */
export function onVoiceEvent(handler: (event: VoiceEvent) => void): () => void {
    const inBrowser = backend() === "web";
    const cap = inBrowser ? null : bridge();
    if (!inBrowser && typeof cap?.addListener !== "function") return () => undefined;
    // Each subscription is its own entry, even for the same function.
    const entry = (event: VoiceEvent) => handler(event);
    handlers.add(entry);
    if (cap?.addListener && !listener) {
        listener = cap.addListener(PLUGIN, "voiceEvent", (data) => {
            const event = parseVoiceEvent(data);
            if (event) emit(event);
        });
    }
    return () => {
        if (!handlers.delete(entry)) return;
        if (handlers.size === 0 && listener) removeListener();
    };
}

/** Hands an engine event to every handler (the web engine calls this directly). */
function emit(event: VoiceEvent): void {
    for (const each of [...handlers]) each(event);
}
