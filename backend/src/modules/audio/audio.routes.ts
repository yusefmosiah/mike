// HTTP layer for the audio module: dictation transcription and read-aloud
// synthesis against the deployment's own speech operator.
//
// Route handlers authenticate, parse the request into primitives, call the
// audio.service functions, and map their typed results onto status codes and
// bytes. Nothing here touches the database — audio is ephemeral in both
// directions — so the service takes no `db` handle.
//
// Transcription takes JSON with a base64 payload rather than multipart.
// Parsing multipart without adding a dependency (multer, busboy) would mean
// hand-rolling a parser over the raw body for this one route; the JSON
// parser already mounted in app.ts carries the ~34 MB a 25 MB recording
// encodes to inside its 50 MB limit, and the bytes are decoded straight into
// a Buffer that never touches disk.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import {
    AUDIO_TOO_LARGE_DETAIL,
    MAX_AUDIO_BYTES,
    audioFailure,
    type AudioFailure,
} from "./audio.shared";
import { synthesizeSpeech, transcribeAudio, voiceOptions } from "./audio.service";

export const audioRouter = Router();

// Status codes are the module's failure policy, so they live in one table
// instead of being repeated in every handler: an absent operator cannot be
// retried (503), a malformed recording is the caller's fault (400), and an
// operator that answered but failed is a bad gateway (502).
const STATUS_FOR_FAILURE: Record<AudioFailure["code"], number> = {
    audio_unavailable: 503,
    bad_audio: 400,
    upstream_error: 502,
};

function sendAudioFailure(res: Response, failure: AudioFailure): void {
    res.status(STATUS_FOR_FAILURE[failure.code]).json({
        code: failure.code,
        detail: failure.detail,
    });
}

// Standard base64 with padding, as btoa/FileReader produce it. Anything else
// is rejected rather than passed to Buffer.from, which ignores invalid
// characters and would hand the operator a silently truncated recording.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// The base64 length that encodes at most MAX_AUDIO_BYTES bytes, padding
// included, so an oversize payload is rejected before it is decoded into a
// second, larger buffer.
const MAX_AUDIO_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;

function decodeAudioUpload(
    value: string,
): { ok: true; audio: Buffer<ArrayBuffer> } | AudioFailure {
    const compact = value.replace(/\s+/g, "");
    if (compact.length > MAX_AUDIO_BASE64_LENGTH) {
        return audioFailure("bad_audio", AUDIO_TOO_LARGE_DETAIL);
    }
    if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
        return audioFailure(
            "bad_audio",
            "audio_base64 must be base64-encoded audio.",
        );
    }
    const audio = Buffer.from(compact, "base64");
    if (audio.length === 0) {
        return audioFailure("bad_audio", "The recording is empty.");
    }
    return { ok: true, audio };
}

/**
 * The filename forwarded to the operator. Dictation clients may omit one (the
 * browser records into a bare Blob), and whisper-style operators key their
 * decoder off the extension, so derive one from the declared container type.
 */
function recordingFilename(mimetype: string, provided: unknown): string {
    if (typeof provided === "string" && provided.trim()) return provided.trim();
    const subtype = mimetype.split(";")[0].trim().toLowerCase().split("/")[1];
    const extension = (subtype ?? "").replace(/^x-/, "").replace(/^mpeg$/, "mp3");
    return `recording.${extension || "bin"}`;
}

// POST /audio/transcriptions
//
// { audio_base64, mimetype, filename?, language?, provider?, model? } in,
// { text, provider, model, cost_usd } out. The parsing rationale is in the
// module comment above.
audioRouter.post(
    "/transcriptions",
    requireAuth,
    asyncRoute(async (req, res) => {
        const body = (
            typeof req.body === "object" && req.body !== null ? req.body : {}
        ) as Record<string, unknown>;

        const decoded = decodeAudioUpload(
            typeof body.audio_base64 === "string" ? body.audio_base64 : "",
        );
        if (!decoded.ok) return void sendAudioFailure(res, decoded);

        const mimetype =
            typeof body.mimetype === "string" ? body.mimetype.trim() : "";
        const language =
            typeof body.language === "string" && body.language.trim()
                ? body.language.trim()
                : undefined;

        const result = await transcribeAudio({
            file: decoded.audio,
            filename: recordingFilename(mimetype, body.filename),
            mimetype,
            language,
            provider: body.provider,
            model: typeof body.model === "string" ? body.model : undefined,
        });
        if (!result.ok) return void sendAudioFailure(res, result);
        res.json({
            text: result.text,
            provider: result.provider,
            model: result.model,
            cost_usd: result.costUsd,
        });
    }),
);

// POST /audio/speech
//
// { text, voice?, speed?, format?, provider?, model? } in, the synthesized
// bytes out.
audioRouter.post(
    "/speech",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await synthesizeSpeech(req.body);
        if (!result.ok) return void sendAudioFailure(res, result);
        res.setHeader("Content-Type", result.contentType);
        // For the voice test bench: which model spoke, and what it cost
        // when the price is known.
        res.setHeader("X-Mike-Audio-Provider", result.provider);
        res.setHeader("X-Mike-Audio-Model", result.model);
        if (result.costUsd !== null) res.setHeader("X-Mike-Audio-Cost", result.costUsd.toFixed(6));
        res.send(result.audio);
    }),
);

// GET /audio/options
//
// What this deployment offers: the operator's configured models, and
// OpenRouter's speech and transcription catalog with prices when that lane
// is available (never in strict private mode).
audioRouter.get(
    "/options",
    requireAuth,
    asyncRoute(async (_req, res) => {
        res.json(await voiceOptions());
    }),
);

audioRouter.use(routerErrorHandler("[audio]"));
