// Business logic for the audio module.
//
// Service layer behind audio.routes.ts. Both functions take request-derived
// primitives (never req/res), call the deployment's own OpenAI-compatible
// speech operator, and RETURN a typed result: { ok: true, ... } or an
// AudioFailure the route renders as a status code.
//
// Bytes are handled entirely in memory: a recording is forwarded straight
// from the decoded request body to the operator, and synthesized audio is
// buffered and handed back — nothing here writes a recording, a transcript,
// or a clip to disk.

import {
    AUDIO_TOO_LARGE_DETAIL,
    MAX_AUDIO_BYTES,
    MAX_SPEECH_CHARS,
    MAX_SPEECH_SPEED,
    MIN_SPEECH_SPEED,
    SPEECH_CONTENT_TYPES,
    audioFailure,
    isSpeechFormat,
    sttConfiguration,
    ttsConfiguration,
    type AudioFailure,
    type SpeechFormat,
} from "./audio.shared";
import { assertEgressAllowed } from "../../lib/egress";
import {
    openRouterAudioStatus,
    openRouterSpeech,
    openRouterTranscribe,
    voiceCatalog,
    type OpenRouterStatus,
    type VoiceCatalog,
} from "./audio.openrouter";

export { normalizeVoicePrice, resetVoiceCatalogCache } from "./audio.openrouter";
export type { VoiceCatalog, VoiceModel, VoicePrice } from "./audio.openrouter";

/**
 * Where a request goes: the deployment's own operator (the default, and the
 * only choice in strict private mode) or OpenRouter, the comparison lane.
 */
export type AudioProvider = "operator" | "openrouter";

function providerOf(value: unknown): AudioProvider | null {
    if (value === undefined || value === null || value === "" || value === "operator") return "operator";
    if (value === "openrouter") return "openrouter";
    return null;
}

export type TranscribeInput = {
    // The buffer parameter is pinned to ArrayBuffer rather than the default
    // ArrayBufferLike: a BlobPart cannot be backed by a SharedArrayBuffer, so
    // this is the exact type that wraps in a Blob without copying.
    file: Buffer<ArrayBuffer>;
    filename: string;
    mimetype: string;
    language?: string;
    provider?: unknown;
    /** OpenRouter model id; the operator always uses its configured model. */
    model?: string;
};

export type TranscribeResult =
    | { ok: true; text: string; provider: AudioProvider; model: string; costUsd: number | null }
    | AudioFailure;

export type SpeechResult =
    | {
          ok: true;
          audio: Buffer;
          contentType: string;
          provider: AudioProvider;
          model: string;
          costUsd: number | null;
      }
    | AudioFailure;

/**
 * Forward one recorded audio blob to the operator's transcription endpoint.
 * Validation lives here rather than in the route because the limits are a
 * property of the operator contract, not of the transport encoding.
 */
export async function transcribeAudio(
    input: TranscribeInput,
): Promise<TranscribeResult> {
    const mimetype = input.mimetype.trim();
    const language = input.language?.trim();

    if (input.file.length === 0) {
        return audioFailure("bad_audio", "The recording is empty.");
    }
    if (input.file.length > MAX_AUDIO_BYTES) {
        return audioFailure("bad_audio", AUDIO_TOO_LARGE_DETAIL);
    }
    // Video containers can carry an audio track (a browser MediaRecorder may
    // hand back a webm or mp4 holding both), so both families are accepted.
    if (!mimetype.startsWith("audio/") && !mimetype.startsWith("video/")) {
        return audioFailure(
            "bad_audio",
            "Send the recording as an audio/* or video/* file.",
        );
    }

    const provider = providerOf(input.provider);
    if (!provider) return audioFailure("bad_audio", "provider must be operator or openrouter.");
    if (provider === "openrouter") {
        const model = input.model?.trim();
        if (!model) return audioFailure("bad_audio", "model is required for OpenRouter.");
        const result = await openRouterTranscribe({ audio: input.file, mimetype, model, language });
        return result.ok ? { ...result, provider } : result;
    }

    const configuration = sttConfiguration();
    if (!configuration) {
        return audioFailure(
            "audio_unavailable",
            "Transcription is not configured on this deployment.",
        );
    }

    const form = new FormData();
    form.append(
        "file",
        new Blob([input.file], { type: mimetype }),
        input.filename,
    );
    form.append("model", configuration.model);
    if (language) form.append("language", language);

    // Shared egress gate: in strict private mode a public operator endpoint
    // is refused before the recording leaves the process.
    await assertEgressAllowed(configuration.baseUrl, "audio");

    // An unset operator key sends no Authorization header at all, never an
    // empty bearer (see ttsConfiguration for the same policy).
    const response = await fetch(
        `${configuration.baseUrl}/audio/transcriptions`,
        {
            method: "POST",
            headers: configuration.apiKey
                ? { Authorization: `Bearer ${configuration.apiKey}` }
                : {},
            body: form,
        },
    ).catch(() => null);
    if (!response) {
        return audioFailure(
            "upstream_error",
            "The transcription operator could not be reached.",
        );
    }
    if (!response.ok) {
        // Only the status travels on: an operator error body can echo the
        // request, credentials included, and this detail reaches the client.
        return audioFailure(
            "upstream_error",
            `The transcription operator answered ${response.status}.`,
        );
    }

    const payload = (await response.json().catch(() => null)) as {
        text?: unknown;
    } | null;
    if (!payload || typeof payload.text !== "string") {
        return audioFailure(
            "upstream_error",
            "The transcription operator returned an unexpected response.",
        );
    }

    return { ok: true, text: payload.text, provider, model: configuration.model, costUsd: null };
}

/**
 * Synthesize one piece of text through the operator's speech endpoint.
 * The body arrives as `unknown` on purpose: this is the module's single
 * request-validation point, so a malformed JSON payload becomes a typed
 * bad_audio instead of an unchecked property read.
 */
export async function synthesizeSpeech(input: unknown): Promise<SpeechResult> {
    const fields = (
        typeof input === "object" && input !== null ? input : {}
    ) as Record<string, unknown>;

    const text = typeof fields.text === "string" ? fields.text : "";
    if (!text.trim()) {
        return audioFailure("bad_audio", "text is required.");
    }
    if (text.length > MAX_SPEECH_CHARS) {
        return audioFailure(
            "bad_audio",
            `text must be at most ${MAX_SPEECH_CHARS} characters.`,
        );
    }

    let voice: string | undefined;
    if (fields.voice !== undefined) {
        if (typeof fields.voice !== "string" || !fields.voice.trim()) {
            return audioFailure(
                "bad_audio",
                "voice must be a non-empty string.",
            );
        }
        voice = fields.voice.trim();
    }

    let speed: number | undefined;
    if (fields.speed !== undefined) {
        const range = `speed must be between ${MIN_SPEECH_SPEED} and ${MAX_SPEECH_SPEED.toFixed(1)}.`;
        if (typeof fields.speed !== "number" || !Number.isFinite(fields.speed)) {
            return audioFailure("bad_audio", range);
        }
        if (fields.speed < MIN_SPEECH_SPEED || fields.speed > MAX_SPEECH_SPEED) {
            return audioFailure("bad_audio", range);
        }
        speed = fields.speed;
    }

    let format: SpeechFormat = "mp3";
    if (fields.format !== undefined) {
        if (
            typeof fields.format !== "string" ||
            !isSpeechFormat(fields.format)
        ) {
            return audioFailure(
                "bad_audio",
                "format must be one of mp3, wav, opus.",
            );
        }
        format = fields.format;
    }

    const provider = providerOf(fields.provider);
    if (!provider) return audioFailure("bad_audio", "provider must be operator or openrouter.");
    if (provider === "openrouter") {
        const model = typeof fields.model === "string" ? fields.model.trim() : "";
        if (!model) return audioFailure("bad_audio", "model is required for OpenRouter.");
        const result = await openRouterSpeech({ text, model, voice, speed });
        return result.ok
            ? { ok: true, audio: result.audio, contentType: result.contentType, provider, model: result.model, costUsd: result.costUsd }
            : result;
    }

    const configuration = ttsConfiguration();
    if (!configuration) {
        return audioFailure(
            "audio_unavailable",
            "Speech synthesis is not configured on this deployment.",
        );
    }

    // Shared egress gate: in strict private mode a public operator endpoint
    // is refused before the response text leaves the process.
    await assertEgressAllowed(configuration.baseUrl, "audio");

    const response = await fetch(`${configuration.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
            ...(configuration.apiKey
                ? { Authorization: `Bearer ${configuration.apiKey}` }
                : {}),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: configuration.model,
            input: text,
            voice: voice ?? configuration.voice,
            response_format: format,
            ...(speed !== undefined ? { speed } : {}),
        }),
    }).catch(() => null);
    if (!response) {
        return audioFailure(
            "upstream_error",
            "The speech operator could not be reached.",
        );
    }
    if (!response.ok) {
        return audioFailure(
            "upstream_error",
            `The speech operator answered ${response.status}.`,
        );
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) {
        return audioFailure(
            "upstream_error",
            "The speech operator returned no audio.",
        );
    }

    return {
        ok: true,
        audio,
        contentType: SPEECH_CONTENT_TYPES[format],
        provider,
        model: configuration.model,
        costUsd: null,
    };
}

export type VoiceOptions = {
    strict_private: boolean;
    operator: {
        transcription: { model: string } | null;
        speech: { model: string; voice: string } | null;
    };
    openrouter: OpenRouterStatus & { catalog: VoiceCatalog | null };
};

/** What this deployment can do for voice, for Settings -> Voice. */
export async function voiceOptions(env: NodeJS.ProcessEnv = process.env): Promise<VoiceOptions> {
    const stt = sttConfiguration(env);
    const tts = ttsConfiguration(env);
    const status = openRouterAudioStatus(env);
    const catalog = status.available ? await voiceCatalog({ env }).catch(() => null) : null;
    return {
        strict_private: !status.available && status.reason === "strict_private",
        operator: {
            transcription: stt ? { model: stt.model } : null,
            speech: tts ? { model: tts.model, voice: tts.voice } : null,
        },
        openrouter: { ...status, catalog },
    };
}
