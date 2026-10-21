/**
 * Cuts speakable answer text into clauses, one Phonon call each
 * (docs/voice-chat.md, "Speaking"). Phonon cannot take more text once it has
 * started, so the answer is spoken a clause at a time while it streams:
 *
 *  - after `.`, `!` or `?` and a space, unless the word is an abbreviation or
 *    an initial (legal text breaks the "next word is capitalised" rule);
 *  - at `,`, `;` or `:` once the clause has at least six words (the first
 *    clause: four, so sound starts sooner);
 *  - without punctuation at seven words for the first clause and at 26 for
 *    the rest, well inside Phonon's 48-token prompt;
 *  - never leaving a clause under four words (Phonon reads very short texts
 *    poorly): a cut waits until three more words are known and are not the
 *    end of the sentence, and a short sentence joins the next.
 *
 * A clause that stops mid-sentence ends with a comma, so its intonation stays
 * open (Phonon adds a full stop otherwise).
 *
 * The input is speakable text (speakable.ts), so a citation or a number has
 * already become words and is never split.
 */

import type { SpeakablePiece } from "./speakable";

/** Joins the words of one speakable piece, so no cut falls inside it. */
const GLUE = "\u00a0";
/** Words are separated by spaces; a glued piece is one token. */
const TOKENS = /[^ \t\r\n]+/g;

/** One clause to speak. `start`/`end` locate it in the speakable text pushed so far. */
export interface Clause {
    id: number;
    /** What is sent to the engine: the clause, with a comma when it stops mid-sentence. */
    text: string;
    start: number;
    end: number;
    /** The answer's last clause. */
    final?: boolean;
}

export const MIN_CLAUSE_WORDS = 4;
export const PHRASE_CLAUSE_WORDS = 6;
export const FIRST_CLAUSE_WORDS = 7;
export const MAX_CLAUSE_WORDS = 26;
const LOOKAHEAD_WORDS = MIN_CLAUSE_WORDS - 1;

/**
 * Abbreviations whose period does not end a sentence. Speakable text has
 * written most legal ones out; these guard the rest (and text that was not
 * made speakable).
 */
const ABBREVIATIONS = new Set(
    (
        "mr mrs ms dr prof st mt ave blvd jr sr inc corp ltd vs v cf etc approx fig vol ch sec secs para paras " +
        "pp p cir dist ct fed civ crim evid bankr supp dept univ assn gov rev stat ann gen sen rep hon col lt sgt " +
        "capt esq messrs jan feb mar apr jun jul aug sep sept oct nov dec atl bros"
    ).split(" "),
);

const CLOSERS = /["'”’)\]]+$/;
const OPENERS = /^["'“‘([]+/;

/** True when the word ends a sentence. */
export function endsSentence(word: string): boolean {
    const bare = word.slice(word.lastIndexOf(GLUE) + 1).replace(CLOSERS, "");
    if (!/[.!?…]$/.test(bare)) return false;
    if (!bare.endsWith(".") || bare.endsWith("..")) return true;
    const stem = bare.slice(0, -1).replace(OPENERS, "");
    // An initial ("J."), a dotted abbreviation ("U.S"), or a known one.
    if (/^[A-Z]$/.test(stem) || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(stem)) return false;
    return !ABBREVIATIONS.has(stem.toLowerCase());
}

const endsPhrase = (word: string) => /[,;:]$/.test(word.replace(CLOSERS, ""));
const isWord = (token: string) => /[\p{L}\p{N}]/u.test(token);

interface Token {
    start: number;
    end: number;
    text: string;
}

export class ClauseCutter {
    private pending = "";
    private base = 0;
    private nextId = 0;

    /**
     * Adds speakable text; returns the clauses now complete. Given the pieces
     * speakable.ts emitted, a piece of several words (a citation, a date) is
     * never cut inside.
     */
    push(text: string | readonly SpeakablePiece[]): Clause[] {
        this.pending +=
            typeof text === "string"
                ? text
                : text.map((piece) => piece.text.replace(/(\S) (?=\S)/g, `$1${GLUE}`)).join("");
        return this.cut(false);
    }

    /**
     * The answer has paused (a tool call or thinking follows): everything
     * pushed so far, spoken now, however short. More text may follow.
     */
    flush(): Clause[] {
        return this.drainAll(false);
    }

    /** The answer has ended: the clauses left, the last one marked `final`. */
    finish(): Clause[] {
        return this.drainAll(true);
    }

    private drainAll(final: boolean): Clause[] {
        const clauses = this.cut(true);
        const words = [...this.pending.matchAll(TOKENS)];
        if (words.some(([token]) => isWord(token))) {
            const start = words[0].index;
            const last = words[words.length - 1];
            const end = last.index + last[0].length;
            const clause = this.clause(start, end, this.pending.slice(start, end), true);
            clauses.push(final ? { ...clause, final: true } : clause);
        } else if (final && clauses.length > 0) {
            clauses[clauses.length - 1].final = true;
        }
        this.base += this.pending.length;
        this.pending = "";
        return clauses;
    }

    private clause(start: number, end: number, text: string, sentence: boolean): Clause {
        let spoken = text.replaceAll(GLUE, " ");
        if (!sentence) {
            const closers = CLOSERS.exec(spoken)?.[0] ?? "";
            const body = spoken.slice(0, spoken.length - closers.length);
            if (/[;:]$/.test(body)) spoken = `${body.slice(0, -1)},${closers}`;
            else if (!body.endsWith(",")) spoken = `${spoken},`;
        }
        return { id: this.nextId++, text: spoken, start: this.base + start, end: this.base + end };
    }

    private cut(final: boolean): Clause[] {
        const clauses: Clause[] = [];
        for (;;) {
            const cut = this.nextCut(final);
            if (!cut) return clauses;
            const { first, last, sentence } = cut;
            clauses.push(this.clause(first.start, last.end, this.pending.slice(first.start, last.end), sentence));
            this.pending = this.pending.slice(last.end);
            this.base += last.end;
        }
    }

    /** Where the next clause ends, or null while that is not known yet. */
    private nextCut(final: boolean): { first: Token; last: Token; sentence: boolean } | null {
        const tokens: Token[] = [...this.pending.matchAll(TOKENS)]
            .map((match) => ({ start: match.index, end: match.index + match[0].length, text: match[0] }))
            // A word is complete once a space follows it.
            .filter((token) => final || token.end < this.pending.length);
        const opening = this.nextId === 0;
        let words = 0;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            words += token.text.split(GLUE).filter(isWord).length;
            if (endsSentence(token.text)) {
                if (words >= MIN_CLAUSE_WORDS) return { first: tokens[0], last: token, sentence: true };
                continue;
            }
            const phrase = endsPhrase(token.text) && words >= (opening ? MIN_CLAUSE_WORDS : PHRASE_CLAUSE_WORDS);
            const long = words >= (opening ? FIRST_CLAUSE_WORDS : MAX_CLAUSE_WORDS);
            if (!phrase && !long) continue;
            const ahead = tokens.slice(i + 1, i + 1 + LOOKAHEAD_WORDS);
            // The sentence ends within three words: keep it whole.
            if (ahead.some((next) => endsSentence(next.text))) continue;
            if (ahead.length < LOOKAHEAD_WORDS) {
                if (final) continue;
                return null;
            }
            return { first: tokens[0], last: token, sentence: false };
        }
        return null;
    }
}
