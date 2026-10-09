import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { synthesizeSpeech } from "@/app/lib/mikeApi";

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

const DEFAULT_SPEED = 1;

const PLAYBACK_FAILED_MESSAGE = "Playback failed.";

function readAloudErrorMessage(cause: unknown): string {
    if (typeof cause === "string" && cause) return cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return "Could not read this response aloud.";
}

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

/**
 * Reads a response aloud sentence by sentence.
 *
 * The caller hands over plain prose. Sentences are synthesized lazily — when
 * playback reaches sentence i, and one sentence ahead while it plays — and
 * cached per index, so backtracking replays without re-billing the engine.
 * A single HTMLAudioElement plays one object URL at a time; URLs are revoked
 * as playback advances and on stop, so nothing leaks.
 */
export function useReadAloud(text: string): UseReadAloud {
    const sentences = useMemo(() => splitIntoReadAloudSentences(text), [text]);

    const [playing, setPlaying] = useState(false);
    const [paused, setPausedState] = useState(false);
    const [sentenceIndex, setSentenceIndex] = useState(0);
    const [speed, setSpeedState] = useState<number>(DEFAULT_SPEED);
    const [error, setError] = useState<string | null>(null);

    const sentencesRef = useRef(sentences);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const blobCacheRef = useRef(new Map<number, Blob>());
    const urlRef = useRef(new Map<number, string>());
    const speedRef = useRef<number>(DEFAULT_SPEED);
    // Session token: bumped on every start/stop. Async continuations compare
    // it before touching the audio element or state, so a stale fetch from an
    // aborted session can never play (or cache) against the current one.
    const generationRef = useRef(0);
    const sessionRef = useRef({ active: false, paused: false });
    // Mirrors `error`, so the prose-change reset can tell whether there is
    // anything to reset without depending on (and re-running for) the state.
    const errorRef = useRef<string | null>(null);
    // playAt schedules the next sentence from the audio's `ended` handler;
    // a callback cannot name itself, so the handler goes through this ref.
    const playAtRef = useRef<(index: number, generation: number) => Promise<void>>(
        async () => undefined,
    );

    useEffect(() => {
        sentencesRef.current = sentences;
    }, [sentences]);

    const releaseUrls = useCallback(() => {
        for (const url of urlRef.current.values()) URL.revokeObjectURL(url);
        urlRef.current.clear();
    }, []);

    const stopInternal = useCallback(() => {
        generationRef.current += 1;
        sessionRef.current.active = false;
        sessionRef.current.paused = false;
        const audio = audioRef.current;
        if (audio) {
            audio.onended = null;
            audio.onerror = null;
            audio.removeAttribute("src");
            try {
                audio.pause();
            } catch {
                // A never-started element cannot be paused; the session
                // flags above are the source of truth either way.
            }
        }
        releaseUrls();
        setPlaying(false);
        setPausedState(false);
        setSentenceIndex(0);
        errorRef.current = null;
        setError(null);
    }, [releaseUrls]);

    const fail = useCallback(
        (cause: unknown) => {
            if (!sessionRef.current.active) return;
            stopInternal();
            const message = readAloudErrorMessage(cause);
            errorRef.current = message;
            setError(message);
        },
        [stopInternal],
    );

    // New prose invalidates every cached blob and kills any session: text
    // from a previous body must never be spoken underneath the new one. A
    // streaming answer changes its prose on every chunk, so reset only when
    // there is a session or an error to clear: dispatching even unchanged
    // state from this effect on each chunk exceeds React's nested
    // passive-update limit ("Maximum update depth exceeded").
    useEffect(() => {
        blobCacheRef.current.clear();
        if (sessionRef.current.active || errorRef.current !== null) {
            // Stopping pauses audio and revokes object URLs, which are effects;
            // the state it resets goes with them.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            stopInternal();
        }
    }, [sentences, stopInternal]);

    // Silence whatever is playing when the message unmounts.
    useEffect(() => () => stopInternal(), [stopInternal]);

    const ensureAudio = useCallback(() => {
        if (audioRef.current) return audioRef.current;
        const audio = new Audio();
        audio.preload = "auto";
        audio.playbackRate = speedRef.current;
        audioRef.current = audio;
        return audio;
    }, []);

    const loadSentence = useCallback(
        async (index: number, generation: number): Promise<Blob> => {
            const cached = blobCacheRef.current.get(index);
            if (cached) return cached;
            const blob = await synthesizeSpeech(sentencesRef.current[index]);
            if (generation === generationRef.current) {
                blobCacheRef.current.set(index, blob);
            }
            return blob;
        },
        [],
    );

    const prefetch = useCallback((index: number, generation: number) => {
        if (index >= sentencesRef.current.length) return;
        if (blobCacheRef.current.has(index)) return;
        synthesizeSpeech(sentencesRef.current[index])
            .then((blob) => {
                if (generation === generationRef.current) {
                    blobCacheRef.current.set(index, blob);
                }
            })
            .catch(() => {
                // Prefetch is best-effort: if it fails, playAt retries the
                // sentence (and surfaces the error) when playback reaches it.
            });
    }, []);

    const playAt = useCallback(
        async (index: number, generation: number) => {
            if (generation !== generationRef.current) return;
            if (index >= sentencesRef.current.length) {
                // Ran off the end of the response: clean up like stop().
                stopInternal();
                return;
            }

            let blob: Blob;
            try {
                blob = await loadSentence(index, generation);
            } catch (cause) {
                if (generation !== generationRef.current) return;
                fail(cause);
                return;
            }
            if (generation !== generationRef.current) return;

            const audio = ensureAudio();
            releaseUrls();
            const url = URL.createObjectURL(blob);
            urlRef.current.set(index, url);

            setSentenceIndex(index);
            audio.onended = () => {
                if (generation === generationRef.current) {
                    void playAtRef.current(index + 1, generation);
                }
            };
            audio.onerror = () => {
                if (generation === generationRef.current) {
                    fail(PLAYBACK_FAILED_MESSAGE);
                }
            };
            audio.src = url;
            audio.playbackRate = speedRef.current;

            if (sessionRef.current.paused) {
                // Paused while the sentence was still being synthesized:
                // hold it at the start; resume() plays it.
                return;
            }
            try {
                await audio.play();
            } catch (cause) {
                if (generation !== generationRef.current) return;
                fail(cause);
                return;
            }
            if (generation !== generationRef.current) return;
            prefetch(index + 1, generation);
        },
        [ensureAudio, fail, loadSentence, prefetch, releaseUrls, stopInternal],
    );

    useEffect(() => {
        playAtRef.current = playAt;
    }, [playAt]);

    const playFrom = useCallback(
        (index: number) => {
            const count = sentencesRef.current.length;
            if (count === 0) return;
            const start = Math.min(Math.max(index, 0), count - 1);
            const generation = generationRef.current + 1;
            generationRef.current = generation;
            sessionRef.current.active = true;
            sessionRef.current.paused = false;
            setError(null);
            setPlaying(true);
            setPausedState(false);
            setSentenceIndex(start);
            void playAt(start, generation);
        },
        [playAt],
    );

    const play = useCallback(() => playFrom(0), [playFrom]);

    const pause = useCallback(() => {
        if (!sessionRef.current.active) return;
        sessionRef.current.paused = true;
        setPausedState(true);
        const audio = audioRef.current;
        if (audio) {
            try {
                audio.pause();
            } catch {
                // Nothing to pause yet; the paused flag above still holds
                // playAt back from starting the sentence.
            }
        }
    }, []);

    const resume = useCallback(() => {
        if (!sessionRef.current.active) return;
        sessionRef.current.paused = false;
        setPausedState(false);
        const audio = audioRef.current;
        if (!audio || !audio.src) return; // still synthesizing; playAt starts it
        const generation = generationRef.current;
        Promise.resolve(audio.play()).catch((cause: unknown) => {
            if (generation === generationRef.current) fail(cause);
        });
    }, [fail]);

    const setSpeed = useCallback((next: number) => {
        speedRef.current = next;
        setSpeedState(next);
        const audio = audioRef.current;
        if (audio) audio.playbackRate = next;
    }, []);

    const stop = useCallback(() => stopInternal(), [stopInternal]);

    return {
        playing,
        paused,
        sentenceIndex,
        sentenceCount: sentences.length,
        speed,
        error,
        play,
        pause,
        resume,
        stop,
        setSpeed,
        playFrom,
    };
}
