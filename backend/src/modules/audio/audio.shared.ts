// Shared vocabulary for the audio module: the operator's OpenAI-compatible
// speech endpoints, the request limits the service enforces, and the typed
// failure both service functions return.
//
// Both endpoints come ONLY from the environment — there is deliberately no
// cloud default, so a deployment that has not named its own operator answers
// 503 instead of shipping recordings or response text to a third party.

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_SPEECH_CHARS = 4_000;
export const MIN_SPEECH_SPEED = 0.5;
export const MAX_SPEECH_SPEED = 2;

export const DEFAULT_STT_MODEL = "whisper-large-v3-turbo";
export const DEFAULT_TTS_MODEL = "tts-1";
export const DEFAULT_TTS_VOICE = "alloy";

export const SPEECH_FORMATS = ["mp3", "wav", "opus"] as const;

export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

// The content type each synthesis format answers with. mp3 and opus are
// container families, so the IANA names are not simply `audio/<format>`.
export const SPEECH_CONTENT_TYPES: Record<SpeechFormat, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    opus: "audio/ogg",
};

export type AudioFailureCode =
    | "audio_unavailable"
    | "bad_audio"
    | "upstream_error";

export type AudioFailure = {
    ok: false;
    code: AudioFailureCode;
    detail: string;
};

export function audioFailure(
    code: AudioFailureCode,
    detail: string,
): AudioFailure {
    return { ok: false, code, detail };
}

// One detail string shared by the transport-level base64 guard in the route
// and the byte-level guard in the service, so an oversize recording reads the
// same whichever side notices first.
export const AUDIO_TOO_LARGE_DETAIL = "The recording exceeds the 25 MB limit.";

export function isSpeechFormat(value: string): value is SpeechFormat {
    return (SPEECH_FORMATS as readonly string[]).includes(value);
}

export type SttConfiguration = {
    baseUrl: string;
    apiKey: string;
    model: string;
};

export type TtsConfiguration = {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
};

/**
 * The operator's transcription endpoint, or null when this deployment has
 * none. Trailing slashes are stripped so `{base}/audio/...` never doubles
 * one; an unset API key stays empty (see the synthesis function for what
 * that means).
 */
export function sttConfiguration(
    env: NodeJS.ProcessEnv = process.env,
): SttConfiguration | null {
    const baseUrl = (env.MIKE_STT_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
    if (!baseUrl) return null;
    return {
        baseUrl,
        apiKey: env.MIKE_STT_API_KEY?.trim() ?? "",
        model: env.MIKE_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * The operator's synthesis endpoint, or null when this deployment has none.
 * A self-hosted operator commonly runs without auth, so an unset API key
 * sends no Authorization header at all rather than an empty bearer.
 */
export function ttsConfiguration(
    env: NodeJS.ProcessEnv = process.env,
): TtsConfiguration | null {
    const baseUrl = (env.MIKE_TTS_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
    if (!baseUrl) return null;
    return {
        baseUrl,
        apiKey: env.MIKE_TTS_API_KEY?.trim() ?? "",
        model: env.MIKE_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
        voice: env.MIKE_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE,
    };
}
