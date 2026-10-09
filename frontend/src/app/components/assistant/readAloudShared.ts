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
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5] as const;

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

export interface UseReadAloudState {
    /** A reading session is active: started, not stopped or finished. */
    playing: boolean;
    /** The active session is held at the current sentence. */
    paused: boolean;
    /** 0-based index of the sentence being spoken. */
    sentenceIndex: number;
    sentenceCount: number;
    /** Playback rate, 0.75 | 1 | 1.25 | 1.5. Applied to live audio too. */
    speed: number;
    error: string | null;
}

export interface UseReadAloudControls {
    /** Starts a fresh session from the first sentence. */
    play: () => void;
    /** Holds the current sentence; playback resumes where it stopped. */
    pause: () => void;
    resume: () => void;
    /** Ends the session, revokes every object URL, resets progress. */
    stop: () => void;
    setSpeed: (speed: number) => void;
    /** Starts a session at a specific sentence (0-based). */
    playFrom: (index: number) => void;
}

export type UseReadAloud = UseReadAloudState & UseReadAloudControls;
