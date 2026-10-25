import { describe, expect, it } from "vitest";
import traces from "./turnPolicy.traces.json";
import { TURN_POLICY_DEFAULTS, TurnPolicy, turnPolicyConfig, type PolicyDecision, type TurnPolicyConfig } from "./turnPolicy";

type Step = {
    op: "speech" | "silence" | "frames" | "tick" | "committed" | "discarded" | "clause" | "answerEnded";
    count?: number;
    probability?: number;
    until?: number;
    turnId?: string;
    expect?: PolicyDecision[];
    state?: string;
    inSpeech?: boolean;
    answerTurnId?: string | null;
};

/** Replays a trace as the Swift tests' `Trace` does: each VAD frame is followed by a clock tick. */
class Replay {
    now = 0;
    constructor(
        readonly policy: TurnPolicy,
        readonly frameMs: number,
    ) {}

    frames(probability: number, count: number): PolicyDecision[] {
        const out: PolicyDecision[] = [];
        for (let i = 0; i < count; i++) {
            const start = this.now;
            this.now += this.frameMs;
            out.push(...this.policy.handle({ type: "vad", probability, startMs: start, endMs: this.now }));
            out.push(...this.policy.handle({ type: "tick", nowMs: this.now }));
        }
        return out;
    }

    tick(until: number): PolicyDecision[] {
        const out: PolicyDecision[] = [];
        while (this.now < until) {
            this.now = Math.min(until, this.now + 10);
            out.push(...this.policy.handle({ type: "tick", nowMs: this.now }));
        }
        return out;
    }

    step(step: Step): PolicyDecision[] {
        switch (step.op) {
            case "speech":
                return this.frames(0.9, step.count ?? 1);
            case "silence":
                return this.frames(0.05, step.count ?? 1);
            case "frames":
                return this.frames(step.probability ?? 0, step.count ?? 1);
            case "tick":
                return this.tick(step.until ?? this.now);
            case "committed":
                return this.policy.handle({ type: "turnCommitted", turnId: step.turnId! });
            case "discarded":
                return this.policy.handle({ type: "turnDiscarded" });
            case "clause":
                return this.policy.handle({ type: "clausePlaying", turnId: step.turnId! });
            case "answerEnded":
                return this.policy.handle({ type: "answerEnded", turnId: step.turnId! });
        }
    }
}

describe("TurnPolicy traces", () => {
    for (const trace of traces.traces) {
        it(trace.name, () => {
            const replay = new Replay(new TurnPolicy(trace.config as Partial<TurnPolicyConfig>), trace.frameMs);
            (trace.steps as Step[]).forEach((step, index) => {
                const out = replay.step(step);
                const where = `${trace.name}, step ${index} (${step.op})`;
                if (step.expect) expect(out, where).toEqual(step.expect);
                if (step.state) expect(replay.policy.state, where).toBe(step.state);
                if (step.inSpeech !== undefined) expect(replay.policy.inSpeech, where).toBe(step.inSpeech);
                if (step.answerTurnId !== undefined) expect(replay.policy.answerTurnId, where).toBe(step.answerTurnId);
            });
        });
    }
});

describe("turnPolicyConfig", () => {
    it("keeps values in range and replaces the rest with the defaults", () => {
        expect(turnPolicyConfig()).toEqual(TURN_POLICY_DEFAULTS);
        const config = turnPolicyConfig({ fallbackSilenceMs: 700, maxTurnMs: 500_000, vadThreshold: Number.NaN, continueMs: 0 });
        expect(config.fallbackSilenceMs).toBe(700);
        expect(config.maxTurnMs).toBe(TURN_POLICY_DEFAULTS.maxTurnMs);
        expect(config.vadThreshold).toBe(TURN_POLICY_DEFAULTS.vadThreshold);
        expect(config.continueMs).toBe(0);
    });

    it("ignores engine events that do not apply", () => {
        const policy = new TurnPolicy();
        expect(policy.handle({ type: "turnCommitted", turnId: "t1" })).toEqual([]);
        expect(policy.handle({ type: "turnDiscarded" })).toEqual([]);
        expect(policy.handle({ type: "answerEnded", turnId: "t1" })).toEqual([]);
        expect(policy.state).toBe("listening");
    });
});

describe("TurnPolicy direct", () => {
    const vad = (policy: TurnPolicy, probability: number, startMs: number, endMs: number) =>
        policy.handle({ type: "vad", probability, startMs, endMs });

    it("speech resuming inside a turn keeps the person speaking without a new state", () => {
        const policy = new TurnPolicy();
        expect(vad(policy, 0.9, 0, 32)).toEqual([{ type: "state", state: "user-speaking" }]);
        expect(vad(policy, 0.05, 32, 64)).toEqual([]);
        expect(policy.inSpeech).toBe(false);
        expect(vad(policy, 0.9, 64, 96)).toEqual([]);
        expect(policy.inSpeech).toBe(true);
        expect(policy.state).toBe("user-speaking");
    });

    it("cuts a turn that runs too long, at the clock while speaking and at the silence's start otherwise", () => {
        const config = { maxTurnMs: 1000 };
        const speaking = new TurnPolicy(config);
        vad(speaking, 0.9, 0, 32);
        const cut = speaking.handle({ type: "tick", nowMs: 1000 });
        expect(cut).toContainEqual({
            type: "commit",
            commit: { startMs: 0, endMs: 1000, decidedAtMs: 1000, reason: "maxTurn" },
        });

        const paused = new TurnPolicy(config);
        vad(paused, 0.9, 0, 100);
        vad(paused, 0.05, 100, 132);
        const late = paused.handle({ type: "tick", nowMs: 1000 });
        expect(late).toContainEqual({
            type: "commit",
            commit: { startMs: 0, endMs: 100, decidedAtMs: 1000, reason: "maxTurn" },
        });
    });
});
