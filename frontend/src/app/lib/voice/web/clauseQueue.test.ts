import { describe, expect, it } from "vitest";
import { ClauseQueue, type ClausePlayback, type ClauseQueueEvent, type RenderedClause } from "./clauseQueue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A renderer whose renders finish when the test says, and a player that does the same. */
function harness(renderAhead = 2) {
    const renders: { text: string; done: ReturnType<typeof deferred<RenderedClause>>; signal: AbortSignal }[] = [];
    const plays: { clause: RenderedClause; step: boolean; done: ReturnType<typeof deferred<void>>; fraction: number; stopped: boolean }[] = [];
    const preloaded: RenderedClause[] = [];
    const events: ClauseQueueEvent[] = [];
    const queue = new ClauseQueue({
        renderAhead,
        emit: (event) => events.push(event),
        renderer: {
            render: (text, signal) => {
                const done = deferred<RenderedClause>();
                renders.push({ text, done, signal });
                return done.promise;
            },
        },
        player: {
            play: (clause, { step }): ClausePlayback => {
                const entry = { clause, step, done: deferred<void>(), fraction: 0.4, stopped: false };
                plays.push(entry);
                return {
                    ended: entry.done.promise,
                    stop: () => {
                        entry.stopped = true;
                        return entry.fraction;
                    },
                };
            },
            preload: (clause) => preloaded.push(clause),
        },
    });
    const audio = (text: string): RenderedClause => ({ kind: "utterance", text });
    return { queue, renders, plays, preloaded, events, audio };
}

describe("ClauseQueue", () => {
    it("renders ahead one at a time, plays in order and finishes after the end", async () => {
        const { queue, renders, plays, preloaded, events, audio } = harness();
        queue.begin("t1");
        expect(queue.accept("t1", 0, "First.")).toBe(true);
        expect(queue.accept("t1", 1, "Second.")).toBe(true);
        expect(queue.accept("t1", 2, "Third.")).toBe(true);
        expect(queue.accept("t1", 3, "Fourth.")).toBe(true);
        // One render at a time.
        expect(renders.map((render) => render.text)).toEqual(["First."]);
        renders[0].done.resolve(audio("First."));
        await flush();
        expect(events).toEqual([{ type: "clauseStarted", turnId: "t1", clauseId: 0 }]);
        expect(plays).toHaveLength(1);
        expect(renders.map((render) => render.text)).toEqual(["First.", "Second."]);
        renders[1].done.resolve(audio("Second."));
        await flush();
        // The next clause is handed to the player to load ahead.
        expect(preloaded).toEqual([audio("Second.")]);
        // Two rendered and waiting at most beyond the one playing.
        renders[2].done.resolve(audio("Third."));
        await flush();
        expect(renders).toHaveLength(3);
        plays[0].done.resolve();
        await flush();
        expect(events.slice(1)).toEqual([
            { type: "clausePlayed", turnId: "t1", clauseId: 0 },
            { type: "clauseStarted", turnId: "t1", clauseId: 1 },
        ]);
        expect(renders).toHaveLength(4);
        expect(queue.busy).toBe(true);
        queue.end("t1");
        renders[3].done.resolve(audio("Fourth."));
        for (const index of [1, 2, 3]) {
            await flush();
            plays[index].done.resolve();
        }
        await flush();
        expect(events.slice(-2)).toEqual([
            { type: "clausePlayed", turnId: "t1", clauseId: 3 },
            { type: "answerFinished", turnId: "t1" },
        ]);
        expect(queue.busy).toBe(false);
        expect(queue.currentTurn).toBeNull();
    });

    it("refuses another turn's clause, a clause after the end and an id that does not increase", () => {
        const { queue } = harness();
        expect(queue.accept("t1", 0, "No answer yet.")).toBe(false);
        queue.begin("t1");
        expect(queue.accept("t2", 0, "Other turn.")).toBe(false);
        expect(queue.accept("t1", 2, "Two.")).toBe(true);
        expect(queue.accept("t1", 2, "Two again.")).toBe(false);
        expect(queue.accept("t1", 1, "One.")).toBe(false);
        expect(queue.accept("t1", -1, "Negative.")).toBe(false);
        queue.end("t1");
        expect(queue.accept("t1", 3, "After the end.")).toBe(false);
        expect(queue.end("t2")).toBe(false);
    });

    it("an answer with nothing to say finishes at once", () => {
        const { queue, events } = harness();
        queue.begin("t1");
        queue.end("t1");
        expect(events).toEqual([{ type: "answerFinished", turnId: "t1" }]);
    });

    it("a clause that fails to render counts as played", async () => {
        const { queue, renders, events } = harness();
        queue.begin("t1");
        queue.accept("t1", 0, "Broken.");
        queue.end("t1");
        renders[0].done.reject(new Error("synthesis failed"));
        await flush();
        expect(events).toEqual([
            { type: "clauseStarted", turnId: "t1", clauseId: 0 },
            { type: "clausePlayed", turnId: "t1", clauseId: 0 },
            { type: "answerFinished", turnId: "t1" },
        ]);
    });

    it("cancelling reports how much of the playing clause was heard, and drops the rest", async () => {
        const { queue, renders, plays, events, audio } = harness();
        queue.begin("t1");
        queue.accept("t1", 0, "First.");
        queue.accept("t1", 1, "Second.");
        renders[0].done.resolve(audio("First."));
        await flush();
        const signal = renders[1].signal;
        expect(queue.cancel("t2")).toBe(false);
        expect(queue.cancel("t1")).toBe(true);
        expect(plays[0].stopped).toBe(true);
        expect(signal.aborted).toBe(true);
        expect(events.at(-1)).toEqual({ type: "interrupted", turnId: "t1", clauseId: 0, fraction: 0.4 });
        // Late work from the cancelled answer changes nothing.
        renders[1].done.resolve(audio("Second."));
        plays[0].done.resolve();
        await flush();
        expect(events.filter((event) => event.type === "clausePlayed")).toEqual([]);
        expect(queue.busy).toBe(false);
    });

    it("cancelling between clauses reports the next one at 0, and before anything played reports nothing", async () => {
        const { queue, renders, plays, events, audio } = harness();
        queue.begin("t1");
        queue.accept("t1", 0, "First.");
        queue.accept("t1", 1, "Second.");
        queue.cancel("t1");
        expect(events).toEqual([]);

        queue.begin("t2");
        queue.accept("t2", 0, "First.");
        queue.accept("t2", 1, "Second.");
        renders[1].done.resolve(audio("First."));
        await flush();
        plays[0].done.resolve();
        await flush();
        queue.cancel("t2");
        expect(events.at(-1)).toEqual({ type: "interrupted", turnId: "t2", clauseId: 1, fraction: 0 });
    });

    it("an answer clause ends the steps not yet heard", async () => {
        const { queue, renders, plays, events, audio } = harness();
        queue.begin("t1");
        queue.accept("t1", 0, "Reading the lease.", true);
        queue.accept("t1", 1, "Checking clause four.", true);
        renders[0].done.resolve(audio("Reading the lease."));
        await flush();
        expect(plays[0].step).toBe(true);
        queue.accept("t1", 2, "Clause four says the rent is due.");
        expect(plays[0].stopped).toBe(true);
        expect(events).toEqual([
            { type: "clauseStarted", turnId: "t1", clauseId: 0 },
            { type: "clausePlayed", turnId: "t1", clauseId: 0 },
            { type: "clauseStarted", turnId: "t1", clauseId: 1 },
            { type: "clausePlayed", turnId: "t1", clauseId: 1 },
        ]);
        // The step being rendered when it was dropped is ignored; the answer renders next.
        renders[1].done.resolve(audio("Checking clause four."));
        await flush();
        expect(renders.at(-1)?.text).toBe("Clause four says the rent is due.");
    });

    it("begin drops another answer without a word", async () => {
        const { queue, renders, plays, events, audio } = harness();
        queue.begin("t1");
        queue.accept("t1", 0, "First.");
        renders[0].done.resolve(audio("First."));
        await flush();
        events.length = 0;
        queue.begin("t2");
        expect(plays[0].stopped).toBe(true);
        expect(events).toEqual([]);
        expect(queue.currentTurn).toBe("t2");
    });
});
