import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "../../../lib/userFacingError";

const { contextWindow, resolveRequestedModel, ensureProfileRow } = vi.hoisted(() => ({
    contextWindow: vi.fn(),
    resolveRequestedModel: vi.fn(),
    ensureProfileRow: vi.fn(),
}));

vi.mock("../../../lib/llm", async () => ({
    ...(await vi.importActual<typeof import("../../../lib/llm")>("../../../lib/llm")),
    contextWindow: (model: string) => contextWindow(model),
    autocompactPolicy: async () => ({
        minTokens: 20_000,
        maxTokens: 10_000_000,
        defaultTokens: (window: number) => Math.min(500_000, Math.floor(window * 0.8)),
    }),
}));

vi.mock("../../../lib/routerModels", async () => ({
    ...(await vi.importActual<typeof import("../../../lib/routerModels")>("../../../lib/routerModels")),
    resolveRequestedModel: (...args: unknown[]) => resolveRequestedModel(...args),
}));

vi.mock("../user.profile.load", () => ({
    ensureProfileRow: (...args: unknown[]) => ensureProfileRow(...args),
}));

import {
    getAutocompactSetting,
    getAutocompactTokensFor,
    setAutocompactTokens,
} from "../user.autocompact";

const MODEL = "opencode-go/glm-5.3-flash";

function profileDb(read: { data: unknown; error: unknown }, write: { error: unknown } = { error: null }) {
    const updates: Array<Record<string, unknown>> = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select"]) chain[method] = vi.fn(() => chain);
    chain.update = vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: vi.fn(async () => write) };
    });
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => read);
    return { db: chain as never, updates };
}

const MISSING_COLUMN = { code: "42703", message: 'column user_profiles.autocompact_tokens does not exist' };

beforeEach(() => {
    vi.clearAllMocks();
    contextWindow.mockResolvedValue(1_000_000);
    resolveRequestedModel.mockImplementation(async (model: string) => model);
    ensureProfileRow.mockResolvedValue(null);
});

describe("getAutocompactTokensFor", () => {
    it("returns the stored threshold for the model", async () => {
        const { db } = profileDb({ data: { autocompact_tokens: { [MODEL]: 421_000, other: 30_000 } }, error: null });
        expect(await getAutocompactTokensFor(db, "u", MODEL)).toBe(421_000);
    });

    it("is undefined when unset, malformed, unmigrated or unreadable", async () => {
        expect(await getAutocompactTokensFor(profileDb({ data: { autocompact_tokens: {} }, error: null }).db, "u", MODEL)).toBeUndefined();
        expect(await getAutocompactTokensFor(profileDb({ data: { autocompact_tokens: { [MODEL]: "lots" } }, error: null }).db, "u", MODEL)).toBeUndefined();
        expect(await getAutocompactTokensFor(profileDb({ data: null, error: MISSING_COLUMN }).db, "u", MODEL)).toBeUndefined();
        expect(await getAutocompactTokensFor(profileDb({ data: null, error: { message: "boom" } }).db, "u", MODEL)).toBeUndefined();
        expect(await getAutocompactTokensFor(profileDb({ data: null, error: null }).db, "u", MODEL)).toBeUndefined();
    });
});

describe("getAutocompactSetting", () => {
    it("reports the person's value and the model's default", async () => {
        const { db } = profileDb({ data: { autocompact_tokens: { [MODEL]: 300_000 } }, error: null });
        expect(await getAutocompactSetting(db, "u", MODEL)).toEqual({
            ok: true,
            data: {
                model: MODEL,
                tokens: 300_000,
                defaultTokens: 500_000,
                effectiveTokens: 300_000,
                contextWindow: 1_000_000,
                minTokens: 20_000,
                maxTokens: 1_000_000,
            },
        });
    });

    it("falls back to the default when nothing is set, using 80% of a small window", async () => {
        contextWindow.mockResolvedValue(200_000);
        const { db } = profileDb({ data: { autocompact_tokens: {} }, error: null });
        expect(await getAutocompactSetting(db, "u", MODEL)).toMatchObject({
            ok: true,
            data: { tokens: null, defaultTokens: 160_000, effectiveTokens: 160_000, maxTokens: 200_000 },
        });
    });

    it("rejects a missing or unknown model, and one outside the saved router selection", async () => {
        const { db } = profileDb({ data: null, error: null });
        expect(await getAutocompactSetting(db, "u", undefined)).toMatchObject({ ok: false, kind: "validation" });
        expect(await getAutocompactSetting(db, "u", "not-a-model")).toMatchObject({ ok: false, kind: "validation" });
        resolveRequestedModel.mockRejectedValueOnce(new UserFacingError("Model is not in your saved models"));
        expect(await getAutocompactSetting(db, "u", MODEL)).toEqual({
            ok: false,
            kind: "validation",
            detail: "Model is not in your saved models",
        });
    });

    it("rejects a model whose context window is unknown", async () => {
        contextWindow.mockResolvedValue(undefined);
        const { db } = profileDb({ data: null, error: null });
        expect(await getAutocompactSetting(db, "u", MODEL)).toMatchObject({ ok: false, kind: "validation" });
    });

    it("never reports an unexpected resolution failure as a validation message", async () => {
        resolveRequestedModel.mockRejectedValueOnce(new Error("connection refused"));
        const { db } = profileDb({ data: null, error: null });
        expect(await getAutocompactSetting(db, "u", MODEL)).toMatchObject({ ok: false, kind: "error" });
    });
});

describe("setAutocompactTokens", () => {
    it("stores the threshold for one model, keeping the others", async () => {
        const { db, updates } = profileDb({ data: { autocompact_tokens: { other: 30_000 } }, error: null });
        const result = await setAutocompactTokens(db, "u", MODEL, 421_000);
        expect(result).toMatchObject({ ok: true, data: { model: MODEL, tokens: 421_000, effectiveTokens: 421_000 } });
        expect(updates).toHaveLength(1);
        expect(updates[0].autocompact_tokens).toEqual({ other: 30_000, [MODEL]: 421_000 });
        expect(ensureProfileRow).toHaveBeenCalledWith(db, "u");
    });

    it("null resets the model to its default", async () => {
        const { db, updates } = profileDb({ data: { autocompact_tokens: { [MODEL]: 421_000, other: 30_000 } }, error: null });
        expect(await setAutocompactTokens(db, "u", MODEL, null)).toMatchObject({
            ok: true,
            data: { tokens: null, effectiveTokens: 500_000 },
        });
        expect(updates[0].autocompact_tokens).toEqual({ other: 30_000 });
    });

    it("rejects non-integers, values out of bounds and values above the window, without writing", async () => {
        contextWindow.mockResolvedValue(200_000);
        const { db, updates } = profileDb({ data: { autocompact_tokens: {} }, error: null });
        for (const tokens of ["500k", 1.5, undefined, 19_999, 200_001]) {
            expect(await setAutocompactTokens(db, "u", MODEL, tokens)).toMatchObject({ ok: false, kind: "validation" });
        }
        expect(await setAutocompactTokens(db, "u", MODEL, 200_001)).toEqual({
            ok: false,
            kind: "validation",
            detail: "Choose a value from 20k to 200k tokens for this model.",
        });
        expect(updates).toEqual([]);
    });

    it("maps an unmigrated database to unavailable and other write errors to an internal failure", async () => {
        expect(
            await setAutocompactTokens(profileDb({ data: { autocompact_tokens: {} }, error: null }, { error: MISSING_COLUMN }).db, "u", MODEL, 400_000),
        ).toMatchObject({ ok: false, kind: "unavailable" });
        expect(
            await setAutocompactTokens(profileDb({ data: { autocompact_tokens: {} }, error: null }, { error: { message: "boom" } }).db, "u", MODEL, 400_000),
        ).toMatchObject({ ok: false, kind: "error" });
    });
});
