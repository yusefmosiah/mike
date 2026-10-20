/**
 * Corrects a dictation transcript with the person's vocabulary: names and
 * terms that speech recognition spells wrongly ("Conquo Lindqvist" for
 * "Okonkwo-Lindqvist"). It is a pure function over text, so it applies to the
 * output of any engine.
 *
 * Every window of 1 to 5 words of the transcript (a term's word count, plus or
 * minus one) is compared with every term: the score is 0.6 x phonetic
 * similarity (Double Metaphone codes, best of primary and secondary) plus
 * 0.4 x character similarity (normalised Levenshtein). Comparison is on
 * normalised text (diacritics stripped, "&" read as "and", lower case, Latin
 * letters and digits only); the replacement is the term as the person spelled
 * it. Terms are client names: nothing here logs or reports them.
 */

import { doubleMetaphone } from "double-metaphone";

/** A window is replaced only when all three thresholds are met. */
export const MATCH_THRESHOLDS = { score: 0.7, phonetic: 0.7, character: 0.5 } as const;

/** Terms from the page rather than the person's own list need this much text. */
export const AUTOMATIC_MIN_CHARS = 6;

const MAX_TERM_WORDS = 4;

/** A window that starts or ends with one of these is never a name. */
const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "by", "with",
    "is", "was", "are", "were", "that", "this", "it", "as", "be", "has", "have", "had",
    "not", "but", "we", "he", "she", "they", "you", "i", "our", "your", "their", "his",
    "her", "from", "will", "would", "please",
]);

export interface DictationVocabulary {
    /** The person's own terms: matched first, replaced as written. */
    terms: readonly string[];
    /** Names found on the page; they need `AUTOMATIC_MIN_CHARS` and rank after `terms`. */
    automatic?: readonly string[];
}

/** Lower-case Latin letters and digits, words separated by single spaces. */
function normalise(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function levenshtein(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[b.length];
}

function similarity(a: string, b: string): number {
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

function codesOf(joined: string): string[] {
    const [primary, secondary] = doubleMetaphone(joined);
    return [primary, secondary].filter(Boolean);
}

function codeSimilarity(a: string[], b: string[]): number {
    let best = 0;
    for (const x of a) for (const y of b) best = Math.max(best, similarity(x, y));
    return best;
}

interface PreparedTerm {
    text: string;
    words: number;
    joined: string;
    codes: string[];
    automatic: boolean;
}

function prepare(vocabulary: DictationVocabulary): PreparedTerm[] {
    const seen = new Set<string>();
    const prepared: PreparedTerm[] = [];
    const add = (raw: string, automatic: boolean) => {
        const text = raw.trim();
        const words = normalise(text).split(" ").filter(Boolean);
        if (words.length === 0 || words.length > MAX_TERM_WORDS) return;
        const joined = words.join("");
        if (seen.has(joined)) return;
        if (automatic && joined.length < AUTOMATIC_MIN_CHARS) return;
        seen.add(joined);
        prepared.push({ text, words: words.length, joined, codes: codesOf(joined), automatic });
    };
    for (const term of vocabulary.terms) add(term, false);
    for (const term of vocabulary.automatic ?? []) add(term, true);
    return prepared;
}

interface Candidate {
    from: number;
    to: number;
    term: PreparedTerm;
    score: number;
}

export interface VocabularyMatch {
    original: string;
    term: string;
    score: number;
}

/**
 * The transcript with every phrase that sounds like a vocabulary term
 * replaced by the term as written; surrounding punctuation is kept.
 */
export function correctWithVocabulary(text: string, vocabulary: DictationVocabulary): string {
    return correctWithVocabularyDetailed(text, vocabulary).text;
}

export function correctWithVocabularyDetailed(
    text: string,
    vocabulary: DictationVocabulary,
): { text: string; matches: VocabularyMatch[] } {
    const terms = prepare(vocabulary);
    if (terms.length === 0 || !text.trim()) return { text, matches: [] };

    const tokens = text.split(/\s+/).filter(Boolean);
    const normalised = tokens.map((token) => normalise(token).replace(/ /g, ""));
    const exact = new Set(terms.map((term) => term.joined));
    const windowCache = new Map<string, { joined: string; codes: string[] } | null>();
    const windowAt = (from: number, to: number) => {
        const key = `${from}:${to}`;
        let entry = windowCache.get(key);
        if (entry === undefined) {
            const words = normalised.slice(from, to);
            if (
                words.some((word) => !word) ||
                STOPWORDS.has(words[0]) ||
                STOPWORDS.has(words[words.length - 1])
            ) {
                entry = null;
            } else {
                const joined = words.join("");
                entry = { joined, codes: codesOf(joined) };
            }
            windowCache.set(key, entry);
        }
        return entry;
    };

    // Spans that are already exactly a term are protected from other terms.
    const used = new Array<boolean>(tokens.length).fill(false);
    const candidates: Candidate[] = [];
    for (const term of terms) {
        for (let size = Math.max(1, term.words - 1); size <= term.words + 1; size++) {
            for (let from = 0; from + size <= tokens.length; from++) {
                const window = windowAt(from, from + size);
                if (!window) continue;
                if (window.joined === term.joined) {
                    for (let i = from; i < from + size; i++) used[i] = true;
                    continue;
                }
                if (exact.has(window.joined)) continue;
                if (term.automatic && window.joined.length < AUTOMATIC_MIN_CHARS) continue;
                const longest = Math.max(window.joined.length, term.joined.length);
                const shortest = Math.min(window.joined.length, term.joined.length);
                // Character similarity cannot reach its floor when lengths differ this much.
                if (shortest / longest < MATCH_THRESHOLDS.character) continue;
                const phonetic = codeSimilarity(window.codes, term.codes);
                if (phonetic < MATCH_THRESHOLDS.phonetic) continue;
                const character = similarity(window.joined, term.joined);
                if (character < MATCH_THRESHOLDS.character) continue;
                const score = 0.6 * phonetic + 0.4 * character;
                if (score >= MATCH_THRESHOLDS.score) candidates.push({ from, to: from + size, term, score });
            }
        }
    }

    // Best score first; on a tie the person's own term, then the longer window.
    candidates.sort(
        (a, b) =>
            b.score - a.score ||
            Number(a.term.automatic) - Number(b.term.automatic) ||
            b.to - b.from - (a.to - a.from),
    );
    const chosen: Candidate[] = [];
    for (const candidate of candidates) {
        let free = true;
        for (let i = candidate.from; i < candidate.to; i++) if (used[i]) free = false;
        if (!free) continue;
        for (let i = candidate.from; i < candidate.to; i++) used[i] = true;
        chosen.push(candidate);
    }
    if (chosen.length === 0) return { text, matches: [] };
    chosen.sort((a, b) => a.from - b.from);

    const out: string[] = [];
    const matches: VocabularyMatch[] = [];
    let index = 0;
    let next = 0;
    while (index < tokens.length) {
        const hit = chosen[next];
        if (!hit || hit.from !== index) {
            out.push(tokens[index++]);
            continue;
        }
        const lead = tokens[hit.from].replace(/^([^\p{L}\p{N}]*)[\s\S]*$/u, "$1");
        const trail = tokens[hit.to - 1].replace(/^[\s\S]*?([^\p{L}\p{N}]*)$/u, "$1");
        out.push(lead + hit.term.text + trail);
        matches.push({
            original: tokens.slice(hit.from, hit.to).join(" "),
            term: hit.term.text,
            score: hit.score,
        });
        index = hit.to;
        next++;
    }
    return { text: out.join(" "), matches };
}
