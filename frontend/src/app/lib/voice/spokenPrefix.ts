/**
 * What the person heard of an interrupted answer (docs/voice-chat.md, "What
 * was heard"). Clause boundaries are exact: the engine counts played samples.
 * Inside the clause that was cut off, Phonon gives no word timings, so the
 * position is estimated by syllable weight from the fraction of its samples
 * played, and snapped back to the last whole word.
 *
 * The result is mapped back to the answer as written (markdown, citation
 * markers and all), through the pieces speakable.ts kept: a piece (usually a
 * word) counts as heard only once all of its speakable text was.
 */

import type { Clause } from "./clauses";
import { cardinalWords, type SpeakablePiece } from "./speakable";

/** Syllables in a word, by vowel groups: an estimate, which is all the weighting needs. */
export function syllables(word: string): number {
    const parts = word
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .split(/[\s-]+/)
        .filter(Boolean);
    if (parts.length !== 1) return parts.reduce((total, part) => total + syllables(part), 0);
    const [part] = parts;
    if (/^\d+$/.test(part)) return part.length > 9 ? part.length * 2 : syllables(cardinalWords(Number(part)));
    const letters = part.replace(/\d/g, "");
    let count = letters.match(/[aeiouy]+/g)?.length ?? 0;
    if (count > 1 && /[^aeiouyl]e$/.test(letters)) count--;
    return Math.max(1, count + part.length - letters.length);
}

/** The pause after a word, in syllables: a comma's breath, a full stop's longer one. */
function pause(word: string): number {
    if (/[.!?…]["'”’)\]]*$/.test(word)) return 2;
    return /[,;:]["'”’)\]]*$/.test(word) ? 1 : 0;
}

/**
 * How many whole words of `text` were spoken when `fraction` of its audio had
 * played: a word counts once all of its syllables have.
 */
export function wordsHeard(text: string, fraction: number): number {
    const words = text.split(/\s+/).filter(Boolean);
    const weights = words.map((word) => ({ say: syllables(word), rest: pause(word) }));
    const total = weights.reduce((sum, weight) => sum + weight.say + weight.rest, 0);
    const target = Math.min(1, Math.max(0, fraction)) * total;
    let elapsed = 0;
    let heard = 0;
    for (const weight of weights) {
        elapsed += weight.say;
        if (elapsed > target + 1e-9) break;
        heard++;
        elapsed += weight.rest;
    }
    return heard;
}

export interface SpokenPrefixInput {
    /** Every clause sent for the answer, in order. */
    clauses: readonly Clause[];
    /** The clauses that finished playing. */
    played: ReadonlySet<number>;
    /** The clause cut off and the fraction of its samples that played, if one was. */
    interrupted?: { clauseId: number; fraction: number } | null;
    /** The speakable text the clauses were cut from. */
    spoken: string;
    /** The pieces linking that text to the answer as written. */
    pieces: readonly SpeakablePiece[];
    /** The answer as written. */
    source: string;
}

/** Where the heard speech ends in the speakable text. */
function heardEnd({ clauses, played, interrupted, spoken }: SpokenPrefixInput): number {
    let end = 0;
    for (const clause of clauses) {
        if (interrupted && clause.id === interrupted.clauseId) {
            const words = [...spoken.slice(clause.start, clause.end).matchAll(/\S+/g)];
            const heard = wordsHeard(clause.text, interrupted.fraction);
            if (heard === 0) return end;
            const last = words[Math.min(heard, words.length) - 1];
            return clause.start + last.index + last[0].length;
        }
        if (!played.has(clause.id)) return end;
        end = clause.end;
    }
    return end;
}

/**
 * What the person heard: `original` is the answer as written, up to the last
 * word heard (with the markup and citation markers that belong to it);
 * `spoken` is the speakable text that was heard.
 */
export function spokenPrefix(input: SpokenPrefixInput): { original: string; spoken: string } {
    const end = heardEnd(input);
    if (end === 0) return { original: "", spoken: "" };
    let sourceEnd = 0;
    // Pieces with nothing to say (markup, a code block, a citation marker)
    // go with the words before them.
    for (const piece of input.pieces) {
        if (piece.textEnd > end) break;
        sourceEnd = piece.end;
    }
    return {
        // A list or heading marker that opens the next line was not heard.
        original: input.source
            .slice(0, sourceEnd)
            .replace(/\n[^\S\n]*(?:#{1,6}|[-*+•]|\d{1,3}[.)])?[^\S\n]*$/, "")
            .trimEnd(),
        spoken: input.spoken.slice(0, end).trim(),
    };
}
