/**
 * An answer's text (markdown, streamed) as text for Phonon to speak
 * (docs/voice-chat.md, "The conversation layer"): markdown, links and
 * citation markers go; code, tables and long quotes become "it's on the
 * screen"; what Phonon's English rules miss in legal text is written out
 * (section signs, case names, rules of procedure, pinpoints, dates).
 *
 * The answer arrives in pieces, so the conversion is incremental and
 * deterministic: `SpeakableStream` converts only text whose reading cannot
 * change with what follows, one piece (usually one word) at a time, and never
 * revises what it has emitted. Each piece remembers the stretch of the
 * original text it came from, so what was heard can be mapped back to the
 * answer as written (spokenPrefix.ts).
 */

const ONES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number in words ("forty-two"); digits are returned for anything past a billion. */
export function cardinalWords(n: number): string {
    if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
    if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${cardinalWords(n % 100)}` : ""}`;
    if (n < 1e6) return `${cardinalWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${cardinalWords(n % 1000)}` : ""}`;
    return `${cardinalWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${cardinalWords(n % 1e6)}` : ""}`;
}

const IRREGULAR_ORDINALS: Readonly<Record<string, string>> = {
    one: "first",
    two: "second",
    three: "third",
    five: "fifth",
    eight: "eighth",
    nine: "ninth",
    twelve: "twelfth",
};

/** An ordinal in words ("twenty-first"). */
export function ordinalWords(n: number): string {
    return cardinalWords(n).replace(
        /[a-z]+$/,
        (last) => IRREGULAR_ORDINALS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`),
    );
}

/** A year as it is said: "nineteen eighty-three", "twenty twenty-four", "two thousand five". */
export function yearWords(n: number): string {
    if (n < 1000 || n > 9999) return cardinalWords(n);
    const high = Math.floor(n / 100);
    const low = n % 100;
    if (high % 10 === 0 && low < 10) return cardinalWords(n);
    if (low === 0) return `${cardinalWords(high)} hundred`;
    return `${cardinalWords(high)} ${low < 10 ? `oh ${ONES[low]}` : cardinalWords(low)}`;
}

/** A section or rule number: small ones and four-digit ones ("1983") as said aloud. */
function numberWords(digits: string): string {
    const n = Number(digits);
    if (n < 1000) return cardinalWords(n);
    return n < 10000 ? yearWords(n) : digits;
}

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBREVIATIONS: Readonly<Record<string, number>> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Sept: 8, Oct: 9, Nov: 10, Dec: 11,
};
const MONTH = `(${MONTHS.join("|")}|(?:${Object.keys(MONTH_ABBREVIATIONS).join("|")})\\.)`;

function monthName(written: string): string {
    return MONTHS.includes(written) ? written : MONTHS[MONTH_ABBREVIATIONS[written.slice(0, -1)]];
}

function dayWords(day: string): string | null {
    const n = Number(day);
    return n >= 1 && n <= 31 ? ordinalWords(n) : null;
}

function numericDate(match: string, year: string, month: string, day: string): string {
    const m = Number(month);
    const d = dayWords(day);
    if (m < 1 || m > 12 || !d) return match;
    return `${MONTHS[m - 1]} ${d}, ${yearWords(Number(year))}`;
}

const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xvi{0,3}|xix|xx)$/;
const ROMAN_VALUES: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10 };

function romanValue(numeral: string): number {
    let total = 0;
    for (let i = 0; i < numeral.length; i++) {
        const value = ROMAN_VALUES[numeral[i]];
        const next = ROMAN_VALUES[numeral[i + 1]] ?? 0;
        total += value < next ? -value : value;
    }
    return total;
}

/** "(b)(6)" as "b six"; "(a)(ii)" as "a two". Phonon reads brackets as commas. */
function pinpointWords(groups: string): string[] {
    let afterLetter = false;
    return [...groups.matchAll(/\(([0-9A-Za-z]+)\)/g)].map(([, part]) => {
        let word: string;
        if (/^\d+$/.test(part)) word = numberWords(part);
        else if (ROMAN.test(part) && (part.length > 1 || afterLetter)) word = cardinalWords(romanValue(part));
        else word = part;
        afterLetter = /^[a-z]$/.test(word);
        return word;
    });
}

const PROCEDURE: Readonly<Record<string, string>> = {
    Civ: "Civil Procedure",
    Crim: "Criminal Procedure",
    App: "Appellate Procedure",
    Bankr: "Bankruptcy Procedure",
};

/** Words that open a sentence: after them an abbreviation's period also ends one. */
const SENTENCE_STARTERS = new Set(
    (
        "The This That These Those It Its In On At As A An We You I He She They There Their Our Your His Her " +
        "But However So If When Under Because Although Also Then Next First Finally Here For"
    ).split(" "),
);

const SENTENCE_FINAL_ABBREVIATIONS: Readonly<Record<string, string>> = {
    Inc: "Incorporated",
    Corp: "Corporation",
    Ltd: "Limited",
    Co: "Company",
    etc: "et cetera",
    Jr: "Junior",
    Sr: "Senior",
};

/** Keeps the period when nothing or a sentence follows the abbreviation. */
function sentenceEnds(after: string): boolean {
    const next = /^\s+([A-Za-z]+)/.exec(after);
    return after.trim() === "" || (!!next && SENTENCE_STARTERS.has(next[1]));
}

const ABBREVIATIONS: readonly [RegExp, string][] = [
    [/\bet al\./g, "and others"],
    [/\be\.g\./gi, "for example"],
    [/\bi\.e\./gi, "that is"],
    [/\bcf\./gi, "compare"],
    [/\bviz\./g, "namely"],
    [/\b(?:Ibid|Id)\./g, "The same source"],
    [/\b(?:ibid|id)\./g, "the same source"],
    [/\bsupra\b/gi, "above"],
    [/\binfra\b/gi, "below"],
    [/\bpassim\b/g, "throughout"],
    [/\bvs?\.|\bvs\b/g, "versus"],
    [/\bArts\./g, "Articles"],
    [/\bArt\./g, "Article"],
    [/\bSecs\./g, "Sections"],
    [/\bSect?\./g, "Section"],
    [/\b[Pp]aras\./g, "paragraphs"],
    [/\b[Pp]ara\./g, "paragraph"],
    [/\bCh\./g, "Chapter"],
    [/\bVol\./g, "Volume"],
    [/\bExh?\./g, "Exhibit"],
    [/\bFig\./g, "Figure"],
    [/\bCir\./g, "Circuit"],
    [/\bDist\./g, "District"],
    [/\bCt\./g, "Court"],
    [/\bMr\./g, "Mister"],
    [/\bMrs\./g, "Missus"],
    [/\bMs\./g, "Ms"],
    [/\bDr\./g, "Doctor"],
    [/\bapprox\./g, "approximately"],
    [/\bAtl\./g, "Atlantic"],
    [/\bBros\./g, "Brothers"],
    [/\bAss'n\b/g, "Association"],
    [/\bDep't\b/g, "Department"],
    [/\bGov't\b/g, "Government"],
    [/\bNat'l\b/g, "National"],
    [/\bInt'l\b/g, "International"],
    [/\ba\.m\./g, "A M"],
    [/\bp\.m\./g, "P M"],
    [/\band\/or\b/g, "and or"],
    [/&/g, " and "],
];

/**
 * One stretch of the answer (a word, or words that are read together) in
 * speakable form. `before` is the answer text preceding it, for readings that
 * depend on what came first (a year after "January 5,", "to" in "10 – 12").
 */
export function speakableInline(chunk: string, before = ""): string {
    let s = chunk;
    // Citation markers the server issues ([3]), and hand-typed ones it escaped (\[3\]).
    s = s.replace(/\\?\[\d{1,3}\\?\]/g, "");
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    s = s.replace(/<https?:\/\/[^>]*>|\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?'"]/g, "a link on the screen");
    s = s.replace(/`([^`]*)`/g, "$1").replace(/`/g, "");
    s = s.replace(/<\/?[A-Za-z][^>]*>/g, " ");
    s = s.replace(/\*+|~~|(^|[^\p{L}\p{N}_])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1");
    s = s.replace(/[•…]/g, (mark) => (mark === "…" ? "..." : ""));

    // Rules of procedure and the U.S. Code.
    s = s.replace(/\bFed\.\s*R\.\s*(Civ|Crim|App|Bankr)\.\s*P\./g, (_, kind: string) => `Federal Rule of ${PROCEDURE[kind]}`);
    s = s.replace(/\bFed\.\s*R\.\s*Evid\./g, "Federal Rule of Evidence");
    s = s.replace(/\bU\.S\.C\.(A\.)?/g, (_, annotated?: string) => (annotated ? "U S Code Annotated" : "U S Code"));

    // Reporters: "F.3d", "F. Supp. 2d", "N.E.2d", "L. Ed. 2d".
    s = s.replace(
        /\b(F\.\s?Supp\.|L\.\s?Ed\.|So\.|(?:[A-Z]\.\s?){1,3})\s?([234])(?:d|th)\b/g,
        (_, reporter: string, series: string) =>
            `${reporter.replace(/\./g, " ").replace(/\s+/g, " ").trim()} ${ordinalWords(Number(series))}`,
    );
    s = s.replace(/\bS\.\s?Ct\./g, "S Ct").replace(/\bF\.\s?Supp\./g, "F Supp").replace(/\bL\.\s?Ed\./g, "L Ed");

    // Sections, paragraphs, pages and numbers.
    s = s
        .replace(/§§/g, " sections ")
        .replace(/§/g, " section ")
        .replace(/¶¶/g, " paragraphs ")
        .replace(/¶/g, " paragraph ")
        .replace(/\bpp\.\s*(?=\d)/g, "pages ")
        .replace(/\bp\.\s*(?=\d)/g, "page ")
        .replace(/\bNos\.\s*(?=\d)/g, "numbers ")
        .replace(/\bNo\.\s*(?=\d)/g, "number ");
    s = s.replace(/\b(sections|paragraphs|pages)\s+(\d+[a-z]?)\s*[-–—]\s*(\d+[a-z]?)\b/g, "$1 $2 to $3");

    // "ninety (90) days": the figure repeats the words.
    const numberWord = `(?:${[...ONES, ...TENS.slice(2), "hundred", "thousand", "million"].join("|")})`;
    if (new RegExp(`\\b${numberWord}[\\s-]*$`, "i").test(before)) s = s.replace(/^\(\d+\)/, "");
    s = s.replace(new RegExp(`(\\b${numberWord}[\\s-]*)\\(\\d+\\)`, "gi"), "$1");

    // Pinpoints: "12(b)(6)", "(a)(1)", and rules like "10b-5".
    s = s.replace(/\b(\d+)((?:\([0-9A-Za-z]{1,5}\))+)/g, (_, n: string, groups: string) =>
        [numberWords(n), ...pinpointWords(groups)].join(" "),
    );
    s = s.replace(
        /(^|[\s,;])((?:\((?:[a-zA-Z]|[ivx]{2,5}|\d{1,3})\))+)(?=[\s,.;:)]|$)/g,
        (_, lead: string, groups: string) => `${lead}${pinpointWords(groups).join(" ")}`,
    );
    s = s.replace(/\b(\d+)([a-z])-(\d+)\b/g, (_, a: string, letter: string, b: string) => `${numberWords(a)} ${letter} ${numberWords(b)}`);

    // Dates: Phonon's date rules are off.
    if (new RegExp(`${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*$`).test(before)) {
        s = s.replace(/^(\d{4})\b/, (year) => yearWords(Number(year)));
    }
    s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => numericDate(m, y, mo, d));
    s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, mo: string, d: string, y: string) => numericDate(m, y, mo, d));
    s = s.replace(
        new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4})\\b)?`, "g"),
        (m, d: string, month: string, y?: string) => {
            const day = dayWords(d);
            if (!day) return m;
            return `the ${day} of ${monthName(month)}${y ? `, ${yearWords(Number(y))}` : ""}`;
        },
    );
    s = s.replace(
        new RegExp(`${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "g"),
        (m, month: string, d: string, y?: string) => {
            const day = dayWords(d);
            if (!day) return m;
            return `${monthName(month)} ${day}${y ? `, ${yearWords(Number(y))}` : ""}`;
        },
    );
    s = s.replace(new RegExp(`${MONTH}\\s+(\\d{4})\\b`, "g"), (_, month: string, y: string) => `${monthName(month)} ${yearWords(Number(y))}`);
    s = s.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.(?=[\s,;:]|$)/g, (month) => monthName(month));

    // Latin, courts, titles.
    for (const [pattern, words] of ABBREVIATIONS) s = s.replace(pattern, words);
    s = s.replace(/\b(Inc|Corp|Ltd|Co|etc|Jr|Sr)\.(?=[\s,;:)]|$)/g, (match, abbreviation: string, offset: number, all: string) =>
        SENTENCE_FINAL_ABBREVIATIONS[abbreviation] + (sentenceEnds(all.slice(offset + match.length)) ? "." : ""),
    );
    // Initialisms: "U.S." as "U S".
    s = s.replace(/\b((?:[A-Z]\.){2,})/g, (match, _letters: string, offset: number, all: string) =>
        match.replace(/\./g, " ").trim() + (sentenceEnds(all.slice(offset + match.length)) ? "." : ""),
    );
    s = s.replace(/\b(\d+)(?:st|nd|rd|th)\b/g, (_, n: string) => ordinalWords(Number(n)));

    // Dashes: Phonon deletes them. "to" in a range, a comma elsewhere.
    if (/\d\s*$/.test(before)) s = s.replace(/^[–—]\s*(?=\d)/, "to ");
    s = s.replace(/(\d)\s*[–—]\s*(?=\d)/g, "$1 to ");
    s = s.replace(/\s*(?:[–—]|--)\s*/g, ", ");
    s = s.replace(/(^|\s)-(?=\s|$)/g, "$1, ");

    return s
        .replace(/\s+/g, " ")
        .replace(/\(\s*\)/g, "")
        .replace(/\s+([.,;:!?)])/g, "$1")
        .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
        .replace(/[,;:]\s*([.!?])/g, "$1")
        .trim();
}

/** A stretch of the answer and how it is spoken. */
export interface SpeakablePiece {
    /** The original text this piece covers: [start, end). */
    start: number;
    end: number;
    /** Its speakable text, with a leading space when it follows a word. May be empty. */
    text: string;
    /** Where `text` sits in the speakable text: [textStart, textEnd). */
    textStart: number;
    textEnd: number;
}

/** Tokens read together with the next one: a boundary after them could change a reading. */
const JOINING = new Set([
    "No.", "Nos.", "p.", "pp.", "Fed.", "Civ.", "Crim.", "Evid.", "App.", "Bankr.", "Supp.", "Ed.", "So.",
    "Inc.", "Corp.", "Ltd.", "Co.", "etc.", "Jr.", "Sr.", "et", "§", "§§", "¶", "¶¶", "–", "—", "-", "--",
    ...MONTHS,
    ...Object.keys(MONTH_ABBREVIATIONS).map((month) => `${month}.`),
]);

function joinsNext(token: string): boolean {
    const bare = token.replace(/^[("'“‘*_[]+/, "");
    return JOINING.has(bare) || /^(?:[A-Z]\.)+$/.test(bare) || /^\d{1,2}$/.test(bare);
}

/** True while a link, a bracket or inline code is still open in `text`. */
function unclosed(text: string): boolean {
    const count = (char: string) => text.split(char).length - 1;
    return count("[") > count("]") || count("(") > count(")") || count("`") % 2 === 1;
}

const ON_SCREEN = "on the screen.";
const QUOTE_WORDS = 30;

type Block = "text" | "code" | "table" | "quote";

/**
 * Converts a growing answer to speakable text. `push` takes the next part of
 * the answer and returns the pieces that are now final; `finish` converts the
 * rest. The concatenated `text` of the pieces is the speakable answer, and is
 * the same however the answer was split into parts.
 */
export class SpeakableStream {
    private raw = "";
    private done = 0;
    private out = "";
    private atLineStart = true;
    private block: Block = "text";
    private quoteStart = 0;
    private spaced = false;
    private lineSpoken = false;
    private readonly all: SpeakablePiece[] = [];

    /** The answer text received so far. */
    get source(): string {
        return this.raw;
    }

    /** The speakable text emitted so far. */
    get text(): string {
        return this.out;
    }

    /** Every piece emitted so far, in order; together they cover the source up to where conversion has reached. */
    get pieces(): readonly SpeakablePiece[] {
        return this.all;
    }

    push(delta: string): SpeakablePiece[] {
        this.raw += delta;
        return this.drain(false);
    }

    finish(): SpeakablePiece[] {
        return this.drain(true);
    }

    private drain(final: boolean): SpeakablePiece[] {
        const first = this.all.length;
        while (this.done < this.raw.length && this.step(final)) {
            // Each step consumes one piece.
        }
        if (final && this.block === "quote") this.flushQuote();
        return this.all.slice(first);
    }

    private emit(end: number, text: string): void {
        const textStart = this.out.length;
        this.out += text;
        this.all.push({ start: this.done, end, text, textStart, textEnd: this.out.length });
        this.done = end;
    }

    /** Speakable words, joined to what came before with a space unless they open with punctuation. */
    private words(text: string): string {
        if (!text) return "";
        const space = this.spaced && this.out.length > 0 && !/^[.,;:!?)\]'"’”]/.test(text);
        this.spaced = false;
        this.lineSpoken = true;
        return (space ? " " : "") + text;
    }

    private onScreen(subject: string): string {
        const opens = this.out.length === 0 || /[.!?]$/.test(this.out);
        const said = `${subject} ${ON_SCREEN}`;
        this.spaced = this.out.length > 0;
        return this.words(opens ? said[0].toUpperCase() + said.slice(1) : said);
    }

    private step(final: boolean): boolean {
        if (this.atLineStart) return this.startLine(final);
        return this.textRun(final);
    }

    /** Where the current line ends (after its newline), or -1 while it has not ended. */
    private lineEnd(final: boolean): number {
        const newline = this.raw.indexOf("\n", this.done);
        if (newline !== -1) return newline + 1;
        return final ? this.raw.length : -1;
    }

    /** Emits a whole line; what follows it is a new word. */
    private emitLine(end: number, text: string): void {
        this.emit(end, text);
        this.spaced = true;
    }

    private startLine(final: boolean): boolean {
        const rest = this.raw.slice(this.done);
        const lineEnd = this.lineEnd(final);
        // Classifying a line needs its first word, or the whole line.
        if (lineEnd === -1 && !/^\s*\S+\s/.test(rest)) return false;
        const fence = /^[^\S\n]*(?:```|~~~)/.test(rest);
        const quoted = /^[^\S\n]*>/.test(rest);

        if (this.block === "code") {
            if (lineEnd === -1) return false;
            if (fence) this.block = "text";
            this.emitLine(lineEnd, "");
            return true;
        }
        if (this.block === "quote" && !quoted) this.flushQuote();
        if (quoted) {
            // A quote is spoken (or not) as a whole, once it has ended.
            if (lineEnd === -1) return false;
            if (this.block !== "quote") this.quoteStart = this.done;
            this.block = "quote";
            this.done = lineEnd;
            return true;
        }

        const table = /^[^\S\n]*\|/.test(rest);
        const rule = /^[^\S\n]*([-*_])(?:[^\S\n]*\1){2,}[^\S\n]*(?:\n|$)/.test(rest);
        if (fence || table || rule) {
            if (lineEnd === -1) return false;
            const first = fence || (table && this.block !== "table");
            this.block = fence ? "code" : table ? "table" : "text";
            this.emitLine(lineEnd, first ? this.onScreen("it's") : "");
            return true;
        }
        this.block = "text";

        const marker = /^[^\S\n]*(?:#{1,6}[^\S\n]+|(?:[-*+•]|\d{1,3}[.)])[^\S\n]+)?/.exec(rest)![0];
        this.atLineStart = false;
        this.lineSpoken = false;
        if (marker.length > 0) this.emit(this.done + marker.length, "");
        return true;
    }

    private flushQuote(): void {
        const quote = this.raw.slice(this.quoteStart, this.done);
        const content = quote.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ").trim();
        const spoken = speakableInline(content, this.raw.slice(0, this.quoteStart));
        const count = spoken.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
        const end = this.done;
        this.done = this.quoteStart;
        this.block = "text";
        if (count > QUOTE_WORDS) {
            this.emitLine(end, this.onScreen("the quote is"));
        } else {
            this.spaced = this.out.length > 0;
            const text = this.words(spoken);
            this.emitLine(end, text && !/[.!?,;:]$/.test(text) ? `${text}.` : text);
        }
    }

    private textRun(final: boolean): boolean {
        const raw = this.raw;
        const space = /^[^\S\n]*\n?/.exec(raw.slice(this.done))![0];
        if (space.length > 0) {
            const newline = space.endsWith("\n");
            this.spaced = true;
            let text = "";
            if (newline) {
                this.atLineStart = true;
                if (this.lineSpoken && !/[.!?,;:]["'”’)\]]*$/.test(this.out)) text = ".";
            }
            this.emit(this.done + space.length, text);
            return true;
        }
        const tokens = /\S+/g;
        tokens.lastIndex = this.done;
        // Each pass reads one more word; there always is one (the text here is not whitespace).
        for (;;) {
            const match = tokens.exec(raw)!;
            const end = match.index + match[0].length;
            const after = /^[^\S\n]*/.exec(raw.slice(end))![0];
            const next = end + after.length;
            // A word is complete once something follows it, or the answer has ended.
            if (next === raw.length && after.length === 0 && !final) return false;
            const lineEnds = raw[next] === "\n" || (next === raw.length && final);
            const chunk = raw.slice(this.done, end);
            if (lineEnds || (next < raw.length && !joinsNext(match[0]) && !unclosed(chunk))) {
                this.emit(end, this.words(speakableInline(chunk, raw.slice(Math.max(0, this.done - 80), this.done))));
                return true;
            }
            if (next === raw.length) return false;
        }
    }
}

/** The speakable form of a whole answer. */
export function speakable(markdown: string): string {
    const stream = new SpeakableStream();
    stream.push(markdown);
    stream.finish();
    return stream.text;
}
