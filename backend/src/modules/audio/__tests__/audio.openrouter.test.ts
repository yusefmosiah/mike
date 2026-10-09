// OpenRouter voice lane: price units, the strict-private refusal, catalog
// validation, and the request each call sends. `fetch` is stubbed; no
// network, no key.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    inputAudioFormat,
    normalizeVoicePrice,
    openRouterAudioStatus,
    openRouterSpeech,
    openRouterTranscribe,
    resetVoiceCatalogCache,
    voiceCatalog,
} from "../audio.openrouter";

const env = { OPENROUTER_API_KEY: "or-test-key" } as NodeJS.ProcessEnv;

const MODELS = {
    speech: [
        { id: "elevenlabs/eleven-v3", name: "Eleven v3", pricing: { prompt: "0.00004", completion: "0" }, supported_voices: ["george", "sarah"] },
        { id: "bytedance-seed/seed-audio-1-0", name: "Seed Audio", pricing: { prompt: "0", completion: "0.0025" }, supported_voices: [] },
    ],
    transcription: [
        { id: "qwen/qwen3-asr-0.6b", name: "Qwen3 ASR", pricing: { prompt: "0.00000333", completion: "0" } },
        { id: "google/gemini-3.5-transcribe", name: "Gemini Transcribe", pricing: { prompt: "0.000002", completion: "0.000012" } },
    ],
};

function stubFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const custom = handler?.(url, init);
        if (custom) return custom;
        const kind = /output_modalities=(\w+)/.exec(url)?.[1] as keyof typeof MODELS | undefined;
        if (kind) return new Response(JSON.stringify({ data: MODELS[kind] }), { status: 200 });
        return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => resetVoiceCatalogCache());

describe("normalizeVoicePrice", () => {
    it("reads each billing shape in its own unit", () => {
        expect(normalizeVoicePrice("speech", { prompt: "0.00004", completion: "0" })).toEqual({ unit: "per_1k_chars", usd: 0.04 });
        expect(normalizeVoicePrice("speech", { prompt: "0", completion: "0.0025" })).toEqual({ unit: "per_minute_output", usd: 0.15 });
        const perMinute = normalizeVoicePrice("transcription", { prompt: "0.00000333", completion: "0" });
        expect(perMinute.unit).toBe("per_minute");
        expect(perMinute.unit === "per_minute" && perMinute.usd).toBeCloseTo(0.0002, 6);
        expect(normalizeVoicePrice("transcription", { prompt: "0.000002", completion: "0.000012" })).toEqual({ unit: "tokens", input_per_million: 2, output_per_million: 12 });
        expect(normalizeVoicePrice("speech", { prompt: "0", completion: "0" })).toEqual({ unit: "free" });
        expect(normalizeVoicePrice("speech", undefined)).toEqual({ unit: "free" });
    });
});

describe("openRouterAudioStatus", () => {
    it("is off in strict private mode even with a key, and without a key", () => {
        expect(openRouterAudioStatus({ ...env, STRICT_PRIVATE_MODE: "true" })).toEqual({ available: false, reason: "strict_private" });
        expect(openRouterAudioStatus({})).toEqual({ available: false, reason: "no_key" });
        expect(openRouterAudioStatus(env)).toEqual({ available: true });
    });
});

describe("voiceCatalog", () => {
    it("loads both lists once an hour", async () => {
        const fetchMock = stubFetch();
        let now = 1_000;
        const catalog = await voiceCatalog({ fetch: fetchMock, env, now: () => now });
        expect(catalog?.speech.map((m) => m.id)).toEqual(["elevenlabs/eleven-v3", "bytedance-seed/seed-audio-1-0"]);
        expect(catalog?.speech[0].voices).toEqual(["george", "sarah"]);
        now += 30 * 60 * 1000;
        await voiceCatalog({ fetch: fetchMock, env, now: () => now });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        now += 31 * 60 * 1000;
        await voiceCatalog({ fetch: fetchMock, env, now: () => now });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});

describe("openRouterTranscribe", () => {
    it("sends base64 audio in input_audio and reports the billed cost", async () => {
        const fetchMock = stubFetch((url) =>
            url.endsWith("/audio/transcriptions")
                ? new Response(JSON.stringify({ text: "hello world", usage: { seconds: 2, cost: 0.0000067 } }), { status: 200 })
                : undefined,
        );
        const result = await openRouterTranscribe({ audio: Buffer.from("abc"), mimetype: "audio/webm;codecs=opus", model: "qwen/qwen3-asr-0.6b", language: "en" }, { fetch: fetchMock, env });
        expect(result).toEqual({ ok: true, text: "hello world", model: "qwen/qwen3-asr-0.6b", costUsd: 0.0000067 });
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/audio/transcriptions"))!;
        expect(JSON.parse(String(call[1]?.body))).toEqual({ model: "qwen/qwen3-asr-0.6b", input_audio: { data: "YWJj", format: "webm" }, language: "en" });
        expect((call[1]?.headers as Record<string, string>).Authorization).toBe("Bearer or-test-key");
    });

    it("refuses a model outside the catalog and anything in strict private mode", async () => {
        const fetchMock = stubFetch();
        expect(await openRouterTranscribe({ audio: Buffer.from("a"), mimetype: "audio/webm", model: "openai/gpt-5" }, { fetch: fetchMock, env })).toMatchObject({ ok: false, code: "bad_audio" });
        const strict = await openRouterTranscribe({ audio: Buffer.from("a"), mimetype: "audio/webm", model: "qwen/qwen3-asr-0.6b" }, { fetch: fetchMock, env: { ...env, STRICT_PRIVATE_MODE: "true" } });
        expect(strict).toMatchObject({ ok: false, code: "audio_unavailable", detail: expect.stringMatching(/strict private/) });
    });
});

describe("openRouterSpeech", () => {
    it("speaks with a listed voice and prices per character", async () => {
        const fetchMock = stubFetch((url) => (url.endsWith("/audio/speech") ? new Response(new Uint8Array([9, 9, 9]), { status: 200 }) : undefined));
        const result = await openRouterSpeech({ text: "x".repeat(500), model: "elevenlabs/eleven-v3", voice: "sarah" }, { fetch: fetchMock, env });
        expect(result).toMatchObject({ ok: true, model: "elevenlabs/eleven-v3", voice: "sarah", contentType: "audio/mpeg" });
        if (result.ok) expect(result.costUsd).toBeCloseTo(0.02, 6);
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/audio/speech"))!;
        expect(JSON.parse(String(call[1]?.body))).toEqual({ model: "elevenlabs/eleven-v3", input: "x".repeat(500), voice: "sarah", response_format: "mp3" });
    });

    it("uses the model's first voice by default and refuses an unknown one", async () => {
        const fetchMock = stubFetch((url) => (url.endsWith("/audio/speech") ? new Response(new Uint8Array([1]), { status: 200 }) : undefined));
        expect(await openRouterSpeech({ text: "hi", model: "elevenlabs/eleven-v3" }, { fetch: fetchMock, env })).toMatchObject({ ok: true, voice: "george" });
        expect(await openRouterSpeech({ text: "hi", model: "elevenlabs/eleven-v3", voice: "nobody" }, { fetch: fetchMock, env })).toMatchObject({ ok: false, code: "bad_audio" });
    });
});

describe("inputAudioFormat", () => {
    it("maps browser recording types", () => {
        expect(inputAudioFormat("audio/webm;codecs=opus")).toBe("webm");
        expect(inputAudioFormat("audio/mp4")).toBe("m4a");
        expect(inputAudioFormat("audio/x-wav")).toBe("wav");
        expect(inputAudioFormat("video/quicktime")).toBeNull();
    });
});
