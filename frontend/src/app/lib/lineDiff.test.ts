import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
    it("marks lines added, removed and kept, in reading order", () => {
        expect(lineDiff("# Memory\n- British spelling\n- Short answers", "# Memory\n- Short answers\n- Cites pinpoints")).toEqual([
            { kind: "same", text: "# Memory" },
            { kind: "removed", text: "- British spelling" },
            { kind: "same", text: "- Short answers" },
            { kind: "added", text: "- Cites pinpoints" },
        ]);
    });

    it("compares against nothing as all added, and nothing as all removed", () => {
        expect(lineDiff("", "One\nTwo")).toEqual([
            { kind: "added", text: "One" },
            { kind: "added", text: "Two" },
        ]);
        expect(lineDiff("One", "")).toEqual([{ kind: "removed", text: "One" }]);
        expect(lineDiff("Same", "Same")).toEqual([{ kind: "same", text: "Same" }]);
    });

    it("shows a changed line as the old one removed and the new one added", () => {
        expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
            { kind: "same", text: "a" },
            { kind: "added", text: "B" },
            { kind: "removed", text: "b" },
            { kind: "same", text: "c" },
        ]);
    });
});
