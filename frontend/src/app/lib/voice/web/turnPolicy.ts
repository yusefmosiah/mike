/**
 * When a turn ends, for voice mode in the browser: a TypeScript port of the
 * part of the iPhone engine's `TurnPolicy` (mobile/plugins/speech/ios/Sources/
 * MikeSpeechPlugin/TurnPolicy.swift) that phase 1 of docs/voice-web.md needs.
 * A pure value driven by timestamped events: it owns no audio and no models;
 * the web engine feeds it what Silero saw and carries out what it decides,
 * and the tests replay traces through it (web/fixtures/turnPolicy/*.json,
 * several taken from the Swift tests).
 *
 * Time is milliseconds of microphone audio since voice mode started, from the
 * 16 kHz sample count, so a trace replays the same however fast it is fed.
 *
 * Left out for now, as the Swift policy does when they are absent: Smart Turn
 * (`smartTurnAvailable` is false, so the turn ends on silence alone after
 * `fallbackSilenceMs`), the live words (no EOU stream, so a barge-in counts
 * speech only: `bargeInWords` is 0), the speaker check and the held playback
 * of a false start (the browser engine is half-duplex: while the answer plays
 * the microphone is not listened to).
 */

export type PolicyState = "listening" | "user-speaking" | "confirming-end" | "thinking" | "speaking";

export interface TurnPolicyConfig {
    /** Speech probability at which a run starts; it ends below this minus 0.15. */
    vadThreshold: number;
    /** The turn ends whatever else happens after this much silence. */
    maxSilenceMs: number;
    /** Without Smart Turn, the silence that ends the turn (never more than `maxSilenceMs`). */
    fallbackSilenceMs: number;
    /** Speech resumed this soon after a turn was sent continues it; 0 is off. */
    continueMs: number;
    /** Speech needed, while the answer is awaited, to barge in. */
    bargeInSpeechMs: number;
    /** Speech probability needed to start a run while the answer is awaited or playing. */
    bargeInVadThreshold: number;
    /** A single turn is cut here (at most 120000). */
    maxTurnMs: number;
}

export const TURN_POLICY_DEFAULTS: TurnPolicyConfig = {
    vadThreshold: 0.5,
    maxSilenceMs: 3000,
    // The iPhone's fallback is 1500 ms, there only while Smart Turn loads. In
    // the browser it is the rule for the whole of phase 1: shorter, to be
    // tuned against real turns (docs/voice-web.md).
    fallbackSilenceMs: 900,
    continueMs: 3000,
    // With no words to go on, speech alone has to be long enough not to be a
    // cough: the iPhone's hold threshold (700 ms) rather than its 300 ms.
    bargeInSpeechMs: 700,
    bargeInVadThreshold: 0.7,
    maxTurnMs: 60_000,
};

/** The longest turn accepted (the audio kept for the transcription scales with it). */
export const MAX_TURN_LIMIT_MS = 120_000;

export type PolicyInput =
    /** One Silero frame covering `startMs..<endMs`. */
    | { type: "vad"; probability: number; startMs: number; endMs: number }
    /** The clock moved. */
    | { type: "tick"; nowMs: number }
    /** The transcription produced words and `turn` was sent: the answer is awaited. */
    | { type: "turnCommitted"; turnId: string }
    /** The transcription found nothing to send: back to listening. */
    | { type: "turnDiscarded" }
    /** A clause of `turnId`'s answer started playing. */
    | { type: "clausePlaying"; turnId: string }
    /** `turnId`'s answer finished playing, or was cancelled. */
    | { type: "answerEnded"; turnId: string };

export type CommitReason = "maxSilence" | "maxTurn";

export interface PolicyCommit {
    /** The utterance as VAD bounds it (the engine pads it for the transcription). */
    startMs: number;
    endMs: number;
    /** When the decision was made. */
    decidedAtMs: number;
    reason: CommitReason;
    /** The sent turn this one continues: `startMs` is that turn's start, and `turn` replaces it. */
    continues?: string;
}

export type PolicyDecision =
    | { type: "state"; state: PolicyState }
    /** The turn is over: transcribe `startMs..endMs` and send `turn`. */
    | { type: "commit"; commit: PolicyCommit }
    /** The person spoke over `turnId`'s answer: stop it and keep listening. */
    | { type: "bargeIn"; turnId: string };

type Phase =
    | { kind: "listening" }
    | { kind: "userTurn" }
    | { kind: "finalizing" }
    | { kind: "thinking"; turnId: string }
    | { kind: "speaking"; turnId: string };

/** A config with every field present and in range; anything else takes the default. */
export function turnPolicyConfig(partial: Partial<TurnPolicyConfig> = {}): TurnPolicyConfig {
    const pick = (key: keyof TurnPolicyConfig, min: number, max: number): number => {
        const value = partial[key];
        return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
            ? value
            : TURN_POLICY_DEFAULTS[key];
    };
    return {
        vadThreshold: pick("vadThreshold", 0.05, 0.99),
        maxSilenceMs: pick("maxSilenceMs", 100, 30_000),
        fallbackSilenceMs: pick("fallbackSilenceMs", 100, 30_000),
        continueMs: pick("continueMs", 0, 30_000),
        bargeInSpeechMs: pick("bargeInSpeechMs", 0, 10_000),
        bargeInVadThreshold: pick("bargeInVadThreshold", 0.05, 0.99),
        maxTurnMs: pick("maxTurnMs", 1000, MAX_TURN_LIMIT_MS),
    };
}

export class TurnPolicy {
    readonly config: TurnPolicyConfig;
    private _state: PolicyState = "listening";
    private phase: Phase = { kind: "listening" };
    private nowMs = 0;

    // VAD with hysteresis: speech at the threshold, silence only below
    // threshold − 0.15 (Silero's own offset).
    private _inSpeech = false;
    private runOnsetMs: number | null = null;
    private lastSpeechEndMs = 0;
    private silenceStartMs: number | null = null;

    private utteranceStartMs: number | null = null;
    private continuing: { turnId: string; startMs: number } | null = null;
    private committedBounds: { startMs: number; endMs: number } | null = null;
    private answeredTurn: { turnId: string; startMs: number; endMs: number } | null = null;

    constructor(config: Partial<TurnPolicyConfig> = {}) {
        this.config = turnPolicyConfig(config);
    }

    get state(): PolicyState {
        return this._state;
    }

    get inSpeech(): boolean {
        return this._inSpeech;
    }

    /** The turn whose answer is pending or playing, if any. */
    get answerTurnId(): string | null {
        return this.phase.kind === "thinking" || this.phase.kind === "speaking" ? this.phase.turnId : null;
    }

    private get silenceLimitMs(): number {
        return Math.min(this.config.maxSilenceMs, this.config.fallbackSilenceMs);
    }

    private get silenceThreshold(): number {
        return Math.max(0.01, this.config.vadThreshold - 0.15);
    }

    private get onsetThreshold(): number {
        return this.answerTurnId === null
            ? this.config.vadThreshold
            : Math.max(this.config.vadThreshold, this.config.bargeInVadThreshold);
    }

    handle(input: PolicyInput): PolicyDecision[] {
        const out: PolicyDecision[] = [];
        switch (input.type) {
            case "vad": {
                this.nowMs = Math.max(this.nowMs, input.endMs);
                const p = input.probability;
                if (p >= (this._inSpeech ? this.config.vadThreshold : this.onsetThreshold)) {
                    this.silenceStartMs = null;
                    this.lastSpeechEndMs = input.endMs;
                    if (!this._inSpeech) {
                        this._inSpeech = true;
                        this.speechStarted(input.startMs, out);
                    }
                } else if (p < this.silenceThreshold) {
                    if (this._inSpeech) {
                        this._inSpeech = false;
                        this.silenceStartMs = input.startMs;
                    }
                } else if (this._inSpeech) {
                    this.lastSpeechEndMs = input.endMs;
                }
                this.evaluate(out);
                break;
            }
            case "tick":
                this.nowMs = Math.max(this.nowMs, input.nowMs);
                this.evaluate(out);
                break;
            case "turnCommitted":
                if (this.phase.kind !== "finalizing") break;
                this.phase = { kind: "thinking", turnId: input.turnId };
                this.answeredTurn = this.committedBounds ? { turnId: input.turnId, ...this.committedBounds } : null;
                this.committedBounds = null;
                this.setState("thinking", out);
                this.evaluate(out);
                break;
            case "turnDiscarded":
                if (this.phase.kind !== "finalizing") break;
                this.committedBounds = null;
                this.returnToListening(out);
                break;
            case "clausePlaying":
                if (this.answerTurnId !== input.turnId) break;
                if (this.phase.kind === "thinking") {
                    this.phase = { kind: "speaking", turnId: input.turnId };
                    this.setState("speaking", out);
                }
                break;
            case "answerEnded":
                if (this.answerTurnId !== input.turnId) break;
                this.answeredTurn = null;
                this.returnToListening(out);
                break;
        }
        return out;
    }

    private speechStarted(startMs: number, out: PolicyDecision[]): void {
        this.runOnsetMs = startMs;
        switch (this.phase.kind) {
            case "listening":
                this.beginUtterance(startMs, out);
                break;
            case "userTurn":
                this.setState("user-speaking", out);
                break;
            default:
                break;
        }
    }

    private beginUtterance(startMs: number, out: PolicyDecision[]): void {
        this.phase = { kind: "userTurn" };
        this.utteranceStartMs = startMs;
        this.setState("user-speaking", out);
    }

    private returnToListening(out: PolicyDecision[]): void {
        this.phase = { kind: "listening" };
        // Someone already speaking when the answer ends has the floor.
        if (this._inSpeech && this.runOnsetMs !== null) this.beginUtterance(this.runOnsetMs, out);
        else this.setState("listening", out);
    }

    private commit(reason: CommitReason, endMs: number, out: PolicyDecision[]): void {
        const start = this.utteranceStartMs;
        if (start === null) return;
        const end = Math.max(start, endMs);
        out.push({
            type: "commit",
            commit: {
                startMs: start,
                endMs: end,
                decidedAtMs: this.nowMs,
                reason,
                ...(this.continuing ? { continues: this.continuing.turnId } : {}),
            },
        });
        this.committedBounds = { startMs: start, endMs: end };
        this.continuing = null;
        this.phase = { kind: "finalizing" };
        this.utteranceStartMs = null;
        // Speech that runs on past a cut (maxTurn) counts as a new run from here.
        this.runOnsetMs = this._inSpeech ? this.nowMs : null;
        if (this._state !== "confirming-end") this.setState("confirming-end", out);
    }

    private evaluate(out: PolicyDecision[]): void {
        switch (this.phase.kind) {
            case "userTurn": {
                const start = this.utteranceStartMs;
                if (start === null) return;
                if (this.nowMs - start >= this.config.maxTurnMs) {
                    this.commit("maxTurn", this._inSpeech ? this.nowMs : (this.silenceStartMs ?? this.nowMs), out);
                } else if (!this._inSpeech && this.silenceStartMs !== null) {
                    if (this.nowMs - this.silenceStartMs >= this.silenceLimitMs) {
                        this.commit("maxSilence", this.silenceStartMs, out);
                    }
                }
                return;
            }
            case "thinking":
            case "speaking":
                this.evaluateBargeIn(this.phase.turnId, out);
                return;
            default:
                return;
        }
    }

    /** Speech alone (no words in phase 1): a run long enough while the answer is awaited. */
    private evaluateBargeIn(turnId: string, out: PolicyDecision[]): void {
        const onset = this.runOnsetMs;
        if (onset === null || !this._inSpeech) return;
        const speechMs = this.lastSpeechEndMs - onset;
        if (speechMs < this.config.bargeInSpeechMs) return;
        out.push({ type: "bargeIn", turnId });
        this.phase = { kind: "listening" };
        // Taking the floor back right after the turn was sent: the turn was
        // cut too soon. Hear it again from its start and send it whole.
        const answered = this.answeredTurn;
        if (
            answered &&
            answered.turnId === turnId &&
            this.config.continueMs > 0 &&
            onset - answered.endMs <= this.config.continueMs
        ) {
            this.continuing = { turnId, startMs: answered.startMs };
        }
        this.answeredTurn = null;
        this.beginUtterance(this.continuing?.startMs ?? onset, out);
        this.evaluate(out);
    }

    private setState(next: PolicyState, out: PolicyDecision[]): void {
        if (next === this._state) return;
        this._state = next;
        out.push({ type: "state", state: next });
    }
}
