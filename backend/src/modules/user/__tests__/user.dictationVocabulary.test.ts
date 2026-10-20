import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureProfileRow } = vi.hoisted(() => ({ ensureProfileRow: vi.fn() }));

vi.mock("../user.profile.load", () => ({
    ensureProfileRow: (...args: unknown[]) => ensureProfileRow(...args),
}));

import {
    getDictationVocabulary,
    setDictationVocabulary,
    validateVocabulary,
} from "../user.dictationVocabulary";

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

const MISSING_COLUMN = { code: "42703", message: "column user_profiles.dictation_vocabulary does not exist" };

beforeEach(() => {
    vi.clearAllMocks();
    ensureProfileRow.mockResolvedValue(null);
});

describe("validateVocabulary", () => {
    it("trims, collapses whitespace, drops blanks and case-insensitive duplicates", () => {
        expect(validateVocabulary(["  Ximena   Achterberg ", "", "ximena achterberg", "Vasquez-Oyelaran"])).toEqual({
            ok: true,
            data: ["Ximena Achterberg", "Vasquez-Oyelaran"],
        });
    });

    it("rejects non-lists, non-strings, long terms, too many words and too many terms", () => {
        expect(validateVocabulary("x").ok).toBe(false);
        expect(validateVocabulary([1]).ok).toBe(false);
        expect(validateVocabulary(["a".repeat(65)]).ok).toBe(false);
        expect(validateVocabulary(["a".repeat(64)]).ok).toBe(true);
        expect(validateVocabulary(["one two three four five"]).ok).toBe(false);
        expect(validateVocabulary(["one two three four"]).ok).toBe(true);
        expect(validateVocabulary(Array.from({ length: 501 }, (_, i) => `term${i}`)).ok).toBe(false);
        expect(validateVocabulary(Array.from({ length: 500 }, (_, i) => `term${i}`)).ok).toBe(true);
    });

    it("never echoes a term in its error", () => {
        const result = validateVocabulary(["Secret Client Name ".repeat(10)]);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain("Secret");
    });
});

describe("getDictationVocabulary", () => {
    it("returns the stored terms, ignoring malformed entries", async () => {
        const { db } = profileDb({ data: { dictation_vocabulary: ["A B", 3, " ", "C"] }, error: null });
        expect(await getDictationVocabulary(db, "u")).toEqual({ ok: true, data: { terms: ["A B", "C"] } });
    });

    it("is empty before the migration or without a profile row", async () => {
        expect(await getDictationVocabulary(profileDb({ data: null, error: MISSING_COLUMN }).db, "u")).toEqual({
            ok: true,
            data: { terms: [] },
        });
        expect(await getDictationVocabulary(profileDb({ data: null, error: null }).db, "u")).toEqual({
            ok: true,
            data: { terms: [] },
        });
    });

    it("fails on an unreadable profile", async () => {
        const result = await getDictationVocabulary(profileDb({ data: null, error: { message: "boom" } }).db, "u");
        expect(result.ok).toBe(false);
    });
});

describe("setDictationVocabulary", () => {
    it("stores the validated list and returns it", async () => {
        const { db, updates } = profileDb({ data: null, error: null });
        expect(await setDictationVocabulary(db, "u", [" Okonkwo-Lindqvist "])).toEqual({
            ok: true,
            data: { terms: ["Okonkwo-Lindqvist"] },
        });
        expect(updates[0]?.dictation_vocabulary).toEqual(["Okonkwo-Lindqvist"]);
    });

    it("writes nothing for invalid input", async () => {
        const { db, updates } = profileDb({ data: null, error: null });
        const result = await setDictationVocabulary(db, "u", "nope");
        expect(result).toMatchObject({ ok: false, kind: "validation" });
        expect(updates).toEqual([]);
    });

    it("reports unavailable before the migration and error on a failed write", async () => {
        expect(await setDictationVocabulary(profileDb({ data: null, error: null }, { error: MISSING_COLUMN }).db, "u", ["A"])).toMatchObject({
            ok: false,
            kind: "unavailable",
        });
        expect(await setDictationVocabulary(profileDb({ data: null, error: null }, { error: { message: "boom" } }).db, "u", ["A"])).toMatchObject({
            ok: false,
            kind: "error",
        });
    });
});
