// OpenRouter as a voice provider (goals/mission-10-voice.md): a test lane for
// comparing speech models before Mike serves its own. It uses the
// deployment's OPENROUTER_API_KEY and is never available in strict private
// mode, where recordings and response text stay on the operator's endpoints.
//
// The catalog comes from OpenRouter's model list (output_modalities=speech
// and =transcription), cached for an hour. Requests name a model from it, so
// a chat model id or a typo is refused here rather than billed upstream.

import { isStrictPrivateMode } from "../../lib/privateMode";
import { assertEgressAllowed } from "../../lib/egress";
import {
    SPEECH_CONTENT_TYPES,
    audioFailure,
    type AudioFailure,
} from "./audio.shared";

export type VoicePrice =
    | { unit: "per_1k_chars"; usd: number }
    | { unit: "per_minute"; usd: number }
    | { unit: "per_minute_output"; usd: number }
    | { unit: "tokens"; input_per_million: number; output_per_million: number }
    | { unit: "free" };

export type VoiceModel = {
    id: string;
    name: string;
    price: VoicePrice;
    voices: string[];
};

export type VoiceCatalog = { speech: VoiceModel[]; transcription: VoiceModel[] };

export type OpenRouterStatus =
    | { available: true }
    | { available: false; reason: "strict_private" | "no_key" };

const CATALOG_TTL_MS = 60 * 60 * 1000;

function baseUrl(env: NodeJS.ProcessEnv): string {
    return (env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}

export function openRouterAudioStatus(env: NodeJS.ProcessEnv = process.env): OpenRouterStatus {
    if (isStrictPrivateMode(env)) return { available: false, reason: "strict_private" };
    if (!env.OPENROUTER_API_KEY?.trim()) return { available: false, reason: "no_key" };
    return { available: true };
}

function unavailable(status: Exclude<OpenRouterStatus, { available: true }>): AudioFailure {
    return audioFailure(
        "audio_unavailable",
        status.reason === "strict_private"
            ? "OpenRouter voice is a test lane and is off in strict private mode."
            : "OpenRouter voice is not configured on this deployment.",
    );
}

const num = (value: unknown): number => {
    const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * OpenRouter lists a speech or transcription price as `prompt` and
 * `completion` amounts whose unit depends on how the model bills: speech
 * models with only a prompt price bill per input character, transcription
 * models with only a prompt price bill per second of audio, a speech model
 * with only a completion price bills per second of generated audio, and a
 * model with both bills tokens. The test bench shows what a call actually
 * cost when OpenRouter reports it.
 */
export function normalizeVoicePrice(kind: "speech" | "transcription", pricing: unknown): VoicePrice {
    const fields = (pricing && typeof pricing === "object" ? pricing : {}) as Record<string, unknown>;
    const prompt = num(fields.prompt);
    const completion = num(fields.completion);
    if (!prompt && !completion) return { unit: "free" };
    if (prompt && completion) {
        return { unit: "tokens", input_per_million: prompt * 1e6, output_per_million: completion * 1e6 };
    }
    if (kind === "speech") {
        return prompt ? { unit: "per_1k_chars", usd: prompt * 1000 } : { unit: "per_minute_output", usd: completion * 60 };
    }
    return prompt ? { unit: "per_minute", usd: prompt * 60 } : { unit: "tokens", input_per_million: 0, output_per_million: completion * 1e6 };
}

type Fetch = typeof fetch;
let cached: { at: number; catalog: VoiceCatalog } | null = null;

/** Clears the catalog cache (tests). */
export function resetVoiceCatalogCache(): void {
    cached = null;
}

export async function voiceCatalog(
    deps: { fetch?: Fetch; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<VoiceCatalog | null> {
    const now = (deps.now ?? Date.now)();
    if (cached && now - cached.at < CATALOG_TTL_MS) return cached.catalog;
    const env = deps.env ?? process.env;
    const doFetch = deps.fetch ?? fetch;
    const base = baseUrl(env);
    await assertEgressAllowed(base, "audio");
    const load = async (kind: "speech" | "transcription"): Promise<VoiceModel[] | null> => {
        const response = await doFetch(`${base}/models?output_modalities=${kind}`).catch(() => null);
        if (!response?.ok) return null;
        const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
        if (!payload || !Array.isArray(payload.data)) return null;
        return payload.data.flatMap((entry): VoiceModel[] => {
            const model = entry as Record<string, unknown>;
            if (typeof model.id !== "string") return [];
            const voices = Array.isArray(model.supported_voices)
                ? model.supported_voices.filter((v): v is string => typeof v === "string")
                : [];
            return [{
                id: model.id,
                name: typeof model.name === "string" ? model.name : model.id,
                price: normalizeVoicePrice(kind, model.pricing),
                voices,
            }];
        });
    };
    const [speech, transcription] = await Promise.all([load("speech"), load("transcription")]);
    if (!speech || !transcription) return cached?.catalog ?? null;
    cached = { at: now, catalog: { speech, transcription } };
    return cached.catalog;
}

/** OpenRouter's input_audio.format for a recorded container type. */
export function inputAudioFormat(mimetype: string): string | null {
    const subtype = mimetype.split(";")[0].trim().toLowerCase().split("/")[1] ?? "";
    const map: Record<string, string> = {
        webm: "webm", ogg: "ogg", mp4: "m4a", m4a: "m4a", "x-m4a": "m4a", mpeg: "mp3", mp3: "mp3",
        wav: "wav", "x-wav": "wav", wave: "wav", flac: "flac", aac: "aac",
    };
    return map[subtype] ?? null;
}

export type ProviderTranscription =
    | { ok: true; text: string; model: string; costUsd: number | null }
    | AudioFailure;

export async function openRouterTranscribe(
    input: { audio: Buffer; mimetype: string; model: string; language?: string },
    deps: { fetch?: Fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderTranscription> {
    const env = deps.env ?? process.env;
    const status = openRouterAudioStatus(env);
    if (!status.available) return unavailable(status);
    const catalog = await voiceCatalog({ fetch: deps.fetch, env });
    if (!catalog) return audioFailure("upstream_error", "The OpenRouter voice catalog could not be loaded.");
    if (!catalog.transcription.some((m) => m.id === input.model)) {
        return audioFailure("bad_audio", "Choose a transcription model from the catalog.");
    }
    const format = inputAudioFormat(input.mimetype);
    if (!format) return audioFailure("bad_audio", "This recording format cannot be sent to OpenRouter.");
    const base = baseUrl(env);
    await assertEgressAllowed(base, "audio");
    const response = await (deps.fetch ?? fetch)(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY?.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: input.model,
            input_audio: { data: input.audio.toString("base64"), format },
            ...(input.language ? { language: input.language } : {}),
        }),
    }).catch(() => null);
    if (!response) return audioFailure("upstream_error", "OpenRouter could not be reached.");
    if (!response.ok) return audioFailure("upstream_error", `OpenRouter answered ${response.status}.`);
    const payload = (await response.json().catch(() => null)) as { text?: unknown; usage?: { cost?: unknown } } | null;
    if (!payload || typeof payload.text !== "string") {
        return audioFailure("upstream_error", "OpenRouter returned an unexpected transcription.");
    }
    const cost = typeof payload.usage?.cost === "number" ? payload.usage.cost : null;
    return { ok: true, text: payload.text, model: input.model, costUsd: cost };
}

export type ProviderSpeech =
    | { ok: true; audio: Buffer; contentType: string; model: string; voice: string; costUsd: number | null }
    | AudioFailure;

export async function openRouterSpeech(
    input: { text: string; model: string; voice?: string; speed?: number },
    deps: { fetch?: Fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderSpeech> {
    const env = deps.env ?? process.env;
    const status = openRouterAudioStatus(env);
    if (!status.available) return unavailable(status);
    const catalog = await voiceCatalog({ fetch: deps.fetch, env });
    if (!catalog) return audioFailure("upstream_error", "The OpenRouter voice catalog could not be loaded.");
    const model = catalog.speech.find((m) => m.id === input.model);
    if (!model) return audioFailure("bad_audio", "Choose a speech model from the catalog.");
    const voice = input.voice ?? model.voices[0];
    if (input.voice && model.voices.length > 0 && !model.voices.includes(input.voice)) {
        return audioFailure("bad_audio", "Choose one of this model's voices.");
    }
    const base = baseUrl(env);
    await assertEgressAllowed(base, "audio");
    const response = await (deps.fetch ?? fetch)(`${base}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY?.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: model.id,
            input: input.text,
            ...(voice ? { voice } : {}),
            response_format: "mp3",
            ...(input.speed !== undefined && input.speed !== 1 ? { speed: input.speed } : {}),
        }),
    }).catch(() => null);
    if (!response) return audioFailure("upstream_error", "OpenRouter could not be reached.");
    if (!response.ok) return audioFailure("upstream_error", `OpenRouter answered ${response.status}.`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) return audioFailure("upstream_error", "OpenRouter returned no audio.");
    const costUsd = model.price.unit === "per_1k_chars" ? (input.text.length / 1000) * model.price.usd : model.price.unit === "free" ? 0 : null;
    return { ok: true, audio, contentType: SPEECH_CONTENT_TYPES.mp3, model: model.id, voice: voice ?? "", costUsd };
}
