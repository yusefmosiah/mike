import { describe, expect, it } from "vitest";
import { ClauseCutter, type Clause } from "./clauses";
import { SpeakableStream } from "./speakable";
import { spokenPrefix, syllables, wordsHeard } from "./spokenPrefix";

/** An answer made speakable and cut into clauses, as voice mode does it. */
function answer(written: string, step = 4) {
    const stream = new SpeakableStream();
    const cutter = new ClauseCutter();
    const clauses: Clause[] = [];
    for (let i = 0; i < written.length; i += step) clauses.push(...cutter.push(stream.push(written.slice(i, i + step))));
    clauses.push(...cutter.push(stream.finish()), ...cutter.finish());
    const heard = (played: number[], interrupted?: { clauseId: number; fraction: number } | null) =>
        spokenPrefix({
            clauses,
            played: new Set(played),
            interrupted,
            spoken: stream.text,
            pieces: stream.pieces,
            source: stream.source,
        });
    return { clauses, heard };
}

describe("syllables", () => {
    it("estimates by vowel groups, numbers by their words", () => {
        expect(syllables("lease")).toBe(1);
        expect(syllables("tenant")).toBe(2);
        expect(syllables("termination,")).toBe(4);
        expect(syllables("table")).toBe(2);
        expect(syllables("rhythm")).toBe(1);
        expect(syllables("1983")).toBe(syllables("one thousand nine hundred eighty-three"));
        expect(syllables("12345678901")).toBe(22);
        expect(syllables("10b")).toBe(2);
        expect(syllables("twenty-four")).toBe(3);
        expect(syllables("—")).toBe(0);
    });
});

describe("wordsHeard", () => {
    it("counts whole words only, weighting by syllables and pauses", () => {
        const text = "The notice period, under clause four, is ninety days.";
        expect(wordsHeard(text, 0)).toBe(0);
        expect(wordsHeard(text, 1)).toBe(9);
        expect(wordsHeard(text, 2)).toBe(9);
        expect(wordsHeard(text, -1)).toBe(0);
        // "The notice period" is 1 + 2 + 2 syllables of 18 (with the pauses).
        expect(wordsHeard(text, 5 / 18)).toBe(3);
        expect(wordsHeard(text, 4.9 / 18)).toBe(2);
    });
});

describe("spokenPrefix", () => {
    const written =
        "Under the lease, the tenant must give **ninety days'** written notice [1]. " +
        "The landlord may then inspect the premises, and any damage is the tenant's to repair [2].";

    it("is empty when nothing was heard", () => {
        const { heard } = answer(written);
        expect(heard([])).toEqual({ original: "", spoken: "" });
        expect(heard([], { clauseId: 0, fraction: 0 })).toEqual({ original: "", spoken: "" });
    });

    it("keeps whole clauses that played, mapped back to the answer as written with their markers", () => {
        const { clauses, heard } = answer(written);
        expect(clauses.map((clause) => clause.text)).toEqual([
            "Under the lease, the tenant must give",
            "ninety days' written notice.",
            "The landlord may then inspect the premises,",
            "and any damage is the tenant's to repair.",
        ].map((text, index) => (index === 0 ? `${text},` : text)));
        expect(heard([0, 1])).toEqual({
            original: "Under the lease, the tenant must give **ninety days'** written notice [1].",
            spoken: "Under the lease, the tenant must give ninety days' written notice.",
        });
        // A clause that did not play ends what was heard, whatever came after.
        expect(heard([0, 2]).original).toBe("Under the lease, the tenant must give");
        expect(heard([0, 1, 2, 3]).original).toBe(written);
    });

    it("cuts the interrupted clause at the last whole word heard", () => {
        const { heard } = answer(written);
        expect(heard([0, 1], { clauseId: 2, fraction: 0.5 })).toEqual({
            original: "Under the lease, the tenant must give **ninety days'** written notice [1]. The landlord may then",
            spoken: "Under the lease, the tenant must give ninety days' written notice. The landlord may then",
        });
        // The citation marker goes with its sentence only once the sentence was heard.
        expect(heard([0], { clauseId: 1, fraction: 0.7 }).original).toBe(
            "Under the lease, the tenant must give **ninety days'** written",
        );
        expect(heard([0], { clauseId: 1, fraction: 1 }).original).toBe(
            "Under the lease, the tenant must give **ninety days'** written notice [1].",
        );
        expect(heard([0, 1], { clauseId: 2, fraction: 0 }).original).toBe(
            "Under the lease, the tenant must give **ninety days'** written notice [1].",
        );
    });

    it("never splits a citation read as several words", () => {
        const { clauses, heard } = answer("Dismissal is proper under Fed. R. Civ. P. 12(b)(6) when the facts are implausible.");
        expect(clauses[0].text).toBe("Dismissal is proper under Federal Rule of Civil Procedure twelve b six,");
        // Most of the citation was spoken, but not all of it: it is not counted.
        expect(heard([], { clauseId: 0, fraction: 0.8 }).original).toBe("Dismissal is proper under");
        expect(heard([0]).original).toBe("Dismissal is proper under Fed. R. Civ. P. 12(b)(6)");
    });

    it("drops a list marker that opens the next line, and keeps a code block heard as 'on the screen'", () => {
        const list = "Two things matter here:\n- The notice must be in writing.\n- It must reach the landlord in time.";
        const { heard: heardList } = answer(list);
        expect(heardList([0]).original).toBe("Two things matter here:");
        const code = "Here is the clause you asked for:\n```\nclause 4\n```\nThat is the whole of it.";
        const { clauses, heard: heardCode } = answer(code);
        expect(clauses[0].text).toBe("Here is the clause you asked for: it's on the screen.");
        expect(heardCode([0]).original).toBe("Here is the clause you asked for:\n```\nclause 4\n```");
    });
});
