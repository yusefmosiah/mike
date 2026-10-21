"use client";

import { errorCode, knownErrorCodeMessage } from "@/app/lib/userFacingError";

/**
 * The iPhone app's native voice engine, for hands-free voice chat
 * (docs/voice-chat.md; the interface is docs/voice-chat-contract.md). The
 * engine listens, decides when a turn ends and when the person speaks over the
 * answer, and plays the clauses this page sends it. It lives in the
 * `MikeSpeech` plugin; app builds without it, and browsers, have no voice mode.
 */

/** Thresholds the engine runs with; every field is optional and has the engine's default. */
export interface VoiceConfig {
    /** Speech probability, 0.5. */
    vadThreshold: number;
    /** Silence that opens the end-of-turn check, 250 ms. */
    pauseMs: number;
    /** At or above: the turn is complete, 0.5. */
    smartTurnThreshold: number;
    /** The turn ends whatever the models say, 2000 ms. */
    maxSilenceMs: number;
    /** Speech needed for a barge-in, 300 ms. */
    bargeInSpeechMs: number;
    /** Words not in the clause being played needed for a barge-in, 2. */
    bargeInWords: number;
    /** Speech without words after which playback resumes, 1500 ms. */
    falseStartMs: number;
    /** A single turn is cut here, 60000 ms (at most 120000; a larger value falls back to the default). */
    maxTurnMs: number;
}

export type VoiceEngineState = "listening" | "user-speaking" | "confirming-end" | "thinking" | "speaking";
const STATES: readonly VoiceEngineState[] = ["listening", "user-speaking", "confirming-end", "thinking", "speaking"];

export type VoiceEndReason = "stopped" | "interruption" | "route" | "error";
const END_REASONS: readonly VoiceEndReason[] = ["stopped", "interruption", "route", "error"];

export type VoiceEvent =
    | { type: "install"; fraction: number }
    | { type: "state"; state: VoiceEngineState }
    | { type: "partial"; text: string }
    | { type: "turn"; turnId: string; text: string; audioMs: number }
    | { type: "bargeIn"; turnId: string }
    | { type: "clauseStarted"; turnId: string; clauseId: number }
    | { type: "clausePlayed"; turnId: string; clauseId: number }
    | { type: "interrupted"; turnId: string; clauseId: number; fraction: number }
    | { type: "answerFinished"; turnId: string }
    | { type: "ended"; reason: VoiceEndReason }
    /** Stage timings in ms, by name (for example `micDroppedMs`); unknown names are kept. */
    | { type: "metrics"; turnId: string; stages: Record<string, number> };

export interface VoiceStatus {
    /** Every model voice mode needs is installed and this device can run it. */
    available: boolean;
    /** Models still to download ("vad", "eou", "smart-turn", "phonon", "fluid-mini"). */
    missing: string[];
    /** Their total size. */
    downloadBytes: number;
}

interface CapacitorBridge {
    PluginHeaders?: { name: string; methods?: { name: string }[] }[];
    addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => { remove: () => unknown };
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "MikeSpeech";

export const VOICE_UNAVAILABLE_MESSAGE = "Voice mode is not available on this iPhone.";
export const VOICE_START_FAILURE_MESSAGE = "Could not start voice mode. Please try again.";
export const VOICE_INSTALL_FAILURE_MESSAGE =
    "Could not download the speech models. Check the connection and try again.";
export const VOICE_MICROPHONE_MESSAGE =
    "The microphone is off for this app. Turn it on in the iPhone's Settings to talk.";
export const VOICE_REMOVE_FAILURE_MESSAGE = "Could not remove the voice mode models. Please try again.";
export const VOICE_BUSY_MESSAGE = "Turn off voice mode before removing its models.";
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "permission-denied": VOICE_MICROPHONE_MESSAGE,
    unavailable: VOICE_UNAVAILABLE_MESSAGE,
};

/** Why voice mode ended, for the person; null when they ended it themselves. */
export function endedMessage(reason: VoiceEndReason): string | null {
    switch (reason) {
        case "stopped":
            return null;
        case "interruption":
            return "Voice mode ended because a call or another app took over the audio.";
        case "route":
            return "Voice mode ended because the audio output changed.";
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

/** True in an app build whose plugin has the voice engine. */
export function voiceChatSupported(): boolean {
    const header = bridge()?.PluginHeaders?.find((entry) => entry.name === PLUGIN);
    return !!header?.methods?.some((method) => method.name === "voiceStatus");
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

function parseStatus(value: unknown): VoiceStatus {
    const result = record(value);
    return {
        available: result.available === true,
        missing: Array.isArray(result.missing) ? result.missing.filter((name): name is string => typeof name === "string") : [],
        downloadBytes: finite(result.downloadBytes) && result.downloadBytes > 0 ? result.downloadBytes : 0,
    };
}

/** What the engine can do now. Never rejects: anything wrong reads as unavailable. */
export async function voiceStatus(): Promise<VoiceStatus> {
    try {
        return parseStatus(await call("voiceStatus"));
    } catch {
        return { available: false, missing: [], downloadBytes: 0 };
    }
}

/**
 * Deletes voice mode's own models (VAD, end of utterance, Smart Turn) and
 * cancels an install in progress; Phonon has its own removal. Resolves the
 * status afterwards. Rejects while voice mode runs (`busy`).
 */
export async function voiceRemove(): Promise<VoiceStatus> {
    let result: unknown;
    try {
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
 * Downloads and prepares the missing models (call from the person's tap).
 * Progress arrives as `install` events. Resolves whether voice mode is now
 * available.
 */
export async function voiceInstall(): Promise<boolean> {
    try {
        return record(await call("voiceInstall")).available === true;
    } catch (error) {
        throw new VoiceEngineError(VOICE_INSTALL_FAILURE_MESSAGE, errorCode(error) ?? undefined);
    }
}

/** Starts listening; asks for the microphone if needed. `voice` is a Phonon voice. */
export async function voiceStart(options: { config: Partial<VoiceConfig>; voice?: string }): Promise<void> {
    try {
        await call("voiceStart", { config: options.config, ...(options.voice ? { voice: options.voice } : {}) });
    } catch (error) {
        throw new VoiceEngineError(
            knownErrorCodeMessage(error, ERROR_MESSAGES, VOICE_START_FAILURE_MESSAGE),
            errorCode(error) ?? undefined,
        );
    }
}

/** Releases the audio and ends any answer being spoken. Never rejects. */
export async function voiceStop(): Promise<void> {
    await call("voiceStop").catch(() => undefined);
}

/** Queues one clause of the answer to turn `turnId`. `text` is already speakable. */
export function voiceSpeak(turnId: string, clauseId: number, text: string, final?: boolean): void {
    call("voiceSpeak", { turnId, clauseId, text, ...(final ? { final: true } : {}) }).catch(() => undefined);
}

/** No more clauses for this turn; the engine listens again once the last one has played. */
export function voiceEndAnswer(turnId: string): void {
    call("voiceEndAnswer", { turnId }).catch(() => undefined);
}

/** Drops the turn's answer; resolves once playback has stopped. Never rejects. */
export async function voiceCancelAnswer(turnId: string): Promise<void> {
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
        case "state": {
            const state = STATES.find((known) => known === event.state);
            return state ? { type: "state", state } : null;
        }
        case "partial":
            return text(event.text) ? { type: "partial", text: event.text } : null;
        case "turn":
            return text(turnId) && text(event.text)
                ? { type: "turn", turnId, text: event.text, audioMs: finite(event.audioMs) ? event.audioMs : 0 }
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
    const cap = bridge();
    if (typeof cap?.addListener !== "function") return () => undefined;
    // Each subscription is its own entry, even for the same function.
    const entry = (event: VoiceEvent) => handler(event);
    handlers.add(entry);
    if (!listener) {
        listener = cap.addListener(PLUGIN, "voiceEvent", (data) => {
            const event = parseVoiceEvent(data);
            if (!event) return;
            for (const each of [...handlers]) each(event);
        });
    }
    return () => {
        if (!handlers.delete(entry)) return;
        if (handlers.size === 0) removeListener();
    };
}
