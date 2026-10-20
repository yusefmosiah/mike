"use client";

import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

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
};

/** `text` spoken by one of the phone's voices, as a WAV file. */
export async function speakOnDevice(text: string, voice?: string): Promise<Blob> {
    const call = nativePromise();
    if (!call) throw new DeviceSpeechError(DEVICE_SPEAK_FAILURE_MESSAGE);
    let result: unknown;
    try {
        result = await call(PLUGIN, "speak", { text, ...(voice ? { voice } : {}) });
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
