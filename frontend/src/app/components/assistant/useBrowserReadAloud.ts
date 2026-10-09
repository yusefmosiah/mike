import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { speakWithBrowser } from "@/app/lib/voice/browserSpeech";
import {
    splitIntoReadAloudSentences,
    type UseReadAloud,
} from "./readAloudShared";

/**
 * Read-aloud with the operating system's voices (`speechSynthesis`), with
 * the same controls as the audio engine: sentence by sentence, pause,
 * resume, speed and start-from. Nothing leaves the browser.
 */
export function useBrowserReadAloud(text: string, voiceURI?: string): UseReadAloud {
    const sentences = useMemo(() => splitIntoReadAloudSentences(text), [text]);
    const [playing, setPlaying] = useState(false);
    const [paused, setPaused] = useState(false);
    const [sentenceIndex, setSentenceIndex] = useState(0);
    const [speed, setSpeedState] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const generationRef = useRef(0);
    const speedRef = useRef(1);
    const sentencesRef = useRef(sentences);

    useEffect(() => {
        sentencesRef.current = sentences;
    }, [sentences]);

    const cancelSpeech = () => {
        if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };

    const stop = useCallback(() => {
        generationRef.current += 1;
        cancelSpeech();
        setPlaying(false);
        setPaused(false);
        setSentenceIndex(0);
    }, []);

    // New prose or unmount: silence whatever this message was saying.
    useEffect(() => {
        return () => {
            generationRef.current += 1;
            cancelSpeech();
        };
    }, [sentences]);

    const playFrom = useCallback(
        (index: number) => {
            const count = sentencesRef.current.length;
            if (count === 0) return;
            const generation = generationRef.current + 1;
            generationRef.current = generation;
            cancelSpeech();
            setError(null);
            setPlaying(true);
            setPaused(false);
            void (async () => {
                for (let i = Math.min(Math.max(index, 0), count - 1); i < sentencesRef.current.length; i++) {
                    if (generation !== generationRef.current) return;
                    setSentenceIndex(i);
                    try {
                        await speakWithBrowser(sentencesRef.current[i], { voiceURI, rate: speedRef.current });
                    } catch (cause) {
                        if (generation !== generationRef.current) return;
                        generationRef.current += 1;
                        setPlaying(false);
                        setError(cause instanceof Error ? cause.message : "Playback failed.");
                        return;
                    }
                }
                if (generation === generationRef.current) {
                    setPlaying(false);
                    setSentenceIndex(0);
                }
            })();
        },
        [voiceURI],
    );

    const play = useCallback(() => playFrom(0), [playFrom]);
    const pause = useCallback(() => {
        window.speechSynthesis?.pause();
        setPaused(true);
    }, []);
    const resume = useCallback(() => {
        window.speechSynthesis?.resume();
        setPaused(false);
    }, []);
    // The new rate applies from the next sentence.
    const setSpeed = useCallback((next: number) => {
        speedRef.current = next;
        setSpeedState(next);
    }, []);

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
