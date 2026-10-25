/**
 * The clauses of the answer being spoken in the browser (docs/voice-web.md,
 * "STT and TTS"; the native counterpart is ClauseQueue.swift). Clauses are
 * rendered ahead of the one playing (one at a time, up to `renderAhead`
 * waiting), played strictly in `clauseId` order, and reported with the
 * contract's events: `clauseStarted`, `clausePlayed`, `answerFinished` after
 * `voiceEndAnswer`, and `interrupted` with the share of the playing clause
 * heard when the answer is cancelled. Every path that ends an answer bumps a
 * token, so a render or a playback that finishes late is ignored.
 */

/** A clause ready to play: audio for an `<audio>` element, or text the system's voice reads itself. */
export type RenderedClause = { kind: "audio"; blob: Blob } | { kind: "utterance"; text: string } | { kind: "none" };

export interface ClauseRenderer {
    render(text: string, signal: AbortSignal): Promise<RenderedClause>;
}

export interface ClausePlayback {
    /** Resolves when the clause has played to its end; never after `stop`. */
    ended: Promise<void>;
    /** Stops at once; returns the share of the clause heard, 0..1. */
    stop(): number;
}

export interface ClausePlayer {
    play(clause: RenderedClause, options: { step: boolean }): ClausePlayback;
    /** The clause that plays next is ready: the player may load it ahead. */
    preload?(clause: RenderedClause): void;
}

export type ClauseQueueEvent =
    | { type: "clauseStarted"; turnId: string; clauseId: number }
    | { type: "clausePlayed"; turnId: string; clauseId: number }
    | { type: "interrupted"; turnId: string; clauseId: number; fraction: number }
    | { type: "answerFinished"; turnId: string };

interface ClauseRecord {
    id: number;
    text: string;
    step: boolean;
    state: "queued" | "rendering" | "ready" | "playing" | "done";
    rendered?: RenderedClause;
    started: boolean;
}

export interface ClauseQueueOptions {
    renderer: ClauseRenderer;
    player: ClausePlayer;
    emit: (event: ClauseQueueEvent) => void;
    /** Clauses rendered and waiting beyond the one playing (1–2). */
    renderAhead?: number;
}

export class ClauseQueue {
    private turnId: string | null = null;
    private token = 0;
    private records: ClauseRecord[] = [];
    private endRequested = false;
    private playing: { record: ClauseRecord; playback: ClausePlayback } | null = null;
    private abort = new AbortController();
    private readonly renderAhead: number;

    constructor(private readonly options: ClauseQueueOptions) {
        this.renderAhead = Math.max(1, Math.min(2, options.renderAhead ?? 2));
    }

    /** The answer being spoken, if any. */
    get currentTurn(): string | null {
        return this.turnId;
    }

    /** Something of the current answer is waiting, rendering or playing. */
    get busy(): boolean {
        return this.turnId !== null && (this.playing !== null || this.records.some((record) => record.state !== "done"));
    }

    /** A clause of the answer is playing now. */
    get audible(): boolean {
        return this.playing !== null;
    }

    /** Starts a new answer, dropping anything left of another without a word. */
    begin(turnId: string): void {
        this.clear();
        this.turnId = turnId;
    }

    /**
     * Queues a clause of the current answer. Refuses another turn's clause, a
     * clause after the end, and an id that does not increase. An answer clause
     * arriving while steps are unplayed ends those steps at once.
     */
    accept(turnId: string, clauseId: number, text: string, step = false): boolean {
        if (turnId !== this.turnId || this.endRequested || !Number.isInteger(clauseId) || clauseId < 0) return false;
        const last = this.records[this.records.length - 1];
        if (last && clauseId <= last.id) return false;
        if (!step) this.yieldSteps();
        this.records.push({ id: clauseId, text, step, state: "queued", started: false });
        this.pump();
        return true;
    }

    /** No more clauses for this answer; `answerFinished` follows the last one. */
    end(turnId: string): boolean {
        if (turnId !== this.turnId) return false;
        this.endRequested = true;
        this.checkFinished();
        return true;
    }

    /**
     * Ends the answer now. Reports `interrupted` for the clause that was
     * playing (or, between clauses, the next one at 0) if anything had started.
     */
    cancel(turnId: string): boolean {
        if (turnId !== this.turnId) return false;
        const anythingStarted = this.records.some((record) => record.started);
        let interruption: { clauseId: number; fraction: number } | null = null;
        if (anythingStarted) {
            const next = this.records.find((record) => record.state !== "done");
            if (next && this.playing?.record === next) {
                interruption = { clauseId: next.id, fraction: clamp(this.playing.playback.stop()) };
                this.playing = null;
            } else if (next) {
                interruption = { clauseId: next.id, fraction: 0 };
            } else {
                interruption = { clauseId: this.records[this.records.length - 1].id, fraction: 1 };
            }
        }
        this.clear();
        if (interruption) this.options.emit({ type: "interrupted", turnId, ...interruption });
        return true;
    }

    /** Drops everything, reporting nothing (voice mode stopped). */
    clear(): void {
        this.token += 1;
        this.abort.abort();
        this.abort = new AbortController();
        this.playing?.playback.stop();
        this.playing = null;
        this.turnId = null;
        this.records = [];
        this.endRequested = false;
    }

    private yieldSteps(): void {
        const turnId = this.turnId;
        if (!turnId) return;
        const steps = this.records.filter((record) => record.step && record.state !== "done");
        if (steps.length === 0) return;
        if (this.playing && this.playing.record.step) {
            this.playing.playback.stop();
            this.playing = null;
        }
        for (const record of steps) {
            if (!record.started) this.options.emit({ type: "clauseStarted", turnId, clauseId: record.id });
            record.started = true;
            record.state = "done";
            this.options.emit({ type: "clausePlayed", turnId, clauseId: record.id });
        }
        this.records = this.records.filter((record) => !steps.includes(record));
    }

    private pump(): void {
        if (!this.turnId) return;
        this.renderNext();
        this.playNext();
    }

    private renderNext(): void {
        if (this.records.some((record) => record.state === "rendering")) return;
        const waiting = this.records.filter((record) => record.state === "ready").length;
        if (waiting >= this.renderAhead) return;
        const record = this.records.find((candidate) => candidate.state === "queued");
        if (!record) return;
        record.state = "rendering";
        const token = this.token;
        const signal = this.abort.signal;
        void this.options.renderer.render(record.text, signal).then(
            (rendered) => this.rendered(token, record, rendered),
            () => this.rendered(token, record, { kind: "none" }),
        );
    }

    private rendered(token: number, record: ClauseRecord, rendered: RenderedClause): void {
        if (token !== this.token || record.state !== "rendering") return;
        record.state = "ready";
        record.rendered = rendered;
        if (this.playing) {
            const next = this.records.find((candidate) => candidate.state !== "done" && candidate !== this.playing?.record);
            if (next === record) this.options.player.preload?.(rendered);
        }
        this.pump();
    }

    private playNext(): void {
        const turnId = this.turnId;
        if (!turnId || this.playing) return;
        const record = this.records.find((candidate) => candidate.state !== "done");
        if (!record || record.state !== "ready") {
            this.checkFinished();
            return;
        }
        const token = this.token;
        record.started = true;
        this.options.emit({ type: "clauseStarted", turnId, clauseId: record.id });
        if (!record.rendered || record.rendered.kind === "none") {
            // Nothing to hear (the render failed): it counts as played.
            this.finishClause(token, record);
            return;
        }
        record.state = "playing";
        const playback = this.options.player.play(record.rendered, { step: record.step });
        this.playing = { record, playback };
        this.renderNext();
        void playback.ended.then(
            () => this.finishClause(token, record),
            () => this.finishClause(token, record),
        );
    }

    private finishClause(token: number, record: ClauseRecord): void {
        const turnId = this.turnId;
        if (token !== this.token || !turnId || record.state === "done") return;
        record.state = "done";
        if (this.playing?.record === record) this.playing = null;
        this.options.emit({ type: "clausePlayed", turnId, clauseId: record.id });
        this.pump();
    }

    private checkFinished(): void {
        const turnId = this.turnId;
        if (!turnId || !this.endRequested || this.playing) return;
        if (this.records.some((record) => record.state !== "done")) return;
        this.turnId = null;
        this.records = [];
        this.endRequested = false;
        this.options.emit({ type: "answerFinished", turnId });
    }
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
