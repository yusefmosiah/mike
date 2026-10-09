"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    BrowserRecognitionError,
    startOnDeviceRecognition,
    type OnDeviceRecognitionSession,
} from "@/app/lib/voice/browserSpeech";
import { transcribeRecording } from "@/app/lib/voice/engines";
import { loadVoicePreferences } from "@/app/lib/voice/preferences";

/**
 * MediaRecorder container preference, best first. A browser supporting none
 * of these records with its own default (older Safari: mp4/aac).
 */
const PREFERRED_MIME_TYPES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
] as const;

export const MICROPHONE_ACCESS_DENIED_MESSAGE = "Microphone access denied";
export const DICTATION_UNSUPPORTED_MESSAGE =
    "Recording a prompt is not supported in this browser.";
const MICROPHONE_START_FAILURE_MESSAGE =
    "Could not start recording. Please try again.";
const TRANSCRIBE_FAILURE_MESSAGE =
    "Could not transcribe the recording. Please try again.";

export interface UseDictationOptions {
    /** Blocks starting a recording (e.g. while a response is loading). */
    disabled?: boolean;
}

export interface UseDictationResult {
    /** True from the moment the recorder starts until its stop is handled. */
    recording: boolean;
    /** Recording time, refreshed every second; 0 outside a recording. */
    elapsedMs: number;
    /** User-facing failure text, or null. */
    error: string | null;
    /** True while a finished recording is being transcribed. */
    busy: boolean;
    /**
     * The latest transcript, trimmed; null before the first recording.
     * Paired with `transcriptVersion` so callers integrate it exactly once.
     */
    transcript: string | null;
    /** Bumped whenever a new transcript is produced. */
    transcriptVersion: number;
    start: () => Promise<void>;
    stop: () => void;
    toggle: () => void;
    clearError: () => void;
}

/**
 * Records a microphone clip and transcribes it with the engine chosen in
 * Settings → Voice (the operator by default; see lib/voice). With the
 * browser's own engine, the browser listens on device instead of a
 * recording being made. The hook owns the capture lifecycle only: it never
 * inserts text into a composer and never submits anything — callers decide
 * what to do with `transcript`/`transcriptVersion`.
 */
export function useDictation({
    disabled = false,
}: UseDictationOptions = {}): UseDictationResult {
    const [recording, setRecording] = useState(false);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [transcript, setTranscript] = useState<string | null>(null);
    const [transcriptVersion, setTranscriptVersion] = useState(0);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const browserSessionRef = useRef<OnDeviceRecognitionSession | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef(0);
    const timerRef = useRef<number | null>(null);
    // Invalidated on unmount so a getUserMedia answer that arrives too late
    // releases the microphone instead of starting an orphaned recording.
    const activeRef = useRef(true);
    const startingRef = useRef(false);
    const recordingRef = useRef(false);
    const busyRef = useRef(false);
    const disabledRef = useRef(disabled);
    disabledRef.current = disabled;

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const releaseStream = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    }, []);

    const finishRecording = useCallback(
        async (mimeType: string | undefined) => {
            clearTimer();
            releaseStream();
            recorderRef.current = null;
            recordingRef.current = false;
            setRecording(false);
            const recorded = new Blob(
                chunksRef.current,
                mimeType ? { type: mimeType } : {},
            );
            chunksRef.current = [];
            // A stop with no captured audio (an immediate tap) has nothing
            // to transcribe and is not an error.
            if (recorded.size === 0) return;
            busyRef.current = true;
            setBusy(true);
            try {
                const text = await transcribeRecording(recorded);
                const trimmed = text.trim();
                if (trimmed) {
                    setTranscript(trimmed);
                    setTranscriptVersion((version) => version + 1);
                }
            } catch (transcribeError) {
                setError(
                    userFacingApiError(
                        transcribeError,
                        TRANSCRIBE_FAILURE_MESSAGE,
                    ),
                );
            } finally {
                busyRef.current = false;
                setBusy(false);
            }
        },
        [clearTimer, releaseStream],
    );

    const start = useCallback(async () => {
        if (
            disabledRef.current ||
            busyRef.current ||
            recordingRef.current ||
            startingRef.current
        ) {
            return;
        }
        startingRef.current = true;
        try {
            setError(null);
            if (loadVoicePreferences().transcription.engine === "browser") {
                try {
                    browserSessionRef.current = startOnDeviceRecognition(
                        loadVoicePreferences().transcription.language,
                    );
                } catch (browserError) {
                    setError(
                        browserError instanceof BrowserRecognitionError
                            ? browserError.message
                            : MICROPHONE_START_FAILURE_MESSAGE,
                    );
                    return;
                }
                startedAtRef.current = Date.now();
                setElapsedMs(0);
                recordingRef.current = true;
                setRecording(true);
                timerRef.current = window.setInterval(() => {
                    setElapsedMs(Date.now() - startedAtRef.current);
                }, 1000);
                return;
            }
            if (
                typeof MediaRecorder === "undefined" ||
                !navigator.mediaDevices?.getUserMedia
            ) {
                setError(DICTATION_UNSUPPORTED_MESSAGE);
                return;
            }
            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                });
            } catch (mediaError) {
                const denied =
                    typeof mediaError === "object" &&
                    mediaError !== null &&
                    "name" in mediaError &&
                    (mediaError.name === "NotAllowedError" ||
                        mediaError.name === "PermissionDeniedError");
                setError(
                    denied
                        ? MICROPHONE_ACCESS_DENIED_MESSAGE
                        : MICROPHONE_START_FAILURE_MESSAGE,
                );
                return;
            }
            if (!activeRef.current) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            const mimeType = PREFERRED_MIME_TYPES.find((type) =>
                MediaRecorder.isTypeSupported(type),
            );
            try {
                const recorder = new MediaRecorder(
                    stream,
                    mimeType ? { mimeType } : undefined,
                );
                recorderRef.current = recorder;
                streamRef.current = stream;
                chunksRef.current = [];
                recorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        chunksRef.current.push(event.data);
                    }
                };
                recorder.onstop = () => {
                    void finishRecording(recorder.mimeType || mimeType);
                };
                startedAtRef.current = Date.now();
                setElapsedMs(0);
                recordingRef.current = true;
                setRecording(true);
                timerRef.current = window.setInterval(() => {
                    setElapsedMs(Date.now() - startedAtRef.current);
                }, 1000);
                recorder.start();
            } catch {
                // Construction or start can refuse — e.g. the stream ended
                // between permission and setup. Leave no live microphone and
                // no running timer behind.
                clearTimer();
                const started = recorderRef.current;
                recorderRef.current = null;
                recordingRef.current = false;
                if (started) {
                    started.onstop = null;
                    started.ondataavailable = null;
                    if (started.state !== "inactive") started.stop();
                }
                releaseStream();
                setRecording(false);
                setError(MICROPHONE_START_FAILURE_MESSAGE);
            }
        } finally {
            startingRef.current = false;
        }
    }, [clearTimer, finishRecording, releaseStream]);

    const stop = useCallback(() => {
        const session = browserSessionRef.current;
        if (session) {
            browserSessionRef.current = null;
            clearTimer();
            recordingRef.current = false;
            setRecording(false);
            busyRef.current = true;
            setBusy(true);
            session
                .stop()
                .then((text) => {
                    const trimmed = text.trim();
                    if (trimmed && activeRef.current) {
                        setTranscript(trimmed);
                        setTranscriptVersion((version) => version + 1);
                    }
                })
                .catch((browserError: unknown) => {
                    setError(
                        browserError instanceof Error && browserError.message
                            ? browserError.message
                            : TRANSCRIBE_FAILURE_MESSAGE,
                    );
                })
                .finally(() => {
                    busyRef.current = false;
                    setBusy(false);
                });
            return;
        }
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") return;
        recorder.stop();
    }, [clearTimer]);

    const toggle = useCallback(() => {
        if (recordingRef.current) {
            stop();
        } else {
            void start();
        }
    }, [start, stop]);

    const clearError = useCallback(() => setError(null), []);

    useEffect(() => {
        activeRef.current = true;
        return () => {
            activeRef.current = false;
            clearTimer();
            browserSessionRef.current?.cancel();
            browserSessionRef.current = null;
            const recorder = recorderRef.current;
            recorderRef.current = null;
            if (recorder && recorder.state !== "inactive") {
                // Detach first so the teardown stop does not start a
                // transcription of audio the user can no longer see.
                recorder.onstop = null;
                recorder.ondataavailable = null;
                recorder.stop();
            }
            releaseStream();
        };
    }, [clearTimer, releaseStream]);

    return {
        recording,
        elapsedMs,
        error,
        busy,
        transcript,
        transcriptVersion,
        start,
        stop,
        toggle,
        clearError,
    };
}
