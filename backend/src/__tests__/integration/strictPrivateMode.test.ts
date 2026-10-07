// Station 8 — strict private mode: the boot gate, the model allow-gate, and
// the hosted-catalog lockdown. The catalog tests drive the real models router
// with only auth and the key store mocked, so the service failure union and
// the route status mapping are exercised together.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "strict-user";
        next();
    },
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({ from: vi.fn() })),
}));

vi.mock("../../modules/user/user.apiKeyStore", () => ({
    getUserApiKeys: (...args: unknown[]) => getUserApiKeys(...args),
}));

import { modelsRouter } from "../../modules/models/models.routes";
import {
    listOpenRouterModels,
    listVercelModels,
} from "../../modules/models/models.service";
import { resetModelRegistryCache } from "../../lib/llm/registry";
import {
    assertModelAllowed,
    assertPrivateModeBoot,
    isStrictPrivateMode,
    PrivateModeError,
} from "../../lib/privateMode";

const app = express();
app.use("/models", modelsRouter);

describe("isStrictPrivateMode", () => {
    it("reads only the literal 'true'", () => {
        expect(isStrictPrivateMode({ STRICT_PRIVATE_MODE: "true" })).toBe(true);
        expect(isStrictPrivateMode({ STRICT_PRIVATE_MODE: "TRUE" })).toBe(false);
        expect(isStrictPrivateMode({ STRICT_PRIVATE_MODE: "1" })).toBe(false);
        expect(isStrictPrivateMode({})).toBe(false);
    });
});

describe("assertPrivateModeBoot", () => {
    it("is a no-op while strict private mode is off", () => {
        expect(() =>
            assertPrivateModeBoot({
                SENTRY_DISABLED: "false",
                SENTRY_DSN: "https://key@example.invalid/1",
                OPENAI_API_KEY: "sk-openai",
            }),
        ).not.toThrow();
    });

    it("refuses to boot with telemetry reachable", () => {
        // Without SENTRY_DISABLED the default-on community DSN would fire, so
        // strict mode demands the explicit opt-out even with no DSN set.
        expect(() =>
            assertPrivateModeBoot({ STRICT_PRIVATE_MODE: "true" }),
        ).toThrow(PrivateModeError);
        expect(() =>
            assertPrivateModeBoot({
                STRICT_PRIVATE_MODE: "true",
                SENTRY_DSN: "https://key@example.invalid/1",
            }),
        ).toThrow(/SENTRY_DISABLED/);
        expect(() =>
            assertPrivateModeBoot({
                STRICT_PRIVATE_MODE: "true",
                SENTRY_DISABLED: "false",
            }),
        ).toThrow(/SENTRY_DISABLED/);
    });

    it("refuses to boot with any hosted cloud credential present", () => {
        const names = [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CLAUDE_API_KEY",
            "GEMINI_API_KEY",
            "OPENROUTER_API_KEY",
            "AI_GATEWAY_API_KEY",
            "VERCEL_AI_GATEWAY_API_KEY",
        ];
        for (const name of names) {
            const env = {
                STRICT_PRIVATE_MODE: "true",
                SENTRY_DISABLED: "true",
                [name]: "secret",
            };
            expect(() => assertPrivateModeBoot(env), name).toThrow(
                PrivateModeError,
            );
            expect(() => assertPrivateModeBoot(env), name).toThrow(
                new RegExp(name),
            );
        }
    });

    it("ignores whitespace-only credential values", () => {
        expect(() =>
            assertPrivateModeBoot({
                STRICT_PRIVATE_MODE: "true",
                SENTRY_DISABLED: "true",
                OPENAI_API_KEY: "   ",
            }),
        ).not.toThrow();
    });

    it("boots when strict mode is fully configured", () => {
        expect(() =>
            assertPrivateModeBoot({
                STRICT_PRIVATE_MODE: "true",
                SENTRY_DISABLED: "true",
            }),
        ).not.toThrow();
    });
});

describe("assertModelAllowed", () => {
    const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

    afterEach(() => {
        vi.unstubAllEnvs();
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
    });

    it("allows local, OpenCode Go, and operator-configured lanes", () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
            models: [
                {
                    id: "dgx-deepseek",
                    provider: "openai-compatible",
                    location: "local",
                    baseUrl: "http://10.0.0.5:8000/v1",
                },
            ],
        });
        resetModelRegistryCache();

        expect(() => assertModelAllowed("ollama/qwen3")).not.toThrow();
        expect(() => assertModelAllowed("opencode-go/grok-code")).not.toThrow();
        // Registry-declared id: allowed without any caller flag.
        expect(() => assertModelAllowed("dgx-deepseek")).not.toThrow();
        // Caller-flagged configured id, for committees assembled per request.
        expect(() =>
            assertModelAllowed("committee/panel-1", { isConfigured: true }),
        ).not.toThrow();
    });

    it("refuses every hosted lane by name", () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        delete process.env.MIKE_MODEL_CONFIG_JSON;
        resetModelRegistryCache();

        expect(() => assertModelAllowed("claude-sonnet-4-5")).toThrow(/Claude/);
        expect(() => assertModelAllowed("gemini-3-flash-preview")).toThrow(
            /Gemini/,
        );
        expect(() => assertModelAllowed("gpt-5.6-terra")).toThrow(/OpenAI/);
        expect(() =>
            assertModelAllowed("openrouter/anthropic/claude-sonnet-4.5"),
        ).toThrow(/OpenRouter/);
        expect(() => assertModelAllowed("vercel/openai/gpt-4o")).toThrow(
            /Vercel AI Gateway/,
        );
    });

    it("refuses unknown ids (default deny)", () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        delete process.env.MIKE_MODEL_CONFIG_JSON;
        resetModelRegistryCache();

        expect(() => assertModelAllowed("mystery-model")).toThrow(
            PrivateModeError,
        );
        expect(() => assertModelAllowed("mystery-model")).toThrow(
            /not an allowed lane/,
        );
    });

    it("is a no-op outside strict mode", () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "false");
        delete process.env.MIKE_MODEL_CONFIG_JSON;
        resetModelRegistryCache();

        expect(() => assertModelAllowed("claude-sonnet-4-5")).not.toThrow();
        expect(() => assertModelAllowed("vercel/openai/gpt-4o")).not.toThrow();
    });
});

describe("strict private mode: hosted catalogs", () => {
    const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

    beforeEach(() => {
        getUserApiKeys.mockReset();
        getUserApiKeys.mockResolvedValue({});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
    });

    it("refuses OpenRouter and Vercel with 403 before any provider call", async () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        getUserApiKeys.mockResolvedValue({
            openrouter: "or-user-key",
            vercel: "vercel-user-key",
        });
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const openrouter = await request(app).get("/models/openrouter");
        expect(openrouter.status).toBe(403);
        expect(openrouter.body.code).toBe("private_mode_disabled");
        expect(openrouter.body.detail).toMatch(/OpenRouter/);

        const vercel = await request(app).get("/models/vercel");
        expect(vercel.status).toBe(403);
        expect(vercel.body.code).toBe("private_mode_disabled");
        expect(vercel.body.detail).toMatch(/Vercel AI Gateway/);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns the typed private_mode_disabled failure from the service", async () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        const db = { from: vi.fn() } as never;

        await expect(listOpenRouterModels(db, "user-1")).resolves.toMatchObject({
            ok: false,
            kind: "private_mode_disabled",
        });
        await expect(listVercelModels(db, "user-1")).resolves.toMatchObject({
            ok: false,
            kind: "private_mode_disabled",
        });
    });

    it("still serves local, configured, and OpenCode Go catalogs", async () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "true");
        getUserApiKeys.mockResolvedValue({
            openai: "user-openai-key",
            "opencode-go": "oc-user-key",
        });
        process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
            models: [
                {
                    id: "local-qwen",
                    provider: "openai-compatible",
                    location: "local",
                    baseUrl: "http://localhost:8000/v1",
                },
            ],
        });
        resetModelRegistryCache();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ data: [] }), {
                        status: 200,
                    }),
                ),
            ),
        );

        const ollama = await request(app).get("/models/ollama");
        expect(ollama.status).toBe(200);
        expect(ollama.body).toEqual({ models: [] });

        const configured = await request(app).get("/models/configured");
        expect(configured.status).toBe(200);
        expect(configured.body.models).toEqual([
            {
                id: "local-qwen",
                label: "local-qwen",
                group: "Configured",
                location: "local",
                source: "Configured",
            },
        ]);

        const opencode = await request(app).get("/models/opencode-go");
        expect(opencode.status).toBe(200);
        expect(opencode.body).toEqual({ models: [] });
    });

    it("keeps normal catalog behavior while strict mode is off", async () => {
        vi.stubEnv("STRICT_PRIVATE_MODE", "false");
        getUserApiKeys.mockResolvedValue({ openrouter: "or-user-key" });
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ data: [] }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ models: [] });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
