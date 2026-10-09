// Tests for the audio module: the service's operator requests, validation,
// and failure mapping, plus the routes' status-code mapping over HTTP.
//
// The operator endpoints are stubbed at the global `fetch` boundary, and the
// route app mounts the router with the same JSON parser app.ts provides, so
// no network and no credentials are needed.

import express from "express";
import request from "supertest";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from "vitest";

vi.mock("../../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
}));

import { audioRouter } from "../audio.routes";
import { synthesizeSpeech, transcribeAudio } from "../audio.service";
import { AUDIO_TOO_LARGE_DETAIL, MAX_AUDIO_BYTES } from "../audio.shared";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/audio", audioRouter);

const OPERATOR_ENV_KEYS = [
    "MIKE_STT_BASE_URL",
    "MIKE_STT_API_KEY",
    "MIKE_STT_MODEL",
    "MIKE_TTS_BASE_URL",
    "MIKE_TTS_API_KEY",
    "MIKE_TTS_MODEL",
    "MIKE_TTS_VOICE",
] as const;

// One [key, original value] pair per operator variable, so the suite restores
// whatever the developer's shell had.
const originalEnv = OPERATOR_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const,
);

// The TTS base URL deliberately ends in a slash: the service must strip it.
const STT_BASE = "https://stt.example.test/v1";
const TTS_BASE = "https://tts.example.test/v1/";
const STT_KEY = "stt-secret-key";
const TTS_KEY = "tts-secret-key";

beforeEach(() => {
    process.env.MIKE_STT_BASE_URL = STT_BASE;
    process.env.MIKE_STT_API_KEY = STT_KEY;
    delete process.env.MIKE_STT_MODEL;
    process.env.MIKE_TTS_BASE_URL = TTS_BASE;
    process.env.MIKE_TTS_API_KEY = TTS_KEY;
    delete process.env.MIKE_TTS_MODEL;
    delete process.env.MIKE_TTS_VOICE;
});

afterEach(() => {
    for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function firstCall(fetchMock: Mock): {
    url: string;
    init: RequestInit;
} {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init };
}

function recording(): {
    file: Buffer<ArrayBuffer>;
    filename: string;
    mimetype: string;
    language?: string;
} {
    return {
        file: Buffer.from("recorded bytes"),
        filename: "dictation.webm",
        mimetype: "audio/webm",
    };
}

describe("transcribeAudio", () => {
    it("forwards the recording to the configured operator", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(jsonResponse({ text: "Hello there" }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await transcribeAudio({
            ...recording(),
            language: "  en  ",
        });

        expect(result).toEqual({
            ok: true,
            text: "Hello there",
            provider: "operator",
            model: "whisper-large-v3-turbo",
            costUsd: null,
        });

        const { url, init } = firstCall(fetchMock);
        expect(url).toBe(`${STT_BASE}/audio/transcriptions`);
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ Authorization: `Bearer ${STT_KEY}` });

        const form = init.body as FormData;
        expect(form.get("model")).toBe("whisper-large-v3-turbo");
        expect(form.get("language")).toBe("en");
        const file = form.get("file") as File;
        expect(file.name).toBe("dictation.webm");
        expect(file.type).toBe("audio/webm");
        expect(await file.text()).toBe("recorded bytes");
    });

    it("honors a configured model and omits an absent language field", async () => {
        process.env.MIKE_STT_MODEL = "custom-whisper";
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "" }));
        vi.stubGlobal("fetch", fetchMock);

        await transcribeAudio(recording());

        const form = firstCall(fetchMock).init.body as FormData;
        expect(form.get("model")).toBe("custom-whisper");
        expect(form.has("language")).toBe(false);
    });

    it("sends no Authorization header when the operator has no key", async () => {
        delete process.env.MIKE_STT_API_KEY;
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "" }));
        vi.stubGlobal("fetch", fetchMock);

        await transcribeAudio(recording());

        expect(firstCall(fetchMock).init.headers).toEqual({});
    });

    it("rejects empty and oversize recordings before calling the operator", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const empty = await transcribeAudio({
            ...recording(),
            file: Buffer.alloc(0),
        });
        expect(empty).toMatchObject({ ok: false, code: "bad_audio" });

        const oversize = await transcribeAudio({
            ...recording(),
            file: Buffer.alloc(MAX_AUDIO_BYTES + 1),
        });
        expect(oversize).toMatchObject({
            ok: false,
            code: "bad_audio",
            detail: AUDIO_TOO_LARGE_DETAIL,
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a recording that is neither audio nor video", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await transcribeAudio({
            ...recording(),
            mimetype: "application/pdf",
        });

        expect(result).toMatchObject({ ok: false, code: "bad_audio" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed when no transcription endpoint is configured", async () => {
        delete process.env.MIKE_STT_BASE_URL;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await transcribeAudio(recording());

        expect(result).toMatchObject({ ok: false, code: "audio_unavailable" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps an operator failure to upstream_error without echoing the key", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)),
        );

        const result = await transcribeAudio(recording());

        expect(result).toMatchObject({
            ok: false,
            code: "upstream_error",
            detail: expect.stringContaining("500"),
        });
        expect(JSON.stringify(result)).not.toContain(STT_KEY);
    });

    it("maps an unreachable operator and an unexpected payload to upstream_error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
        );
        expect(await transcribeAudio(recording())).toMatchObject({
            ok: false,
            code: "upstream_error",
        });

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ text: 7 })),
        );
        expect(await transcribeAudio(recording())).toMatchObject({
            ok: false,
            code: "upstream_error",
        });
    });
});

describe("synthesizeSpeech", () => {
    it("synthesizes with the configured defaults", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { "Content-Type": "audio/mpeg" },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await synthesizeSpeech({ text: "Read this back." });

        expect(result).toEqual({
            ok: true,
            audio: Buffer.from([1, 2, 3]),
            contentType: "audio/mpeg",
            provider: "operator",
            model: "tts-1",
            costUsd: null,
        });

        const { url, init } = firstCall(fetchMock);
        expect(url).toBe(`${TTS_BASE.replace(/\/$/, "")}/audio/speech`);
        expect(init.headers).toEqual({
            Authorization: `Bearer ${TTS_KEY}`,
            "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init.body))).toEqual({
            model: "tts-1",
            input: "Read this back.",
            voice: "alloy",
            response_format: "mp3",
        });
    });

    it("sends requested voice, speed, and format with the configured overrides", async () => {
        process.env.MIKE_TTS_MODEL = "custom-tts";
        process.env.MIKE_TTS_VOICE = "nova";
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([9]), {
                status: 200,
                headers: { "Content-Type": "audio/wav" },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await synthesizeSpeech({
            text: "Hello",
            speed: 1.5,
            format: "wav",
        });

        expect(result).toMatchObject({ ok: true, contentType: "audio/wav" });
        expect(JSON.parse(String(firstCall(fetchMock).init.body))).toEqual({
            model: "custom-tts",
            input: "Hello",
            voice: "nova",
            response_format: "wav",
            speed: 1.5,
        });
    });

    it("accepts both speed boundaries", async () => {
        const fetchMock = vi.fn().mockImplementation(() =>
            Promise.resolve(
                new Response(new Uint8Array([1]), { status: 200 }),
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        for (const speed of [0.5, 2]) {
            const result = await synthesizeSpeech({ text: "Hi", speed });
            expect(result.ok).toBe(true);
        }
    });

    it("rejects missing, empty, and over-long text", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        for (const text of [undefined, "", "   ", "x".repeat(4_001)]) {
            const result = await synthesizeSpeech({ text });
            expect(result).toMatchObject({ ok: false, code: "bad_audio" });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a speed outside 0.5 to 2.0 and a non-numeric speed", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        for (const speed of [0.4, 2.5, "fast", Number.NaN]) {
            const result = await synthesizeSpeech({ text: "Hi", speed });
            expect(result).toMatchObject({
                ok: false,
                code: "bad_audio",
                detail: expect.stringContaining("speed"),
            });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown format and an empty voice", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const format = await synthesizeSpeech({ text: "Hi", format: "flac" });
        expect(format).toMatchObject({
            ok: false,
            code: "bad_audio",
            detail: expect.stringContaining("format"),
        });

        const voice = await synthesizeSpeech({ text: "Hi", voice: "  " });
        expect(voice).toMatchObject({
            ok: false,
            code: "bad_audio",
            detail: expect.stringContaining("voice"),
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed when no synthesis endpoint is configured", async () => {
        delete process.env.MIKE_TTS_BASE_URL;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await synthesizeSpeech({ text: "Hi" });

        expect(result).toMatchObject({ ok: false, code: "audio_unavailable" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps an operator failure and an empty body to upstream_error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)),
        );
        const failed = await synthesizeSpeech({ text: "Hi" });
        expect(failed).toMatchObject({
            ok: false,
            code: "upstream_error",
            detail: expect.stringContaining("500"),
        });
        expect(JSON.stringify(failed)).not.toContain(TTS_KEY);

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
        );
        expect(await synthesizeSpeech({ text: "Hi" })).toMatchObject({
            ok: false,
            code: "upstream_error",
        });
    });
});

describe("POST /audio/transcriptions", () => {
    it("answers { text } for a base64 recording", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(jsonResponse({ text: "Hello" }));
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app)
            .post("/audio/transcriptions")
            .send({
                audio_base64: Buffer.from("recorded bytes").toString("base64"),
                mimetype: "audio/webm",
                language: "en",
            });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            text: "Hello",
            provider: "operator",
            model: "whisper-large-v3-turbo",
            cost_usd: null,
        });

        const form = firstCall(fetchMock).init.body as FormData;
        expect((form.get("file") as File).name).toBe("recording.webm");
    });

    it("rejects a body without valid base64 audio", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const missing = await request(app)
            .post("/audio/transcriptions")
            .send({ mimetype: "audio/webm" });
        expect(missing.status).toBe(400);
        expect(missing.body).toMatchObject({ code: "bad_audio" });

        const invalid = await request(app)
            .post("/audio/transcriptions")
            .send({ audio_base64: "not base64!!", mimetype: "audio/webm" });
        expect(invalid.status).toBe(400);
        expect(invalid.body).toMatchObject({ code: "bad_audio" });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an oversize recording before decoding it", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app)
            .post("/audio/transcriptions")
            .send({
                audio_base64: "A".repeat(
                    Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4,
                ),
                mimetype: "audio/webm",
            });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            code: "bad_audio",
            detail: AUDIO_TOO_LARGE_DETAIL,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers 503 when no transcription endpoint is configured", async () => {
        delete process.env.MIKE_STT_BASE_URL;

        const response = await request(app)
            .post("/audio/transcriptions")
            .send({
                audio_base64: Buffer.from("recorded").toString("base64"),
                mimetype: "audio/webm",
            });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: "audio_unavailable" });
    });

    it("answers 502 for an operator failure without leaking the key", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 502)),
        );

        const response = await request(app)
            .post("/audio/transcriptions")
            .send({
                audio_base64: Buffer.from("recorded").toString("base64"),
                mimetype: "audio/webm",
            });

        expect(response.status).toBe(502);
        expect(response.body).toMatchObject({
            code: "upstream_error",
            detail: expect.stringContaining("502"),
        });
        expect(response.text).not.toContain(STT_KEY);
    });
});

describe("POST /audio/speech", () => {
    it("answers the synthesized bytes with the format's content type", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(new Uint8Array([1, 2, 3, 4]), {
                    status: 200,
                    headers: { "Content-Type": "audio/wav" },
                }),
            ),
        );

        const response = await request(app)
            .post("/audio/speech")
            .send({ text: "Hello", format: "wav" });

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("audio/wav");
        expect(Buffer.isBuffer(response.body)).toBe(true);
        expect(Buffer.from(response.body).toString("hex")).toBe("01020304");
    });

    it("rejects invalid speech parameters", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app)
            .post("/audio/speech")
            .send({ text: "", speed: 3, format: "flac" });

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: "bad_audio" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers 503 when no synthesis endpoint is configured", async () => {
        delete process.env.MIKE_TTS_BASE_URL;

        const response = await request(app)
            .post("/audio/speech")
            .send({ text: "Hello" });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: "audio_unavailable" });
    });

    it("answers 502 for an operator failure without leaking the key", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500)),
        );

        const response = await request(app)
            .post("/audio/speech")
            .send({ text: "Hello" });

        expect(response.status).toBe(502);
        expect(response.body).toMatchObject({
            code: "upstream_error",
            detail: expect.stringContaining("500"),
        });
        expect(response.text).not.toContain(TTS_KEY);
    });
});
