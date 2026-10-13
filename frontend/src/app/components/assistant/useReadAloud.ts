import { brand } from "@/app/lib/brand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { BrowserModelError } from "@/app/lib/voice/browserModels";
import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import { speechRenderPlan, synthesizeSentence } from "@/app/lib/voice/engines";
import { useVoicePreferences, type VoicePreferences } from "@/app/lib/voice/preferences";
import {
    chunkSentences,
    decodeToMono,
    segmentSeconds,
    segmentWav,
    silentWav,
} from "@/app/lib/voice/speechAudio";
import { useBrowserReadAloud } from "./useBrowserReadAloud";
import {
    readAloudSpeed,
    readAloudTitle,
    splitIntoReadAloudSentences,
    type ReadAloudStatus,
    type UseReadAloud,
} from "./readAloudShared";

export {
    READ_ALOUD_SPEEDS,
    splitIntoReadAloudSentences,
} from "./readAloudShared";
export type {
    ReadAloudStatus,
    UseReadAloud,
    UseReadAloudControls,
    UseReadAloudState,
} from "./readAloudShared";

const READ_ALOUD_FAILED_MESSAGE = "Could not read this response aloud.";
const PLAYBACK_BLOCKED_MESSAGE = "The browser did not allow playback. Tap play again.";
const PLAYBACK_FAILED_MESSAGE = "Playback failed.";
/** Lock-screen skip, in seconds. */
const SKIP_SECONDS = 10;
/**
 * The first segment's length in characters: short, so the reading starts as
 * soon as a sentence or two is ready while the rest is synthesized behind it.
 */
const FIRST_SEGMENT_CHARS = 200;

function readAloudErrorMessage(cause: unknown): string {
    if (typeof cause === "string") return cause;
    if (cause instanceof BrowserModelError || cause instanceof DeviceSpeechError) return cause.message;
    if (cause instanceof DOMException && cause.name === "NotAllowedError") return PLAYBACK_BLOCKED_MESSAGE;
    return userFacingApiError(cause, READ_ALOUD_FAILED_MESSAGE);
}

/**
 * Reads a response aloud with the engine chosen in Settings → Voice: the
 * browser's own voices, or audio from the operator, OpenRouter or a model
 * in the browser. Both hooks are always called (hooks cannot be
 * conditional); the one not in use stays idle. The speed is the one last
 * chosen on this device, for every reading.
 */
export function useReadAloud(text: string): UseReadAloud {
    const [preferences, setPreferences] = useVoicePreferences();
    const browser = preferences.speech.engine === "browser";
    const speed = readAloudSpeed(preferences.readAloudRate);
    const latestPreferences = useRef(preferences);
    useEffect(() => {
        latestPreferences.current = preferences;
    }, [preferences]);
    const rememberSpeed = useCallback(
        (next: number) => setPreferences({ ...latestPreferences.current, readAloudRate: next }),
        [setPreferences],
    );
    const audio = useAudioReadAloud(browser ? "" : text, preferences.speech, speed, rememberSpeed);
    const spoken = useBrowserReadAloud(browser ? text : "", preferences.speech.voice, speed, rememberSpeed);
    return browser ? spoken : audio;
}

type MediaAction = "play" | "pause" | "stop" | "seekto" | "seekbackward" | "seekforward";

function mediaSession(): MediaSession | null {
    return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
}

function setMediaSession(title: string | null, handlers: Partial<Record<MediaAction, MediaSessionActionHandler>>): void {
    const session = mediaSession();
    if (!session) return;
    try {
        session.metadata =
            title !== null && typeof MediaMetadata !== "undefined" ? new MediaMetadata({ title, artist: brand.name }) : null;
        const actions: MediaAction[] = ["play", "pause", "stop", "seekto", "seekbackward", "seekforward"];
        for (const action of actions) session.setActionHandler(action, handlers[action] ?? null);
    } catch {
        // An action this browser does not know; the in-page controls still work.
    }
}

/** One reading's segments: synthesized lazily, kept for a replay. */
interface Reading {
    key: string;
    chunks: string[];
    /** Each segment's audio and length in seconds, once synthesized. */
    segments: ({ blob: Blob; seconds: number } | undefined)[];
    /** Segments being synthesized now. */
    pending: Set<number>;
}

/**
 * Reads a response aloud as a run of audio segments in one audio element.
 * The text is cut into chunks (a short first one), and playback starts as
 * soon as the first is synthesized; the rest are synthesized a few ahead of
 * where the reading is, so a long answer starts as quickly as a short one,
 * and stopping early stops the synthesis (and the billing). Position, length
 * and seeking are in seconds across the whole reading; until every segment
 * exists the length is estimated from the text, and a seek can only reach
 * audio that exists. Synthesized segments are kept, so playing again does
 * not synthesize again. The element keeps playing in the background, with
 * lock-screen controls through the Media Session API.
 *
 * iOS lets an element play only from a tap, and synthesis outlasts the tap,
 * so the tap first plays a moment of silence on the element; after that the
 * element may start each segment when it is ready.
 */
function useAudioReadAloud(
    text: string,
    speech: VoicePreferences["speech"],
    speed: number,
    rememberSpeed: (speed: number) => void,
): UseReadAloud {
    const sentences = useMemo(() => splitIntoReadAloudSentences(text), [text]);
    const key = useMemo(
        () => JSON.stringify([speech.engine, speech.model ?? "", speech.voice ?? "", text]),
        [speech.engine, speech.model, speech.voice, text],
    );

    const [status, setStatusState] = useState<ReadAloudStatus>("idle");
    const [prepared, setPrepared] = useState(0);
    const [position, setPositionState] = useState(0);
    const [length, setLength] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef<string | null>(null);
    const silentUrlRef = useRef<string | null>(null);
    const readingRef = useRef<Reading | null>(null);
    /** The segment playing, or the one the reading waits for. */
    const segmentRef = useRef(0);
    /** The reading waits for segmentRef's audio. */
    const waitingRef = useRef(false);
    const statusRef = useRef<ReadAloudStatus>("idle");
    const positionRef = useRef(0);
    const speedRef = useRef(speed);
    // Bumped by every play and stop: work from an older session compares
    // it before touching the element.
    const generationRef = useRef(0);
    const activeRef = useRef(false);
    const errorRef = useRef<string | null>(null);
    const latest = useRef({ sentences, key, speech, title: readAloudTitle(text) });
    useEffect(() => {
        latest.current = { sentences, key, speech, title: readAloudTitle(text) };
    }, [sentences, key, speech, text]);
    useEffect(() => {
        speedRef.current = speed;
        if (audioRef.current) audioRef.current.playbackRate = speed;
    }, [speed]);

    const setStatus = useCallback((next: ReadAloudStatus) => {
        statusRef.current = next;
        setStatusState(next);
    }, []);
    const setPosition = useCallback((next: number) => {
        positionRef.current = next;
        setPositionState(next);
    }, []);

    const ensureAudio = useCallback(() => {
        if (!audioRef.current) {
            const audio = new Audio();
            audio.preload = "auto";
            audioRef.current = audio;
        }
        return audioRef.current;
    }, []);

    const releaseUrl = useCallback(() => {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
    }, []);

    /** Where segment `index` starts, in seconds; every earlier one exists. */
    const offsetOf = useCallback((reading: Reading, index: number) => {
        let offset = 0;
        for (let i = 0; i < index; i++) offset += reading.segments[i]?.seconds ?? 0;
        return offset;
    }, []);

    /** The whole reading's length: exact once synthesized, estimated from the text before. */
    const updateLength = useCallback((reading: Reading) => {
        let seconds = 0;
        let chars = 0;
        let remaining = 0;
        reading.chunks.forEach((chunk, i) => {
            const segment = reading.segments[i];
            if (segment) {
                seconds += segment.seconds;
                chars += chunk.length;
            } else {
                remaining += chunk.length;
            }
        });
        setLength(chars > 0 ? seconds + (remaining * seconds) / chars : 0);
        setPrepared(reading.segments.filter(Boolean).length / Math.max(reading.chunks.length, 1));
    }, []);

    const halt = useCallback(() => {
        generationRef.current += 1;
        activeRef.current = false;
        waitingRef.current = false;
        const audio = audioRef.current;
        if (audio) {
            audio.onplay = audio.onpause = audio.ontimeupdate = null;
            audio.onended = audio.onerror = audio.onloadedmetadata = null;
            try {
                audio.pause();
            } catch {
                // Never started; nothing to pause.
            }
            audio.removeAttribute("src");
        }
        releaseUrl();
        setMediaSession(null, {});
        setStatus("idle");
        setPrepared(0);
        setPosition(0);
    }, [releaseUrl, setPosition, setStatus]);

    const fail = useCallback(
        (cause: unknown) => {
            halt();
            const message = readAloudErrorMessage(cause);
            errorRef.current = message;
            setError(message);
        },
        [halt],
    );

    // New prose or another engine: drop the segments and silence this
    // message. A streaming answer changes its prose on every chunk, so only
    // reset when there is something to reset.
    useEffect(() => {
        readingRef.current = null;
        if (activeRef.current || errorRef.current !== null) {
            // Stopping pauses audio and revokes its URL, which are effects.
            halt();
            errorRef.current = null;
            setError(null);
        }
    }, [key, halt]);

    useEffect(
        () => () => {
            halt();
            if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current);
        },
        [halt],
    );

    const controls = useRef<{
        pause: () => void;
        resume: () => void;
        seek: (to: number) => void;
        stop: () => void;
        playSegment: (index: number, offset: number, autoplay: boolean) => void;
        pump: () => void;
    }>({ pause: () => {}, resume: () => {}, seek: () => {}, stop: () => {}, playSegment: () => {}, pump: () => {} });

    /** Synthesizes the next segments, up to a few ahead of the reading. */
    const pump = useCallback(() => {
        const reading = readingRef.current;
        if (!reading || !activeRef.current) return;
        const { concurrency } = speechRenderPlan(latest.current.speech);
        const speechNow = latest.current.speech;
        const horizon = segmentRef.current + concurrency + 1;
        for (let i = segmentRef.current; i < reading.chunks.length && i <= horizon; i++) {
            if (reading.pending.size >= concurrency) return;
            if (reading.segments[i] || reading.pending.has(i)) continue;
            reading.pending.add(i);
            synthesizeSentence(reading.chunks[i]!, speechNow)
                .then((blob) => decodeToMono(blob))
                .then((samples) => {
                    reading.pending.delete(i);
                    reading.segments[i] = { blob: segmentWav(samples), seconds: segmentSeconds(samples) };
                    if (readingRef.current !== reading || !activeRef.current) return;
                    updateLength(reading);
                    if (waitingRef.current && segmentRef.current === i) controls.current.playSegment(i, 0, true);
                    controls.current.pump();
                })
                .catch((cause: unknown) => {
                    reading.pending.delete(i);
                    if (readingRef.current !== reading || !activeRef.current) return;
                    fail(cause);
                });
        }
    }, [fail, updateLength]);

    /** The reading reached the end of segment `index`: on to the next. */
    const advance = useCallback(
        (index: number) => {
            const reading = readingRef.current;
            if (!reading) return;
            const next = index + 1;
            if (next >= reading.chunks.length) {
                halt();
                return;
            }
            if (reading.segments[next]) {
                controls.current.playSegment(next, 0, true);
            } else {
                segmentRef.current = next;
                waitingRef.current = true;
                setStatus("preparing");
            }
            pump();
        },
        [halt, pump, setStatus],
    );

    /** Loads segment `index` into the element at `offset` seconds, playing unless told not to. */
    const playSegment = useCallback(
        (index: number, offset: number, autoplay: boolean) => {
            const reading = readingRef.current;
            const segment = reading?.segments[index];
            if (!reading || !segment) return;
            const audio = ensureAudio();
            releaseUrl();
            const url = URL.createObjectURL(segment.blob);
            urlRef.current = url;
            segmentRef.current = index;
            waitingRef.current = false;
            const generation = generationRef.current;
            const start = offsetOf(reading, index);
            const current = () => generation === generationRef.current && segmentRef.current === index;
            audio.onplay = () => current() && setStatus("playing");
            audio.onpause = () => current() && !audio.ended && setStatus("paused");
            audio.ontimeupdate = () => current() && setPosition(start + audio.currentTime);
            audio.onended = () => current() && advance(index);
            audio.onerror = () => current() && fail(PLAYBACK_FAILED_MESSAGE);
            audio.onloadedmetadata = () => {
                if (current() && offset > 0) audio.currentTime = offset;
            };
            audio.src = url;
            audio.playbackRate = speedRef.current;
            if (offset > 0) audio.currentTime = offset;
            setPosition(start + offset);
            const { pause, resume, seek, stop } = controls.current;
            setMediaSession(latest.current.title, {
                play: resume,
                pause,
                stop,
                seekto: (details) => seek(details.seekTime ?? 0),
                seekbackward: () => seek(positionRef.current - SKIP_SECONDS),
                seekforward: () => seek(positionRef.current + SKIP_SECONDS),
            });
            if (!autoplay) {
                setStatus("paused");
                return;
            }
            setStatus("playing");
            Promise.resolve(audio.play()).catch((cause: unknown) => {
                if (current()) fail(cause);
            });
        },
        [advance, ensureAudio, fail, offsetOf, releaseUrl, setPosition, setStatus],
    );

    const play = useCallback(() => {
        const { sentences, key, speech } = latest.current;
        if (sentences.length === 0) return;
        let reading = readingRef.current;
        if (!reading || reading.key !== key) {
            const plan = speechRenderPlan(speech);
            const chunks = chunkSentences(sentences, plan.maxChars, FIRST_SEGMENT_CHARS);
            reading = { key, chunks, segments: new Array(chunks.length), pending: new Set() };
            readingRef.current = reading;
        }
        generationRef.current += 1;
        activeRef.current = true;
        errorRef.current = null;
        setError(null);
        setPosition(0);
        segmentRef.current = 0;
        updateLength(reading);
        if (reading.segments[0]) {
            playSegment(0, 0, true);
            pump();
            return;
        }
        // Inside the tap: a moment of silence, so iOS lets this element play
        // the real audio once the first segment is synthesized.
        const audio = ensureAudio();
        if (!silentUrlRef.current) silentUrlRef.current = URL.createObjectURL(silentWav());
        audio.src = silentUrlRef.current;
        Promise.resolve(audio.play()).catch(() => undefined);
        waitingRef.current = true;
        setStatus("preparing");
        pump();
    }, [ensureAudio, playSegment, pump, setPosition, setStatus, updateLength]);

    const pause = useCallback(() => {
        const audio = audioRef.current;
        if (!activeRef.current || !audio || !urlRef.current || waitingRef.current) return;
        audio.pause();
        setStatus("paused");
    }, [setStatus]);

    const resume = useCallback(() => {
        const audio = audioRef.current;
        if (!activeRef.current || !audio || !urlRef.current || waitingRef.current) return;
        const generation = generationRef.current;
        setStatus("playing");
        Promise.resolve(audio.play()).catch((cause: unknown) => {
            if (generation === generationRef.current) fail(cause);
        });
    }, [fail, setStatus]);

    const seek = useCallback(
        (to: number) => {
            const audio = audioRef.current;
            const reading = readingRef.current;
            if (!activeRef.current || !audio || !reading || !urlRef.current || waitingRef.current) return;
            // Only audio that exists can be reached: the run of segments from the start.
            let ready = 0;
            while (ready < reading.chunks.length && reading.segments[ready]) ready += 1;
            const end = offsetOf(reading, ready);
            const target = Math.min(Math.max(to, 0), end);
            let index = 0;
            while (index < ready - 1 && offsetOf(reading, index + 1) <= target) index += 1;
            const within = Math.min(target - offsetOf(reading, index), reading.segments[index]!.seconds);
            if (index === segmentRef.current) {
                audio.currentTime = within;
                setPosition(offsetOf(reading, index) + within);
                return;
            }
            playSegment(index, within, statusRef.current !== "paused");
            pump();
        },
        [offsetOf, playSegment, pump, setPosition],
    );

    const stop = useCallback(() => halt(), [halt]);

    const setSpeed = useCallback(
        (next: number) => {
            speedRef.current = next;
            if (audioRef.current) audioRef.current.playbackRate = next;
            rememberSpeed(next);
        },
        [rememberSpeed],
    );

    useEffect(() => {
        controls.current = { pause, resume, seek, stop, playSegment, pump };
    }, [pause, resume, seek, stop, playSegment, pump]);

    return {
        available: sentences.length > 0,
        status,
        prepared,
        position,
        length,
        unit: "seconds",
        speed,
        error,
        play,
        pause,
        resume,
        stop,
        seek,
        setSpeed,
    };
}
