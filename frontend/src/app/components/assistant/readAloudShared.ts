/** Shared by the read-aloud engines (useReadAloud, useBrowserReadAloud). */

/**
 * Sentence boundary: a run of non-terminator characters followed by one or
 * more `.` / `!` / `?`. Text after the last terminator (terse answers, or a
 * stream that ended mid-sentence) is kept as its own sentence by the
 * splitter below, so no prose is silently dropped.
 */
const SENTENCE_PATTERN = /[^.!?]+[.!?]+/g;

/**
 * Hard cap on how much of one response will be spoken: a pathological reply
 * (say, a giant table dump) must not queue hundreds of synthesis calls.
 */
export const MAX_READ_ALOUD_SENTENCES = 200;

/** Playback rates offered by the read-aloud control; 1 is engine default. */
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;

export function splitIntoReadAloudSentences(text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const sentences: string[] = [];
    SENTENCE_PATTERN.lastIndex = 0;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_PATTERN.exec(trimmed)) !== null) {
        const sentence = match[0].trim();
        if (sentence) sentences.push(sentence);
        consumed = match.index + match[0].length;
    }
    const tail = trimmed.slice(consumed).trim();
    if (tail) sentences.push(tail);
    if (sentences.length === 0) sentences.push(trimmed);
    return sentences.slice(0, MAX_READ_ALOUD_SENTENCES);
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
