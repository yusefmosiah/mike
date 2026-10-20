// The person's dictation vocabulary: names and terms (matter and party names)
// that dictation should spell exactly. Stored on the profile as a JSON array
// of strings so it follows them across devices. The terms are client data:
// they are never logged and never echoed into an error.
import type { Db } from "../../lib/db";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { ensureProfileRow } from "./user.profile.load";

export const MAX_VOCABULARY_TERMS = 500;
export const MAX_VOCABULARY_TERM_CHARS = 64;
export const MAX_VOCABULARY_TERM_WORDS = 4;

export type DictationVocabulary = { terms: string[] };

function isMissingColumn(error: unknown): boolean {
    const record = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
    return (
        record.code === "42703" &&
        typeof record.message === "string" &&
        record.message.includes("dictation_vocabulary")
    );
}

function clean(term: string): string {
    return term.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** A stored list is data, not trusted shape: keep only well-formed terms. */
function normalizeStored(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item === "string" && clean(item)) out.push(clean(item));
    }
    return out.slice(0, MAX_VOCABULARY_TERMS);
}

/** Validates a submitted list; drops blank entries and case-insensitive duplicates. */
export function validateVocabulary(raw: unknown): ServiceResult<string[]> {
    if (!Array.isArray(raw)) return failure("validation", "terms must be a list of strings");
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") return failure("validation", "Each term must be text.");
        const term = clean(item);
        if (!term) continue;
        if (term.length > MAX_VOCABULARY_TERM_CHARS) {
            return failure("validation", `A term can be at most ${MAX_VOCABULARY_TERM_CHARS} characters.`);
        }
        if (term.split(" ").length > MAX_VOCABULARY_TERM_WORDS) {
            return failure("validation", `A term can be at most ${MAX_VOCABULARY_TERM_WORDS} words.`);
        }
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
    }
    if (terms.length > MAX_VOCABULARY_TERMS) {
        return failure("validation", `The vocabulary can hold at most ${MAX_VOCABULARY_TERMS} terms.`);
    }
    return ok(terms);
}

export async function getDictationVocabulary(
    db: Db,
    userId: string,
): Promise<ServiceResult<DictationVocabulary>> {
    const { data, error } = await db
        .from("user_profiles")
        .select("dictation_vocabulary")
        .eq("user_id", userId)
        .maybeSingle();
    // Before the migration nobody has a vocabulary.
    if (error && isMissingColumn(error)) return ok({ terms: [] });
    if (error) return internalFailure(error);
    return ok({
        terms: normalizeStored((data as { dictation_vocabulary?: unknown } | null)?.dictation_vocabulary),
    });
}

/** Replaces the whole list. */
export async function setDictationVocabulary(
    db: Db,
    userId: string,
    raw: unknown,
): Promise<ServiceResult<DictationVocabulary>> {
    const parsed = validateVocabulary(raw);
    if (!parsed.ok) return parsed;
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return internalFailure(ensureError);
    const { error } = await db
        .from("user_profiles")
        .update({ dictation_vocabulary: parsed.data, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    if (error && isMissingColumn(error)) {
        return failure("unavailable", "The dictation vocabulary is not available yet. Try again later.");
    }
    if (error) return internalFailure(error);
    return ok({ terms: parsed.data });
}
