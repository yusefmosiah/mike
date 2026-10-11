import { brand } from "@/app/lib/brand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { BrowserModelError } from "@/app/lib/voice/browserModels";
import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import { speechRenderPlan, synthesizeSentence } from "@/app/lib/voice/engines";
import { useVoicePreferences, type VoicePreferences } from "@/app/lib/voice/preferences";
import {
    chunkSentences,
    renderSpeech,
    silentWav,
    SpeechRenderCancelled,
} from "@/app/lib/voice/speechAudio";
import { useBrowserReadAloud } from "./useBrowserReadAloud";
import {
    readAloudTitle,
    splitIntoReadAloudSentences,
    type ReadAloudStatus,
    type UseReadAloud,
} from "./readAloudShared";

export {
    MAX_READ_ALOUD_SENTENCES,
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
 * conditional); the one not in use stays idle.
 */
export function useReadAloud(text: string): UseReadAloud {
    const [preferences] = useVoicePreferences();
    const browser = preferences.speech.engine === "browser";
    const audio = useAudioReadAloud(browser ? "" : text, preferences.speech);
    const spoken = useBrowserReadAloud(browser ? text : "", preferences.speech.voice);
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

/**
 * Reads a response aloud as one audio file. The first play synthesizes the
 * whole response (in chunks, a few at a time for server engines), joins it
 * into one WAV and plays it in a single audio element: it can be sought,
 * paused, sped up, and keeps playing in the background, with lock-screen
 * controls through the Media Session API. The file is kept, so playing
 * again does not synthesize (or bill) again.
 *
 * iOS lets an element play only from a tap, and synthesis outlasts the tap,
 * so the tap first plays a moment of silence on the element; after that the
 * element may start the real audio when it is ready.
 */
function useAudioReadAloud(text: string, speech: VoicePreferences["speech"]): UseReadAloud {
    const sentences = useMemo(() => splitIntoReadAloudSentences(text), [text]);
    const key = useMemo(
        () => JSON.stringify([speech.engine, speech.model ?? "", speech.voice ?? "", text]),
        [speech.engine, speech.model, speech.voice, text],
    );

    const [status, setStatus] = useState<ReadAloudStatus>("idle");
    const [prepared, setPrepared] = useState(0);
    const [position, setPosition] = useState(0);
    const [length, setLength] = useState(0);
    const [speed, setSpeedState] = useState(1);
    const [error, setError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef<string | null>(null);
    const silentUrlRef = useRef<string | null>(null);
    const renderedRef = useRef<{ key: string; blob: Blob } | null>(null);
    const speedRef = useRef(1);
    // Bumped by every play and stop: async work from an older session
    // compares it before touching the element or state.
    const generationRef = useRef(0);
    const activeRef = useRef(false);
    const errorRef = useRef<string | null>(null);
    const latest = useRef({ sentences, key, speech, title: readAloudTitle(text) });
    useEffect(() => {
        latest.current = { sentences, key, speech, title: readAloudTitle(text) };
    }, [sentences, key, speech, text]);

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

    const halt = useCallback(() => {
        generationRef.current += 1;
        activeRef.current = false;
        const audio = audioRef.current;
        if (audio) {
            audio.onplay = audio.onpause = audio.ontimeupdate = null;
            audio.ondurationchange = audio.onended = audio.onerror = null;
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
    }, [releaseUrl]);

    const fail = useCallback(
        (cause: unknown) => {
            halt();
            const message = readAloudErrorMessage(cause);
            errorRef.current = message;
            setError(message);
        },
        [halt],
    );

    // New prose or another engine: drop the file and silence this message.
    // A streaming answer changes its prose on every chunk, so only reset
    // when there is something to reset.
    useEffect(() => {
        renderedRef.current = null;
        if (activeRef.current || errorRef.current !== null) {
            // Stopping pauses audio and revokes its URL, which are effects.
            // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const controls = useRef<{ pause: () => void; resume: () => void; seek: (to: number) => void; stop: () => void }>({
        pause: () => {},
        resume: () => {},
        seek: () => {},
        stop: () => {},
    });

    const start = useCallback(
        (blob: Blob, generation: number) => {
            const audio = ensureAudio();
            releaseUrl();
            const url = URL.createObjectURL(blob);
            urlRef.current = url;
            const current = () => generation === generationRef.current;
            audio.onplay = () => current() && setStatus("playing");
            audio.onpause = () => current() && !audio.ended && setStatus("paused");
            audio.ontimeupdate = () => current() && setPosition(audio.currentTime);
            audio.ondurationchange = () => {
                if (current() && Number.isFinite(audio.duration)) setLength(audio.duration);
            };
            audio.onended = () => current() && halt();
            audio.onerror = () => current() && fail(PLAYBACK_FAILED_MESSAGE);
            audio.src = url;
            audio.playbackRate = speedRef.current;
            setStatus("playing");
            const { pause, resume, seek, stop } = controls.current;
            setMediaSession(latest.current.title, {
                play: resume,
                pause,
                stop,
                seekto: (details) => seek(details.seekTime ?? 0),
                seekbackward: () => seek(audio.currentTime - SKIP_SECONDS),
                seekforward: () => seek(audio.currentTime + SKIP_SECONDS),
            });
            Promise.resolve(audio.play()).catch((cause: unknown) => {
                if (current()) fail(cause);
            });
        },
        [ensureAudio, fail, halt, releaseUrl],
    );

    const play = useCallback(() => {
        const { sentences, key, speech } = latest.current;
        if (sentences.length === 0) return;
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        activeRef.current = true;
        errorRef.current = null;
        setError(null);
        setPosition(0);
        const audio = ensureAudio();
        const rendered = renderedRef.current;
        if (rendered && rendered.key === key) {
            start(rendered.blob, generation);
            return;
        }
        // Inside the tap: a moment of silence, so iOS lets this element play
        // the real audio once synthesis is done.
        if (!silentUrlRef.current) silentUrlRef.current = URL.createObjectURL(silentWav());
        audio.src = silentUrlRef.current;
        Promise.resolve(audio.play()).catch(() => undefined);

        setStatus("preparing");
        setPrepared(0);
        setLength(0);
        const current = () => generation === generationRef.current;
        const plan = speechRenderPlan(speech);
        renderSpeech(chunkSentences(sentences, plan.maxChars), (chunk) => synthesizeSentence(chunk, speech), {
            concurrency: plan.concurrency,
            onProgress: (done, total) => current() && setPrepared(done / total),
            cancelled: () => !current(),
        })
            .then((blob) => {
                if (!current()) return;
                renderedRef.current = { key, blob };
                start(blob, generation);
            })
            .catch((cause: unknown) => {
                if (!current() || cause instanceof SpeechRenderCancelled) return;
                fail(cause);
            });
    }, [ensureAudio, fail, start]);

    const pause = useCallback(() => {
        const audio = audioRef.current;
        if (!activeRef.current || !audio || !urlRef.current) return;
        audio.pause();
        setStatus("paused");
    }, []);

    const resume = useCallback(() => {
        const audio = audioRef.current;
        if (!activeRef.current || !audio || !urlRef.current) return;
        const generation = generationRef.current;
        setStatus("playing");
        Promise.resolve(audio.play()).catch((cause: unknown) => {
            if (generation === generationRef.current) fail(cause);
        });
    }, [fail]);

    const seek = useCallback((to: number) => {
        const audio = audioRef.current;
        if (!activeRef.current || !audio || !urlRef.current) return;
        const end = Number.isFinite(audio.duration) ? audio.duration : to;
        const next = Math.min(Math.max(to, 0), end);
        audio.currentTime = next;
        setPosition(next);
    }, []);

    const stop = useCallback(() => halt(), [halt]);

    const setSpeed = useCallback((next: number) => {
        speedRef.current = next;
        setSpeedState(next);
        if (audioRef.current) audioRef.current.playbackRate = next;
    }, []);

    useEffect(() => {
        controls.current = { pause, resume, seek, stop };
    }, [pause, resume, seek, stop]);

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
