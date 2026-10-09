import { describe, expect, it } from "vitest";
import { branchTitle } from "../chat.branches";

describe("branchTitle", () => {
    it("leaves the first branch unnumbered and numbers the rest", () => {
        expect(branchTitle({ title: "Indemnity review", branchNumber: null }, 1)).toBe("BRANCH Indemnity review");
        expect(branchTitle({ title: "Indemnity review", branchNumber: null }, 2)).toBe("BRANCH 2 Indemnity review");
    });

    it("titles a branch of a branch after the family, not the branch", () => {
        expect(branchTitle({ title: "BRANCH Indemnity review", branchNumber: 1 }, 3)).toBe("BRANCH 3 Indemnity review");
        expect(branchTitle({ title: "BRANCH 2 Indemnity review", branchNumber: 2 }, 3)).toBe("BRANCH 3 Indemnity review");
    });

    it("keeps a title that only looks like a prefix", () => {
        expect(branchTitle({ title: "BRANCH 2024 budget", branchNumber: null }, 1)).toBe("BRANCH BRANCH 2024 budget");
        expect(branchTitle({ title: "BRANCH 2024 budget", branchNumber: 1 }, 2)).toBe("BRANCH 2 2024 budget");
    });

    it("keeps a renamed branch's new title whole", () => {
        expect(branchTitle({ title: "Cap negotiation", branchNumber: 2 }, 3)).toBe("BRANCH 3 Cap negotiation");
    });

    it("is just the prefix for an untitled chat", () => {
        expect(branchTitle({ title: null, branchNumber: null }, 1)).toBe("BRANCH");
        expect(branchTitle({ title: "BRANCH", branchNumber: 1 }, 2)).toBe("BRANCH 2");
        expect(branchTitle({ title: "  ", branchNumber: null }, 4)).toBe("BRANCH 4");
    });
});
