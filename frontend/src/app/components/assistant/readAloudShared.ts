/** Shared by the read-aloud engines (useReadAloud, useBrowserReadAloud). */

/**
 * The end of a sentence: `.`, `!` or `?` (and any closing quote or bracket)
 * followed by whitespace or the end of the text. A full stop inside a word
 * ("3.5", "index.ts", "example.com/a.html") is not one.
 */
const SENTENCE_END = /[.!?]+["'\u201d\u2019)\]]*(?=\s|$)/g;

/** A line that starts a list item, heading, quote or table row. */
const BLOCK_START = /^[ \t]*(?:[-*+>#|]|\d+[.)][ \t])/;
/** A heading or table row: a block of one line. */
const ONE_LINE_BLOCK = /^[ \t]*[#|]/;

/**
 * The text's blocks: paragraphs (split at blank lines), list items, headings,
 * quotes and table rows. A line break inside a paragraph or list item is
 * only wrapping, so its lines are joined.
 */
function textBlocks(text: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
        if (current.length) blocks.push(current.join(" "));
        current = [];
    };
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            flush();
            continue;
        }
        if (BLOCK_START.test(line)) flush();
        current.push(line);
        if (ONE_LINE_BLOCK.test(line)) flush();
    }
    flush();
    return blocks;
}

/** Playback rates offered by the read-aloud control; 1 is engine default. */
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;
export const DEFAULT_READ_ALOUD_SPEED = 1;

/** A saved speed, or the default when it is not one the control offers. */
export function readAloudSpeed(value: number | undefined): number {
    return (READ_ALOUD_SPEEDS as readonly number[]).includes(value ?? Number.NaN)
        ? (value as number)
        : DEFAULT_READ_ALOUD_SPEED;
}

/**
 * The whole text as sentences, in order. Nothing is dropped: every
 * character but whitespace lands in exactly one sentence, however long the
 * response.
 */
export function splitIntoReadAloudSentences(text: string): string[] {
    const sentences: string[] = [];
    for (const block of textBlocks(text)) {
        const flat = block.replace(/\s+/g, " ").trim();
        if (!flat) continue;
        let start = 0;
        SENTENCE_END.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SENTENCE_END.exec(flat)) !== null) {
            const end = match.index + match[0].length;
            const sentence = flat.slice(start, end).trim();
            // A list item's own number ("1.") is not a sentence.
            if (/^\d+[.)]$/.test(sentence)) continue;
            if (sentence) sentences.push(sentence);
            start = end;
        }
        const tail = flat.slice(start).trim();
        if (tail) sentences.push(tail);
    }
    return sentences;
}

/**
 * idle: nothing playing (a finished or stopped reading). preparing: the
 * audio is being synthesized. playing / paused: the reading is under way.
 */
export type ReadAloudStatus = "idle" | "preparing" | "playing" | "paused";

export interface UseReadAloudState {
    /** There is prose to read. */
    available: boolean;
    status: ReadAloudStatus;
    /** Share of the audio synthesized so far, 0 to 1, while preparing. */
    prepared: number;
    /**
     * Where the reading is, out of `length`: seconds of one audio file, or,
     * for the browser's own voices, sentences.
     */
    position: number;
    length: number;
    unit: "seconds" | "sentences";
    /** Playback rate, one of READ_ALOUD_SPEEDS. */
    speed: number;
    error: string | null;
}

export interface UseReadAloudControls {
    /** Starts reading from the beginning. Call it from the tap itself. */
    play: () => void;
    pause: () => void;
    resume: () => void;
    /** Stops and returns to the beginning; synthesized audio is kept for a replay. */
    stop: () => void;
    /** Moves to a position, in `unit`s. */
    seek: (position: number) => void;
    setSpeed: (speed: number) => void;
}

export type UseReadAloud = UseReadAloudState & UseReadAloudControls;

/** A short title for the lock screen: the first sentence, shortened. */
export function readAloudTitle(text: string): string {
    const first = splitIntoReadAloudSentences(text)[0] ?? "";
    return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}
