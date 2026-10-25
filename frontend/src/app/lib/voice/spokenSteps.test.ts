import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "@/app/components/shared/types";
import { currentSteps, spokenStep } from "./spokenSteps";

const said = (text: string) => ({ text, source: "side_model" as const });

describe("currentSteps", () => {
    it("lists the summarised steps after the answer's last words", () => {
        const events: AssistantEvent[] = [
            { type: "code_cell", call_id: "old", code: "x", status: "ok", summary: said("Old step") },
            { type: "content", text: "Let me look." },
            { type: "content", text: "   " },
            { type: "reasoning", text: "…", id: "r1", summary: said("Weighed notice") },
            { type: "reasoning", text: "no id", summary: said("Thought more") },
            { type: "code_cell", call_id: "c1", code: "x", status: "running" },
            { type: "code_cell", call_id: "c2", code: "x", status: "running", summary: said("Reading the lease") },
        ];
        expect(currentSteps(events)).toEqual([
            { key: "reasoning:r1", text: "Weighed notice" },
            { key: "event:4", text: "Thought more" },
            { key: "cell:c2", text: "Reading the lease" },
        ]);
        expect(currentSteps([...events, { type: "content", text: "Done." }])).toEqual([]);
    });
});

describe("spokenStep", () => {
    it("says the first sentence, ended, and speakable", () => {
        expect(spokenStep("Read the lease.  Then the deed.")).toBe("Read the lease.");
        expect(spokenStep("Reading the lease")).toBe("Reading the lease.");
        expect(spokenStep("**Checked** clause 12")).toBe("Checked clause 12.");
    });

    it("cuts a long sentence at a word", () => {
        const long = `Compared ${"the notice period and ".repeat(12)}the deed`;
        const result = spokenStep(long);
        expect(result.length).toBeLessThanOrEqual(161);
        expect(result.endsWith("and.")).toBe(false);
        expect(result.endsWith(".")).toBe(true);
    });
});
