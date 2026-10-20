import { afterEach, describe, expect, it } from "vitest";
import {
    assistantTurnsInFlight,
    resetAssistantTurnRunsForTests,
    startAssistantTurnRun,
    waitForAssistantTurns,
} from "../assistantTurnRuns";
import { startStreamRun } from "../streamRuns";

afterEach(() => resetAssistantTurnRunsForTests());

const turn = (id: string, surface: "chat" | "tabular" | "word" = "chat") =>
    startAssistantTurnRun({ id, chatId: id, userId: "u", assistantMessageId: id, surface })!;

describe("waiting for assistant turns at shutdown", () => {
    it("counts turns that are still generating, on every turn surface", () => {
        const a = turn("a");
        turn("b", "tabular");
        turn("c", "word");
        expect(assistantTurnsInFlight()).toBe(3);
        a.finish();
        expect(assistantTurnsInFlight()).toBe(2);
    });

    it("does not count a tabular generation, which is not an assistant turn", () => {
        startStreamRun({ id: "r", key: "review:r", userId: "u", forcedStopFrames: [] });
        expect(assistantTurnsInFlight()).toBe(0);
    });

    it("resolves as soon as the last turn finishes", async () => {
        const run = turn("a");
        setTimeout(() => run.finish(), 30);
        const started = Date.now();
        expect(await waitForAssistantTurns(5_000, 10)).toBe(0);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("gives up at the deadline and reports what is left", async () => {
        turn("a");
        expect(await waitForAssistantTurns(60, 10)).toBe(1);
    });
});
