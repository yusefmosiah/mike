import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserSpeechSupported } from "@/app/lib/voice/browserSpeech";
import {
    splitIntoReadAloudSentences,
    type ReadAloudStatus,
    type UseReadAloud,
} from "./readAloudShared";

const PLAYBACK_FAILED_MESSAGE = "Playback failed.";
const UNSUPPORTED_MESSAGE = "This browser cannot read aloud.";
/**
 * WebKit drops an utterance queued straight after cancel(), so a restart
 * (seek, speed change) waits this long after cancelling.
 */
const RESTART_DELAY_MS = 120;

/**
 * Read-aloud with the operating system's voices (`speechSynthesis`). These
 * cannot be rendered to a file, so the reading is a queue of sentences:
 * position and seeking are by sentence. Every sentence is queued at once,
 * inside the tap, because iOS speaks only what a tap queued. Nothing leaves
 * the browser.
 */
export function useBrowserReadAloud(text: string, voiceURI?: string): UseReadAloud {
    const sentences = useMemo(() => splitIntoReadAloudSentences(text), [text]);
    const [status, setStatus] = useState<ReadAloudStatus>("idle");
    const [position, setPosition] = useState(0);
    const [speed, setSpeedState] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const generationRef = useRef(0);
    const speedRef = useRef(1);
    const positionRef = useRef(0);
    const activeRef = useRef(false);
    const latest = useRef({ sentences, voiceURI });
    useEffect(() => {
        latest.current = { sentences, voiceURI };
    }, [sentences, voiceURI]);

    const synth = () => (browserSpeechSupported() ? window.speechSynthesis : null);

    const silence = useCallback(() => {
        generationRef.current += 1;
        const speech = synth();
        if (speech && (speech.speaking || speech.pending)) speech.cancel();
    }, []);

    const finish = useCallback(() => {
        activeRef.current = false;
        positionRef.current = 0;
        setStatus("idle");
        setPosition(0);
    }, []);

    /** Queues sentence `from` onwards; call inside a tap the first time. */
    const enqueue = useCallback(
        (from: number, generation: number) => {
            const speech = synth();
            const { sentences, voiceURI } = latest.current;
            if (!speech) return;
            const voice = voiceURI ? speech.getVoices().find((v) => v.voiceURI === voiceURI) : undefined;
            for (let i = from; i < sentences.length; i++) {
                const utterance = new SpeechSynthesisUtterance(sentences[i]);
                if (voice) utterance.voice = voice;
                utterance.rate = speedRef.current;
                utterance.onstart = () => {
                    if (generation !== generationRef.current) return;
                    positionRef.current = i;
                    setPosition(i);
                };
                utterance.onend = () => {
                    if (generation === generationRef.current && i === sentences.length - 1) finish();
                };
                utterance.onerror = (event) => {
                    // Cancelling (stop, seek) is not a failure.
                    if (generation !== generationRef.current) return;
                    if (event.error === "canceled" || event.error === "interrupted") return;
                    generationRef.current += 1;
                    speech.cancel();
                    activeRef.current = false;
                    setStatus("idle");
                    setError(PLAYBACK_FAILED_MESSAGE);
                };
                speech.speak(utterance);
            }
        },
        [finish],
    );

    const startAt = useCallback(
        (index: number) => {
            const count = latest.current.sentences.length;
            if (count === 0) return;
            const speech = synth();
            if (!speech) {
                setError(UNSUPPORTED_MESSAGE);
                return;
            }
            const from = Math.min(Math.max(Math.round(index), 0), count - 1);
            const busy = speech.speaking || speech.pending;
            silence();
            const generation = generationRef.current;
            activeRef.current = true;
            positionRef.current = from;
            setError(null);
            setStatus("playing");
            setPosition(from);
            if (speech.paused) speech.resume();
            if (busy) {
                window.setTimeout(() => {
                    if (generation === generationRef.current) enqueue(from, generation);
                }, RESTART_DELAY_MS);
            } else {
                enqueue(from, generation);
            }
        },
        [enqueue, silence],
    );

    const stop = useCallback(() => {
        silence();
        finish();
    }, [finish, silence]);

    // New prose or unmount: silence whatever this message was saying.
    useEffect(
        () => () => {
            if (!activeRef.current) return;
            activeRef.current = false;
            silence();
        },
        [sentences, silence],
    );

    const play = useCallback(() => startAt(0), [startAt]);
    const pause = useCallback(() => {
        if (!activeRef.current) return;
        synth()?.pause();
        setStatus("paused");
    }, []);
    const resume = useCallback(() => {
        if (!activeRef.current) return;
        synth()?.resume();
        setStatus("playing");
    }, []);
    const seek = useCallback(
        (to: number) => {
            if (activeRef.current) startAt(to);
        },
        [startAt],
    );
    // Queued sentences keep their rate, so a change re-queues from here.
    const setSpeed = useCallback(
        (next: number) => {
            speedRef.current = next;
            setSpeedState(next);
            if (activeRef.current) startAt(positionRef.current);
        },
        [startAt],
    );

    return {
        available: sentences.length > 0,
        status,
        prepared: 0,
        position,
        length: sentences.length,
        unit: "sentences",
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
