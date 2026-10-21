"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message } from "@/app/components/shared/types";
import { recordSpokenAnswer } from "@/app/lib/mikeApi";
import { isPhononVoice } from "@/app/lib/voice/browserModels.spec";
import { ClauseCutter, type Clause } from "@/app/lib/voice/clauses";
import { currentDictationVocabulary, loadUserVocabulary } from "@/app/lib/voice/dictationVocabulary";
import { loadVoicePreferences } from "@/app/lib/voice/preferences";
import { SpeakableStream } from "@/app/lib/voice/speakable";
import { spokenAnswer } from "@/app/lib/voice/spokenAnswer";
import { spokenPrefix } from "@/app/lib/voice/spokenPrefix";
import { correctWithVocabulary } from "@/app/lib/voice/vocabulary";
import { setVoiceModeActive } from "@/app/lib/voice/voiceMode";
import {
    VOICE_INSTALL_FAILURE_MESSAGE,
    VOICE_START_FAILURE_MESSAGE,
    VOICE_UNAVAILABLE_MESSAGE,
    VoiceEngineError,
    endedMessage,
    onVoiceEvent,
    voiceCancelAnswer,
    voiceChatSupported,
    voiceEndAnswer,
    voiceInstall,
    voiceSpeak,
    voiceStart,
    voiceStatus,
    voiceStop,
    type VoiceConfig,
    type VoiceEngineState,
    type VoiceEvent,
} from "@/app/lib/voice/voiceEngine";

/**
 * Hands-free voice chat in a thread (docs/voice-chat.md, "The conversation
 * layer"). The iPhone app's engine listens and decides when a turn ends; this
 * hook sends each turn as an ordinary chat message (with `voice: true`), makes
 * the streaming answer speakable, cuts it into clauses for the engine to
 * speak, stops the answer when the person speaks over it, and records what
 * they heard of it.
 */

/**
 * `off`: not in voice mode. `checking`: asking the engine what it has.
 * `setup`: models to download first. `installing`: downloading them.
 * `starting`: loading the models and opening the microphone. `on`: talking.
 */
export type VoicePhase = "off" | "checking" | "setup" | "installing" | "starting" | "on";

/** What the screen says the conversation is doing. */
export type VoiceActivity = "listening" | "thinking" | "speaking";

export function activityOf(state: VoiceEngineState): VoiceActivity {
    if (state === "thinking" || state === "speaking") return state;
    return "listening";
}

/** Without a sign of the answer this long after sending, the send failed. */
export const SEND_TIMEOUT_MS = 4000;

/**
 * How long the next turn waits for what was heard of the last answer to be
 * recorded, so the model sees the interruption before the new question.
 */
export const RECORD_WAIT_MS = 1500;

/** How long ending voice mode mid-answer waits for the engine to say where speech stopped. */
export const INTERRUPT_WAIT_MS = 500;

export const VOICE_SEND_FAILURE_MESSAGE = "Could not send what you said. Voice mode has ended.";

export interface UseVoiceChatOptions {
    /**
     * The thread; voice mode ends when it changes. None on the new-chat
     * screen: the first turn creates the chat, and voice mode carries on in it.
     */
    chatId: string | null | undefined;
    messages: Message[];
    /** True while an answer streams into the thread. */
    isResponseLoading: boolean;
    /**
     * Sends the person's words as a chat message with `voice: true`. Returns
     * false when it could not be sent (no model chosen, a missing key: the
     * caller says why).
     */
    send: (text: string) => boolean;
    /** Stops the answer streaming into the thread. */
    cancelResponse: () => void;
    /** Thresholds for the engine; anything left out keeps the engine's default. */
    config?: Partial<VoiceConfig>;
}

export interface UseVoiceChatResult {
    /** The app has the voice engine (an iPhone app build with it). */
    supported: boolean;
    phase: VoicePhase;
    activity: VoiceActivity;
    /** The person's words while they speak; cleared when the turn is sent. */
    partial: string;
    /** A turn was heard in another voice and not sent; cleared when the person speaks. */
    ignoredOtherVoice: boolean;
    /** Download progress, 0 to 1, while installing. */
    installProgress: number | null;
    /** Size of the models still to download. */
    downloadBytes: number;
    error: string | null;
    /** "Voice mode on" or "Voice mode ended", for a polite live region; never the live words. */
    announcement: string;
    start: () => Promise<void>;
    install: () => Promise<void>;
    stop: () => void;
    clearError: () => void;
}

/** One turn: the person's words and the answer spoken to them. */
interface VoiceTurn {
    turnId: string;
    text: string;
    /** The thread's length when the words were sent; the answer comes after. */
    baseIndex: number;
    sent: boolean;
    answerId?: string;
    sawLoading: boolean;
    /** The answer text already made speakable. */
    fed: number;
    /** The answer's text pieces already spoken in full (spokenAnswer.ts). */
    settled: number;
    speakable: SpeakableStream;
    cutter: ClauseCutter;
    clauses: Clause[];
    started: Set<number>;
    played: Set<number>;
    /** The engine played the whole answer. */
    finished: boolean;
    /** No more clauses go to the engine: the answer ended, failed or was cut off. */
    ended: boolean;
    /** The answer was cut off (spoken over, or failed). */
    cancelled: boolean;
    /** What was heard, waiting for the answer's id; null once recorded (or not to be). */
    heard: string | null | undefined;
    /** Settles once what was heard has been recorded (or there is nothing to record). */
    recorded: Promise<void>;
    markRecorded: () => void;
    /** Before sending: the last answer's record to wait for. */
    waitFor: Promise<void> | null;
    waiting: boolean;
}

function newTurn(turnId: string, text: string): VoiceTurn {
    let markRecorded: () => void = () => undefined;
    const recorded = new Promise<void>((resolve) => (markRecorded = resolve));
    return {
        turnId,
        text,
        baseIndex: 0,
        sent: false,
        sawLoading: false,
        fed: 0,
        settled: 0,
        speakable: new SpeakableStream(),
        cutter: new ClauseCutter(),
        clauses: [],
        started: new Set(),
        played: new Set(),
        finished: false,
        ended: false,
        cancelled: false,
        heard: undefined,
        recorded,
        markRecorded,
        waitFor: null,
        waiting: false,
    };
}

/** The answer to a turn: the message with its id, or the first answer after its words. */
function answerOf(turn: VoiceTurn, messages: readonly Message[]): Message | null {
    if (turn.answerId) {
        const known = messages.find((message) => message.role === "assistant" && message.id === turn.answerId);
        if (known) return known;
    }
    for (let i = turn.baseIndex; i < messages.length; i++) {
        if (messages[i].role === "assistant") return messages[i];
    }
    return null;
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const joinWords = (...parts: string[]) => parts.filter(Boolean).join(" ");
const subscribeNever = () => () => undefined;

export function useVoiceChat({
    chatId,
    messages,
    isResponseLoading,
    send,
    cancelResponse,
    config,
}: UseVoiceChatOptions): UseVoiceChatResult {
    const supported = useSyncExternalStore(subscribeNever, voiceChatSupported, () => false);
    const [phase, setPhaseState] = useState<VoicePhase>("off");
    const [engineState, setEngineState] = useState<VoiceEngineState>("listening");
    const [partial, setPartial] = useState("");
    const [ignoredOtherVoice, setIgnoredOtherVoice] = useState(false);
    const [installProgress, setInstallProgress] = useState<number | null>(null);
    const [downloadBytes, setDownloadBytes] = useState(0);
    const [error, setError] = useState<string | null>(null);
    // Bumped when a turn is waiting to be sent, so the effect below runs.
    const [queued, setQueued] = useState(0);

    const [announcement, setAnnouncement] = useState("");
    const phaseRef = useRef<VoicePhase>("off");
    const setPhase = useCallback((next: VoicePhase) => {
        if (next === "on" && phaseRef.current !== "on") setAnnouncement("Voice mode on");
        if (next === "off" && phaseRef.current === "on") setAnnouncement("Voice mode ended");
        phaseRef.current = next;
        setPhaseState(next);
    }, []);
    // A session: bumped on every start and stop, so a late answer from an
    // earlier one is ignored.
    const sessionRef = useRef(0);
    // The session whose engine has started; its events are the only ones heard.
    const liveRef = useRef(0);
    const unsubscribeRef = useRef<(() => void) | null>(null);
    const turnRef = useRef<VoiceTurn | null>(null);
    // The turn before, whose `interrupted` may still arrive.
    const previousRef = useRef<VoiceTurn | null>(null);
    const pendingRef = useRef<VoiceTurn | null>(null);
    // Words of a turn spoken over before they were sent: they open the next turn.
    const carryRef = useRef("");
    const sendTimerRef = useRef<number | null>(null);
    // A turn was sent with no chat yet (the new-chat screen): the chat it
    // creates is this conversation's, not a different thread.
    const awaitingChatRef = useRef(false);

    const latest = useRef({ chatId, messages, isResponseLoading, send, cancelResponse, config });
    useEffect(() => {
        latest.current = { chatId, messages, isResponseLoading, send, cancelResponse, config };
    });

    const clearSendTimer = () => {
        if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
    };

    /** Records what was heard of an answer, once its id is known. */
    const flushHeard = useCallback((turn: VoiceTurn) => {
        if (typeof turn.heard !== "string") return;
        const { chatId: thread, messages: current } = latest.current;
        const answer = answerOf(turn, current);
        if (answer?.id) turn.answerId = answer.id;
        if (!turn.answerId || !thread) return;
        const heard = turn.heard;
        turn.heard = null;
        void recordSpokenAnswer(thread, turn.answerId, heard)
            .catch(() => undefined)
            .finally(turn.markRecorded);
    }, []);

    const settleHeard = useCallback(
        (turn: VoiceTurn, interrupted?: { clauseId: number; fraction: number }) => {
            if (turn.heard !== undefined) return;
            // Words never sent have no answer to record against.
            if (!turn.sent) {
                turn.heard = null;
                turn.markRecorded();
                return;
            }
            turn.heard = spokenPrefix({
                clauses: turn.clauses,
                played: turn.played,
                interrupted,
                spoken: turn.speakable.text,
                pieces: turn.speakable.pieces,
                source: turn.speakable.source,
            }).original;
            flushHeard(turn);
        },
        [flushHeard],
    );

    /** Cuts the turn's answer off: no more clauses, and the chat turn stops if it still streams. */
    const cutOff = useCallback((turn: VoiceTurn) => {
        if (pendingRef.current === turn) {
            // Never sent: the words are not lost, they open the next turn.
            pendingRef.current = null;
            carryRef.current = joinWords(carryRef.current, turn.text);
        }
        const streaming = turn.sent && !turn.ended;
        turn.ended = true;
        turn.cancelled = true;
        if (streaming) latest.current.cancelResponse();
    }, []);

    const teardown = useCallback(() => {
        sessionRef.current++;
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        clearSendTimer();
        turnRef.current = null;
        previousRef.current = null;
        pendingRef.current = null;
        carryRef.current = "";
        awaitingChatRef.current = false;
        setPartial("");
        setIgnoredOtherVoice(false);
        setInstallProgress(null);
        setEngineState("listening");
        setPhase("off");
    }, [setPhase]);

    const stop = useCallback(() => {
        const active = phaseRef.current !== "off";
        const turn = turnRef.current;
        teardown();
        if (!active) return;
        const speaking = turn && turn.sent && turn.heard === undefined && !turn.finished && turn.started.size > 0;
        if (!speaking) {
            void voiceStop();
            return;
        }
        // Ending mid-answer: the answer keeps arriving as text, but what was
        // heard is recorded, from where the engine says speech stopped.
        turn.ended = true;
        let off: () => void = () => undefined;
        const heard = new Promise<void>((resolve) => {
            off = onVoiceEvent((event) => {
                if (event.type !== "interrupted" || event.turnId !== turn.turnId) return;
                settleHeard(turn, { clauseId: event.clauseId, fraction: event.fraction });
                resolve();
            });
            void voiceCancelAnswer(turn.turnId)
                .then(() => delay(INTERRUPT_WAIT_MS))
                .then(() => resolve());
        });
        void heard.then(() => {
            off();
            // No `interrupted` came: the clauses that finished playing are what was heard.
            settleHeard(turn);
            void voiceStop();
        });
    }, [settleHeard, teardown]);

    const fail = useCallback(
        (message: string) => {
            stop();
            setError(message);
        },
        [stop],
    );

    const handleEvent = useCallback(
        (event: VoiceEvent) => {
            // Until this session's engine has started, anything heard is left
            // over from an earlier one (its `ended`, above all).
            if (liveRef.current !== sessionRef.current) return;
            const turn = turnRef.current;
            const previous = previousRef.current;
            const current =
                "turnId" in event
                    ? [turn, previous].find((candidate) => candidate?.turnId === event.turnId) ?? null
                    : null;
            switch (event.type) {
                case "state":
                    setEngineState(event.state);
                    return;
                case "partial":
                    setPartial(event.text);
                    if (event.text) setIgnoredOtherVoice(false);
                    return;
                case "ignored":
                    setPartial("");
                    setIgnoredOtherVoice(true);
                    return;
                case "turn": {
                    setPartial("");
                    setIgnoredOtherVoice(false);
                    const vocabulary = currentDictationVocabulary();
                    if (turn && !turn.ended) {
                        // The person went on before the last answer ended.
                        cutOff(turn);
                        void voiceCancelAnswer(turn.turnId);
                        settleHeard(turn);
                    }
                    const words = joinWords(carryRef.current, correctWithVocabulary(event.text.trim(), vocabulary).trim());
                    carryRef.current = "";
                    previousRef.current = turn;
                    if (!words) {
                        turnRef.current = null;
                        void voiceCancelAnswer(event.turnId);
                        return;
                    }
                    const next = newTurn(event.turnId, words);
                    // The model should see the interruption before the new words.
                    if (turn?.sent && turn.cancelled) next.waitFor = turn.recorded;
                    turnRef.current = next;
                    pendingRef.current = next;
                    setQueued((count) => count + 1);
                    return;
                }
                case "bargeIn": {
                    if (!current) return;
                    cutOff(current);
                    // A clause still playing reports where it stopped (`interrupted`).
                    const playing = [...current.started].some((id) => !current.played.has(id));
                    if (!playing) settleHeard(current);
                    return;
                }
                case "interrupted":
                    if (!current) return;
                    cutOff(current);
                    settleHeard(current, { clauseId: event.clauseId, fraction: event.fraction });
                    return;
                case "clauseStarted":
                    current?.started.add(event.clauseId);
                    return;
                case "clausePlayed":
                    current?.started.add(event.clauseId);
                    current?.played.add(event.clauseId);
                    return;
                case "answerFinished":
                    if (current) current.finished = true;
                    return;
                case "ended": {
                    const message = endedMessage(event.reason);
                    teardown();
                    if (message) setError(message);
                    return;
                }
                default:
                    // `install` is heard by `install`; `metrics` needs nothing here.
                    return;
            }
        },
        [cutOff, settleHeard, teardown],
    );

    const begin = useCallback(
        async (session: number) => {
            setPhase("starting");
            // A list that cannot be loaded is the same as none.
            await loadUserVocabulary().catch(() => undefined);
            if (sessionRef.current !== session) return;
            unsubscribeRef.current = onVoiceEvent(handleEvent);
            const chosen = loadVoicePreferences().speech.voice;
            try {
                await voiceStart({
                    config: { ...latest.current.config },
                    ...(isPhononVoice(chosen) ? { voice: chosen } : {}),
                });
            } catch (startError) {
                if (sessionRef.current !== session) return;
                teardown();
                // `cancelled`: a stop reached the engine first. Expected, not a failure.
                if (startError instanceof VoiceEngineError && startError.code === "cancelled") return;
                setError(startError instanceof VoiceEngineError ? startError.message : VOICE_START_FAILURE_MESSAGE);
                return;
            }
            if (sessionRef.current !== session) {
                // Ended while the engine started: release it, unless a newer
                // start is already on its way (it takes the engine over).
                if (phaseRef.current === "off") void voiceStop();
                return;
            }
            liveRef.current = session;
            setEngineState("listening");
            setPhase("on");
        },
        [handleEvent, setPhase, teardown],
    );
    const start = useCallback(async () => {
        if (phaseRef.current !== "off") return;
        const session = ++sessionRef.current;
        setError(null);
        setPhase("checking");
        const status = await voiceStatus();
        if (sessionRef.current !== session) return;
        if (status.available) {
            await begin(session);
            return;
        }
        if (status.missing.length > 0) {
            setDownloadBytes(status.downloadBytes);
            setPhase("setup");
            return;
        }
        setPhase("off");
        setError(VOICE_UNAVAILABLE_MESSAGE);
    }, [begin, setPhase]);

    const install = useCallback(async () => {
        if (phaseRef.current !== "setup") return;
        const session = sessionRef.current;
        setError(null);
        setPhase("installing");
        setInstallProgress(0);
        unsubscribeRef.current = onVoiceEvent((event) => {
            if (event.type === "install" && sessionRef.current === session) setInstallProgress(event.fraction);
        });
        let available = false;
        let message = VOICE_INSTALL_FAILURE_MESSAGE;
        try {
            available = await voiceInstall();
        } catch (installError) {
            message = (installError as VoiceEngineError).message;
        }
        if (sessionRef.current !== session) return;
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        setInstallProgress(null);
        if (!available) {
            setPhase("setup");
            setError(message);
            return;
        }
        await begin(session);
    }, [begin, setPhase]);

    // Sends a turn waiting to go, once no answer is streaming (one the person
    // spoke over is still stopping).
    useEffect(() => {
        const pending = pendingRef.current;
        if (!pending || phaseRef.current !== "on" || isResponseLoading || pending.waiting) return;
        if (pending.waitFor) {
            const recorded = pending.waitFor;
            pending.waitFor = null;
            pending.waiting = true;
            void Promise.race([recorded, delay(RECORD_WAIT_MS)]).then(() => {
                pending.waiting = false;
                setQueued((count) => count + 1);
            });
            return;
        }
        pendingRef.current = null;
        pending.baseIndex = messages.length;
        if (!latest.current.send(pending.text)) {
            void voiceCancelAnswer(pending.turnId);
            // Reported after this effect, like the send itself (an event).
            queueMicrotask(() => fail(VOICE_SEND_FAILURE_MESSAGE));
            return;
        }
        pending.sent = true;
        if (!latest.current.chatId) awaitingChatRef.current = true;
        clearSendTimer();
        const session = sessionRef.current;
        sendTimerRef.current = window.setTimeout(() => {
            sendTimerRef.current = null;
            if (sessionRef.current !== session || turnRef.current !== pending) return;
            if (pending.sawLoading || answerOf(pending, latest.current.messages)) return;
            void voiceCancelAnswer(pending.turnId);
            fail(VOICE_SEND_FAILURE_MESSAGE);
        }, SEND_TIMEOUT_MS);
    }, [queued, isResponseLoading, messages, fail]);

    // Speaks the answer as it streams.
    useEffect(() => {
        const turn = turnRef.current;
        if (!turn?.sent) return;
        if (isResponseLoading) turn.sawLoading = true;
        const answer = answerOf(turn, messages);
        if (answer?.id) turn.answerId = answer.id;
        flushHeard(turn);
        if (turn.ended || !answer) return;
        if (answer.error) {
            turn.ended = true;
            turn.cancelled = true;
            void voiceCancelAnswer(turn.turnId);
            return;
        }
        const speak = (clauses: Clause[]) => {
            for (const clause of clauses) {
                turn.clauses.push(clause);
                voiceSpeak(turn.turnId, clause.id, clause.text, clause.final);
            }
        };
        const { text, settled } = spokenAnswer(answer);
        if (text.length > turn.fed) {
            speak(turn.cutter.push(turn.speakable.push(text.slice(turn.fed))));
            turn.fed = text.length;
        }
        const ending = turn.sawLoading && !isResponseLoading;
        // The text paused for a tool call or thinking: say all of it now, so
        // the person hears it while the work runs. (At the end, the last
        // clause goes out below, marked final.)
        if (settled > turn.settled) {
            turn.settled = settled;
            if (!ending) speak([...turn.cutter.push(turn.speakable.flush()), ...turn.cutter.flush()]);
        }
        if (ending) {
            turn.ended = true;
            speak([...turn.cutter.push(turn.speakable.finish()), ...turn.cutter.finish()]);
            voiceEndAnswer(turn.turnId);
        }
    }, [messages, isResponseLoading, flushHeard]);

    // While voice mode is on, read-aloud stays silent.
    const voiceOn = phase !== "off";
    useEffect(() => {
        if (!voiceOn) return;
        setVoiceModeActive(true);
        return () => setVoiceModeActive(false);
    }, [voiceOn]);

    // Leaving the thread ends voice mode and releases the microphone, except
    // for the chat that a turn spoken on the new-chat screen just created:
    // the conversation carries on in it.
    const thread = chatId || null;
    useEffect(() => {
        // In the chat now; a later change of thread is leaving it.
        if (thread) awaitingChatRef.current = false;
        return () => {
            if (!thread && awaitingChatRef.current) return;
            stop();
        };
    }, [thread, stop]);
    // Leaving the page does too.
    useEffect(() => () => stop(), [stop]);

    return {
        supported,
        phase,
        activity: activityOf(engineState),
        partial,
        ignoredOtherVoice,
        installProgress,
        downloadBytes,
        error,
        announcement,
        start,
        install,
        stop,
        clearError: useCallback(() => setError(null), []),
    };
}
