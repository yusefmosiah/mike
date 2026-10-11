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
    PluginHeaders?: { name: string }[];
    nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

const PLUGIN = "MikeSpeech";
const STATES: readonly DeviceSpeechState[] = ["available", "downloadable", "downloading", "unavailable"];

export const DEVICE_TRANSCRIBE_FAILURE_MESSAGE =
    "Could not transcribe the recording on this iPhone. Please try again.";
const DEVICE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "not-installed": "Download Apple's speech model in Settings → Voice to dictate on this iPhone.",
    unavailable: "This iPhone cannot transcribe this language on the device.",
    "permission-denied": "Speech recognition is turned off for Mike in the iPhone's Settings.",
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

/** Transcribes a recording on the phone. */
export async function transcribeOnDevice(blob: Blob, language?: string): Promise<string> {
    const call = nativePromise();
    if (!call) throw new DeviceSpeechError(DEVICE_ERROR_MESSAGES.unavailable);
    let result: unknown;
    try {
        result = await call(PLUGIN, "transcribe", {
            audio: await toBase64(blob),
            mimeType: blob.type,
            ...languageOption(language),
        });
    } catch (error) {
        throw new DeviceSpeechError(knownErrorCodeMessage(error, DEVICE_ERROR_MESSAGES, DEVICE_TRANSCRIBE_FAILURE_MESSAGE));
    }
    const text = result && typeof result === "object" ? (result as { text?: unknown }).text : undefined;
    return typeof text === "string" ? text : "";
}
