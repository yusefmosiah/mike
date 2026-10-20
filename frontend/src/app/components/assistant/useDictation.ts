"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    BrowserRecognitionError,
    startOnDeviceRecognition,
    type OnDeviceRecognitionSession,
} from "@/app/lib/voice/browserSpeech";
import { BrowserModelError } from "@/app/lib/voice/browserModels";
import { DeviceSpeechError, LiveDictationError } from "@/app/lib/voice/deviceSpeech";
import {
    cancelLiveTranscription,
    correctDictation,
    prepareTranscription,
    startLiveTranscription,
    stopLiveTranscription,
    transcribeRecording,
    wantsLiveDictation,
    type LiveTranscript,
} from "@/app/lib/voice/engines";
import { loadUserVocabulary } from "@/app/lib/voice/dictationVocabulary";
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

/**
 * The iPhone's own engine reads AAC; the web view's WebM (Opus) is refused
 * there, so AAC comes first.
 */
const DEVICE_MIME_TYPES = ["audio/mp4"] as const;

export const MICROPHONE_ACCESS_DENIED_MESSAGE = "Microphone access denied";
export const DICTATION_UNSUPPORTED_MESSAGE =
    "Recording a prompt is not supported in this browser.";
const MICROPHONE_START_FAILURE_MESSAGE =
    "Could not start recording. Please try again.";
const TRANSCRIBE_FAILURE_MESSAGE =
    "Could not transcribe the recording. Please try again.";

/** The message for a failure of the iPhone's live dictation. */
function liveFailure(liveError: unknown): string {
    if (liveError instanceof LiveDictationError && liveError.code === "permission-denied") {
        return MICROPHONE_ACCESS_DENIED_MESSAGE;
    }
    return liveError instanceof DeviceSpeechError ? liveError.message : MICROPHONE_START_FAILURE_MESSAGE;
}

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
    /**
     * The text heard so far while a live dictation runs (the iPhone app with
     * Fluid Speech Mini), until its final text arrives; null otherwise.
     * `confirmed` will not change; `volatile` is the tail that may.
     */
    liveText: LiveTranscript | null;
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
    /** Stops and throws the recording away; nothing is transcribed. */
    cancel: () => void;
    toggle: () => void;
    clearError: () => void;
}

/**
 * Records a microphone clip and transcribes it with the engine chosen in
 * Settings → Voice (the operator by default, the phone itself in the iPhone
 * app; see lib/voice). With the
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
    const [liveText, setLiveText] = useState<LiveTranscript | null>(null);
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
    // True from the moment a live dictation is asked for until it ends.
    const liveRef = useRef(false);
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
                    transcribeError instanceof DeviceSpeechError ||
                        transcribeError instanceof BrowserModelError
                        ? transcribeError.message
                        : userFacingApiError(
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

    // Ends a live dictation: the final text goes to the composer. Also what
    // happens when the app ends it itself (a call, the app going to the
    // background), which keeps the text so far.
    const finishLive = useCallback(() => {
        if (!liveRef.current) return;
        liveRef.current = false;
        clearTimer();
        recordingRef.current = false;
        setRecording(false);
        busyRef.current = true;
        setBusy(true);
        stopLiveTranscription()
            .then((text) => {
                const trimmed = text.trim();
                if (trimmed && activeRef.current) {
                    setTranscript(trimmed);
                    setTranscriptVersion((version) => version + 1);
                }
            })
            .catch((stopError: unknown) => {
                setError(liveFailure(stopError));
            })
            .finally(() => {
                busyRef.current = false;
                setBusy(false);
                setLiveText(null);
            });
    }, [clearTimer]);

    const startLive = useCallback(async () => {
        liveRef.current = true;
        try {
            await startLiveTranscription({
                onText: (text, ended) => {
                    if (!liveRef.current || !activeRef.current) return;
                    setLiveText(text);
                    if (ended) finishLive();
                },
            });
        } catch (liveError) {
            liveRef.current = false;
            setError(liveFailure(liveError));
            return;
        }
        if (!activeRef.current || !liveRef.current) {
            // Unmounted (or cancelled) while the microphone was opening.
            liveRef.current = false;
            cancelLiveTranscription();
            return;
        }
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setLiveText({ confirmed: "", volatile: "" });
        recordingRef.current = true;
        setRecording(true);
        timerRef.current = window.setInterval(() => {
            setElapsedMs(Date.now() - startedAtRef.current);
        }, 1000);
    }, [finishLive]);

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
            // Fetch the person's vocabulary while they speak; a failure only
            // means dictation runs without it.
            void loadUserVocabulary().catch(() => undefined);
            // Load the on-device model while they speak, not after.
            void prepareTranscription().catch(() => undefined);
            // On the iPhone with Fluid Speech Mini the phone records and
            // transcribes as the person speaks; everything else records a
            // clip here and transcribes it at the end.
            const preferences = loadVoicePreferences().transcription;
            if (preferences.engine === "device" && (await wantsLiveDictation(preferences))) {
                await startLive();
                return;
            }
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
            const preferredTypes: readonly string[] =
                loadVoicePreferences().transcription.engine === "device"
                    ? DEVICE_MIME_TYPES
                    : PREFERRED_MIME_TYPES;
            const mimeType = preferredTypes.find((type) =>
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
    }, [clearTimer, finishRecording, releaseStream, startLive]);

    const stop = useCallback(() => {
        if (liveRef.current) {
            finishLive();
            return;
        }
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
                .then((text) => correctDictation(text))
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
    }, [clearTimer, finishLive]);

    const cancel = useCallback(() => {
        if (liveRef.current) {
            liveRef.current = false;
            cancelLiveTranscription();
            clearTimer();
            recordingRef.current = false;
            setRecording(false);
            setLiveText(null);
            return;
        }
        const session = browserSessionRef.current;
        if (session) {
            browserSessionRef.current = null;
            session.cancel();
        }
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder && recorder.state !== "inactive") {
            recorder.onstop = null;
            recorder.ondataavailable = null;
            recorder.stop();
        }
        chunksRef.current = [];
        releaseStream();
        clearTimer();
        recordingRef.current = false;
        setRecording(false);
    }, [clearTimer, releaseStream]);

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
            if (liveRef.current) {
                liveRef.current = false;
                cancelLiveTranscription();
            }
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
        liveText,
        transcript,
        transcriptVersion,
        start,
        stop,
        cancel,
        toggle,
        clearError,
    };
}
