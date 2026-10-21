"use client";

import { errorCode, knownErrorCodeMessage } from "@/app/lib/userFacingError";

/**
 * Dictation with Apple's speech recognition on the phone, in Mike's iPhone
 * app (mobile/plugins/speech). The app's native shell gives this page the
 * `MikeSpeech` plugin through the Capacitor bridge; a browser has no bridge,
 * so the engine is offered only inside the app. The clip recorded for
 * dictation is handed to the phone and transcribed there: nothing goes to
 * Mike's backend or to Apple.
 */

export type DeviceSpeechState = "available" | "downloadable" | "downloading" | "unavailable";

interface CapacitorBridge {
    PluginHeaders?: { name: string; methods?: { name: string }[] }[];
    addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => { remove: () => unknown };
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "MikeSpeech";
const STATES: readonly DeviceSpeechState[] = ["available", "downloadable", "downloading", "unavailable"];

export const DEVICE_TRANSCRIBE_FAILURE_MESSAGE =
    "Could not transcribe the recording on this iPhone. Please try again.";
const DEVICE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "not-installed": "Download Apple's speech model in Settings → Voice to dictate on this iPhone.",
    unavailable: "This iPhone cannot transcribe this language on the device.",
    "permission-denied": "Speech recognition is turned off for this app in the iPhone's Settings.",
    "unsupported-audio": "This recording format cannot be transcribed on this iPhone.",
    "too-long": "The recording is too long to transcribe on this iPhone.",
};

/** A failure with a message written for the user. */
export class DeviceSpeechError extends Error {}

function nativePromise(): NonNullable<CapacitorBridge["nativePromise"]> | null {
    if (typeof window === "undefined") return null;
    const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
    if (typeof cap?.nativePromise !== "function") return null;
    if (!cap.PluginHeaders?.some((header) => header.name === PLUGIN)) return null;
    return cap.nativePromise.bind(cap);
}

/** True inside Mike's iPhone app, whose shell has the speech plugin. */
export function deviceSpeechSupported(): boolean {
    return nativePromise() !== null;
}

/**
 * True when the app's plugin can also read aloud with Apple's voices (app
 * builds before 2026-10-11 can only transcribe).
 */
export function deviceVoiceSupported(): boolean {
    if (!nativePromise()) return false;
    const cap = (window as unknown as { Capacitor: CapacitorBridge }).Capacitor;
    const header = cap.PluginHeaders?.find((entry) => entry.name === PLUGIN);
    return !!header?.methods?.some((method) => method.name === "speak");
}

function stateOf(result: unknown): DeviceSpeechState {
    const state = result && typeof result === "object" ? (result as { state?: unknown }).state : undefined;
    return STATES.find((known) => known === state) ?? "unavailable";
}

const languageOption = (language?: string) => (language ? { language } : {});

/**
 * Whether the phone can transcribe `language` (default: the phone's own):
 * "available" now, "downloadable" after Apple's speech model downloads, or
 * "unavailable".
 */
export async function deviceSpeechStatus(language?: string): Promise<DeviceSpeechState> {
    const call = nativePromise();
    if (!call) return "unavailable";
    try {
        return stateOf(await call(PLUGIN, "status", languageOption(language)));
    } catch {
        return "unavailable";
    }
}

/** Downloads Apple's speech model for the language; call from a user's click. */
export async function installDeviceSpeech(language?: string): Promise<DeviceSpeechState> {
    const call = nativePromise();
    if (!call) return "unavailable";
    try {
        return stateOf(await call(PLUGIN, "install", languageOption(language)));
    } catch {
        return deviceSpeechStatus(language);
    }
}

async function toBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    // Chunked: String.fromCharCode over a whole recording overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** The `engine` value that asks the plugin for Fluid Speech Mini. */
export const FLUID_MINI_ENGINE = "fluid-mini";

/** Which recogniser the "device" dictation engine uses, stored as its `model`. */
export type DeviceDictationModel = "fluid-speech-mini" | "apple";
export const DEVICE_DICTATION_MODELS: readonly DeviceDictationModel[] = ["fluid-speech-mini", "apple"];

/** True when the language is English (an unset one is the phone's own). */
export function isEnglishLanguage(language?: string): boolean {
    const tag = language || (typeof navigator !== "undefined" ? navigator.language : "") || "en";
    return /^en([-_]|$)/i.test(tag);
}

/** The `engine` value that asks the plugin for Phonon. */
export const PHONON_ENGINE = "phonon";

/** Which voices the "device" read-aloud engine uses, stored as its `model`. */
export type DeviceSpeechModel = "phonon" | "apple";
export const DEVICE_SPEECH_MODELS: readonly DeviceSpeechModel[] = ["phonon", "apple"];

/**
 * Phonon on the phone: `not-installed` (its model is not downloaded yet),
 * `installing`, `available`, or `unavailable` (iOS before 18, an app build
 * without it, or no download source in this build).
 */
export type PhononState = "not-installed" | "installing" | "available" | "unavailable";
const PHONON_STATES: readonly PhononState[] = ["not-installed", "installing", "available", "unavailable"];

export interface PhononStatus {
    state: PhononState;
    /** While installing: the fraction downloaded, 0 to 1. */
    progress?: number;
    /** True when the first reading will first compile the models (about 10 seconds). */
    compiling?: boolean;
}

const UNAVAILABLE: PhononStatus = { state: "unavailable" };

function phononStatusOf(result: unknown): PhononStatus {
    // An older app build ignores `engine` and answers about Apple's recognizer.
    if (!result || typeof result !== "object" || (result as { engine?: unknown }).engine !== PHONON_ENGINE) {
        return UNAVAILABLE;
    }
    const { state, progress, compiling } = result as { state?: unknown; progress?: unknown; compiling?: unknown };
    const known = PHONON_STATES.find((candidate) => candidate === state);
    if (!known) return UNAVAILABLE;
    return {
        state: known,
        ...(typeof progress === "number" && Number.isFinite(progress) ? { progress: Math.min(1, Math.max(0, progress)) } : {}),
        ...(compiling === true ? { compiling: true } : {}),
    };
}

/** Whether Phonon can read aloud on this phone now, and how far its download is. */
export async function phononStatus(): Promise<PhononStatus> {
    const call = nativePromise();
    if (!call) return UNAVAILABLE;
    try {
        return phononStatusOf(await call(PLUGIN, "status", { engine: PHONON_ENGINE }));
    } catch {
        return UNAVAILABLE;
    }
}

let phononInstalled: Promise<boolean> | null = null;

/**
 * True when Phonon's model is downloaded and the app can use it. A positive
 * answer is kept (reading aloud asks for every sentence); a negative one is
 * asked again.
 */
export function phononAvailable(): Promise<boolean> {
    if (phononInstalled) return phononInstalled;
    const asked = phononStatus().then((status) => status.state === "available");
    phononInstalled = asked;
    void asked.then((ok) => {
        if (!ok && phononInstalled === asked) phononInstalled = null;
    });
    return asked;
}

/** Forgets the cached answer of `phononAvailable` (after a download or a removal, and tests). */
export function resetPhononAvailability(): void {
    phononInstalled = null;
}

export const PHONON_INSTALL_FAILURE_MESSAGE = "Could not download the voice model. Check the connection and try again.";

/**
 * Downloads Phonon's model onto the phone (call from the person's click).
 * `onProgress` hears the fraction downloaded, from the plugin's status, until
 * the download ends. Resolves with the new status.
 */
export async function installPhonon(onProgress?: (fraction: number) => void): Promise<PhononStatus> {
    const call = nativePromise();
    if (!call) throw new DeviceSpeechError(PHONON_INSTALL_FAILURE_MESSAGE);
    let polling = true;
    const poll = async () => {
        while (polling) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!polling) return;
            const { state, progress } = await phononStatus();
            if (polling && state === "installing" && progress !== undefined) onProgress?.(progress);
        }
    };
    void poll();
    try {
        await call(PLUGIN, "install", { engine: PHONON_ENGINE });
    } catch {
        throw new DeviceSpeechError(PHONON_INSTALL_FAILURE_MESSAGE);
    } finally {
        polling = false;
    }
    resetPhononAvailability();
    const status = await phononStatus();
    if (status.state !== "available") throw new DeviceSpeechError(PHONON_INSTALL_FAILURE_MESSAGE);
    return status;
}

export const PHONON_BUSY_MESSAGE = "Turn off voice mode before removing Phonon.";

/** Deletes Phonon's model from the phone; reading aloud then uses Apple's voices. */
export async function removePhonon(): Promise<PhononStatus> {
    const call = nativePromise();
    if (!call) return UNAVAILABLE;
    try {
        await call(PLUGIN, "remove", { engine: PHONON_ENGINE });
    } catch (error) {
        // Voice mode is reading with Phonon: nothing was removed.
        if (errorCode(error) === "busy") throw new DeviceSpeechError(PHONON_BUSY_MESSAGE);
        // Otherwise the status below says what is left.
    }
    resetPhononAvailability();
    return phononStatus();
}

let fluidAvailable: Promise<boolean> | null = null;

/**
 * True when the app has Fluid Speech Mini: a build whose plugin knows the
 * `engine` option (an older build ignores it and answers with Apple's status,
 * whose `engine` is not "fluid-mini"), on iOS 18 or later, with the model in
 * the bundle. A positive answer is kept; a negative one is asked again.
 */
export function fluidSpeechMiniAvailable(): Promise<boolean> {
    if (fluidAvailable) return fluidAvailable;
    const call = nativePromise();
    if (!call) return Promise.resolve(false);
    const asked = call(PLUGIN, "status", { engine: FLUID_MINI_ENGINE }).then(
        (result) =>
            stateOf(result) === "available" &&
            (result as { engine?: unknown }).engine === FLUID_MINI_ENGINE,
        () => false,
    );
    fluidAvailable = asked;
    void asked.then((ok) => {
        if (!ok && fluidAvailable === asked) fluidAvailable = null;
    });
    return asked;
}

/**
 * Asks the app to load Fluid Speech Mini now, while the person speaks, so the
 * transcription does not wait for it. Fire and forget: an app build without
 * `prepare` refuses the call, and the transcription then loads the model.
 */
export function prepareFluidSpeechMini(): void {
    const call = nativePromise();
    if (!call) return;
    call(PLUGIN, "prepare", { engine: FLUID_MINI_ENGINE }).catch(() => undefined);
}

/** Forgets the cached answer of `fluidSpeechMiniAvailable` (tests). */
export function resetFluidSpeechMiniAvailability(): void {
    fluidAvailable = null;
}

/**
 * Transcribes a recording on the phone: with Apple's recognizer, or with
 * Fluid Speech Mini when `engine` is `FLUID_MINI_ENGINE` (English only; it
 * ignores `language` and `vocabulary`). `vocabulary` (up to 100 names and
 * terms) is passed to Apple's recognizer as contextual strings; an app build
 * from before that ignores it.
 */
export async function transcribeOnDevice(
    blob: Blob,
    language?: string,
    engine?: typeof FLUID_MINI_ENGINE,
    vocabulary?: readonly string[],
): Promise<string> {
    const call = nativePromise();
    if (!call) throw new DeviceSpeechError(DEVICE_ERROR_MESSAGES.unavailable);
    let result: unknown;
    try {
        result = await call(PLUGIN, "transcribe", {
            audio: await toBase64(blob),
            mimeType: blob.type,
            ...(engine ? { engine } : languageOption(language)),
            // Apple's recognizer leans toward these spellings; Fluid Speech
            // Mini ignores them (the vocabulary matcher still corrects its text).
            ...(!engine && vocabulary?.length ? { vocabulary: [...vocabulary] } : {}),
        });
    } catch (error) {
        throw new DeviceSpeechError(knownErrorCodeMessage(error, DEVICE_ERROR_MESSAGES, DEVICE_TRANSCRIBE_FAILURE_MESSAGE));
    }
    const text = result && typeof result === "object" ? (result as { text?: unknown }).text : undefined;
    return typeof text === "string" ? text : "";
}

export interface DeviceVoice {
    id: string;
    name: string;
    language: string;
    /** "default", "enhanced" or "premium" (downloaded in the iPhone's Settings). */
    quality: string;
}

/** The voices installed on the phone, best first within each language. */
export async function deviceVoices(): Promise<DeviceVoice[]> {
    const call = nativePromise();
    if (!call) return [];
    try {
        const result = await call(PLUGIN, "voices");
        const voices = result && typeof result === "object" ? (result as { voices?: unknown }).voices : undefined;
        if (!Array.isArray(voices)) return [];
        return voices.filter(
            (voice): voice is DeviceVoice =>
                !!voice &&
                typeof voice === "object" &&
                typeof (voice as DeviceVoice).id === "string" &&
                typeof (voice as DeviceVoice).name === "string" &&
                typeof (voice as DeviceVoice).language === "string",
        ).map((voice) => ({ ...voice, quality: typeof voice.quality === "string" ? voice.quality : "default" }));
    } catch {
        return [];
    }
}

export const DEVICE_SPEAK_FAILURE_MESSAGE = "Could not read this aloud on this iPhone. Please try again.";
const DEVICE_SPEAK_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "too-long": "This is too long to read aloud on this iPhone at once.",
    busy: "Read-aloud is off while voice mode is on.",
};

/**
 * `text` spoken as a WAV file by one of Apple's voices on the phone, or, with
 * `engine` `PHONON_ENGINE`, by Phonon (English, once downloaded; `voice` is
 * then a Phonon voice name).
 */
export async function speakOnDevice(text: string, voice?: string, engine?: typeof PHONON_ENGINE): Promise<Blob> {
    const call = nativePromise();
    if (!call) throw new DeviceSpeechError(DEVICE_SPEAK_FAILURE_MESSAGE);
    let result: unknown;
    try {
        result = await call(PLUGIN, "speak", { text, ...(voice ? { voice } : {}), ...(engine ? { engine } : {}) });
    } catch (error) {
        throw new DeviceSpeechError(knownErrorCodeMessage(error, DEVICE_SPEAK_ERROR_MESSAGES, DEVICE_SPEAK_FAILURE_MESSAGE));
    }
    const audio = result && typeof result === "object" ? (result as { audio?: unknown }).audio : undefined;
    if (typeof audio !== "string" || !audio) throw new DeviceSpeechError(DEVICE_SPEAK_FAILURE_MESSAGE);
    const binary = atob(audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "audio/wav" });
}

let liveAvailable: Promise<boolean> | null = null;

/**
 * True when the app can transcribe while the person speaks: Fluid Speech Mini
 * is available and its status says `live` (an app build from before live
 * dictation leaves that out). A positive answer is kept; a negative one is
 * asked again.
 */
export function liveDictationAvailable(): Promise<boolean> {
    if (liveAvailable) return liveAvailable;
    const call = nativePromise();
    if (!call) return Promise.resolve(false);
    const asked = call(PLUGIN, "status", { engine: FLUID_MINI_ENGINE }).then(
        (result) =>
            stateOf(result) === "available" &&
            (result as { engine?: unknown }).engine === FLUID_MINI_ENGINE &&
            (result as { live?: unknown }).live === true,
        () => false,
    );
    liveAvailable = asked;
    void asked.then((ok) => {
        if (!ok && liveAvailable === asked) liveAvailable = null;
    });
    return asked;
}

/** Forgets the cached answer of `liveDictationAvailable` (tests). */
export function resetLiveDictationAvailability(): void {
    liveAvailable = null;
}

/** What the app reports while a live dictation runs. */
export type LiveDictationEvent =
    /** The whole text so far: `confirmed` will not change, `volatile` may. `ended` when an interruption stopped the dictation. */
    | { kind: "text"; confirmed: string; volatile: string; ended: boolean }
    /** The input level, 0 to 1. */
    | { kind: "level"; level: number };

/** A live dictation failure; `code` is the plugin's rejection code when it sent one. */
export class LiveDictationError extends DeviceSpeechError {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

export const LIVE_START_FAILURE_MESSAGE = "Could not start recording. Please try again.";

function liveEventOf(data: unknown): LiveDictationEvent | null {
    if (!data || typeof data !== "object") return null;
    const { confirmed, volatile, level, ended } = data as Record<string, unknown>;
    if (typeof confirmed === "string" || typeof volatile === "string") {
        return {
            kind: "text",
            confirmed: typeof confirmed === "string" ? confirmed : "",
            volatile: typeof volatile === "string" ? volatile : "",
            ended: ended === true,
        };
    }
    if (typeof level === "number" && Number.isFinite(level)) {
        return { kind: "level", level: Math.min(1, Math.max(0, level)) };
    }
    return null;
}

let liveListener: { remove: () => unknown } | null = null;

function removeLiveListener(): void {
    const listener = liveListener;
    liveListener = null;
    try {
        void Promise.resolve(listener?.remove()).catch(() => undefined);
    } catch {
        // The bridge is gone; there is nothing left to remove.
    }
}

/**
 * Starts recording on the phone and transcribing as the person speaks;
 * `onEvent` hears the text so far and the input level. Resolves once
 * recording has started. Rejects with a `LiveDictationError` whose `code` is
 * `permission-denied` when the microphone is off for the app. Only one live
 * dictation runs at a time: a new one replaces the last.
 */
export async function startLiveDictation(onEvent: (event: LiveDictationEvent) => void): Promise<void> {
    const call = nativePromise();
    const cap = typeof window === "undefined" ? undefined : (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
    if (!call || typeof cap?.addListener !== "function") throw new LiveDictationError(LIVE_START_FAILURE_MESSAGE, "unavailable");
    removeLiveListener();
    const listener = cap.addListener(PLUGIN, "liveTranscript", (data) => {
        const event = liveEventOf(data);
        if (event) onEvent(event);
    });
    liveListener = listener;
    try {
        await call(PLUGIN, "startLive", { engine: FLUID_MINI_ENGINE });
    } catch (error) {
        if (liveListener === listener) removeLiveListener();
        const code = errorCode(error) ?? undefined;
        throw new LiveDictationError(knownErrorCodeMessage(error, DEVICE_ERROR_MESSAGES, LIVE_START_FAILURE_MESSAGE), code);
    }
}

/**
 * Stops the live dictation and resolves the whole text. After an
 * interruption the text kept at that point is returned. The event listener is
 * removed either way.
 */
export async function stopLiveDictation(): Promise<string> {
    const call = nativePromise();
    removeLiveListener();
    if (!call) throw new LiveDictationError(DEVICE_TRANSCRIBE_FAILURE_MESSAGE);
    let result: unknown;
    try {
        result = await call(PLUGIN, "stopLive");
    } catch (error) {
        throw new LiveDictationError(
            knownErrorCodeMessage(error, DEVICE_ERROR_MESSAGES, DEVICE_TRANSCRIBE_FAILURE_MESSAGE),
            errorCode(error) ?? undefined,
        );
    }
    const text = result && typeof result === "object" ? (result as { text?: unknown }).text : undefined;
    return typeof text === "string" ? text : "";
}

/** Stops the live dictation and throws its text away, releasing the microphone. */
export function cancelLiveDictation(): void {
    removeLiveListener();
    const call = nativePromise();
    if (!call) return;
    call(PLUGIN, "cancelLive").catch(() => undefined);
}
