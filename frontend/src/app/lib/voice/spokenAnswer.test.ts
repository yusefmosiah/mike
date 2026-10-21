import { describe, expect, it } from "vitest";
import { spokenAnswer } from "./spokenAnswer";

describe("spokenAnswer", () => {
    it("joins the answer's text pieces with a paragraph break and counts the finished ones", () => {
        expect(
            spokenAnswer({
                content: "",
                events: [
                    { type: "content", text: "Let me check the lease." },
                    { type: "reasoning", text: "Reading clause 12." },
                    { type: "content", text: "Clause 12 needs ninety days", isStreaming: true },
                ],
            }),
        ).toEqual({ text: "Let me check the lease.\n\nClause 12 needs ninety days", settled: 1 });
    });

    it("falls back to the message text when there are no pieces", () => {
        expect(spokenAnswer({ content: "Ninety days." })).toEqual({ text: "Ninety days.", settled: 0 });
    });
});
