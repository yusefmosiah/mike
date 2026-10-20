import { describe, expect, it } from "vitest";
import { ORDINARY_SENTENCES, SPIKE_TERMS, SPIKE_TRANSCRIPTS } from "./vocabulary.fixtures";
import { correctWithVocabulary, correctWithVocabularyDetailed } from "./vocabulary";

const nameForm = (text: string) =>
    text
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "");

describe("correctWithVocabulary on the spike transcripts", () => {
    it("fixes names the engine got wrong, and reports the counts", () => {
        let places = 0;
        let rightBefore = 0;
        let rightAfter = 0;
        for (const [said, wrote] of SPIKE_TRANSCRIPTS) {
            const fixed = correctWithVocabulary(wrote, { terms: SPIKE_TERMS });
            for (const term of SPIKE_TERMS) {
                if (!nameForm(said).includes(nameForm(term))) continue;
                places++;
                if (nameForm(wrote).includes(nameForm(term))) rightBefore++;
                if (nameForm(fixed).includes(nameForm(term))) rightAfter++;
            }
        }
        console.info(`names right before ${rightBefore}/${places}, after ${rightAfter}/${places}`);
        expect(places).toBe(32);
        expect(rightBefore).toBeLessThanOrEqual(2);
        expect(rightAfter).toBeGreaterThanOrEqual(22);
    });

    it("writes terms as the person spelled them, keeping punctuation", () => {
        const fixed = correctWithVocabulary("Please send the draft to Zamina Akterberg before noon.", {
            terms: ["Ximena Achterberg"],
        });
        expect(fixed).toBe("Please send the draft to Ximena Achterberg before noon.");
        expect(correctWithVocabulary("Ask Zamina Akterberg, then wait.", { terms: ["Ximena Achterberg"] })).toBe(
            "Ask Ximena Achterberg, then wait.",
        );
    });
});

describe("correctWithVocabulary on ordinary sentences", () => {
    it("leaves every one of them unchanged", () => {
        expect(ORDINARY_SENTENCES).toHaveLength(42);
        const changed = ORDINARY_SENTENCES.filter(
            (sentence) => correctWithVocabulary(sentence, { terms: SPIKE_TERMS }) !== sentence,
        );
        console.info(`false corrections: ${changed.length}/${ORDINARY_SENTENCES.length}`);
        expect(changed).toEqual([]);
    });

    it("does not touch near misses", () => {
        for (const sentence of [
            "Kingsley Holdings agreed to the terms.",
            "Lindsay Oyelaran will join us.",
            "Vasquez filed the motion on Monday.",
        ]) {
            expect(correctWithVocabulary(sentence, { terms: SPIKE_TERMS })).toBe(sentence);
        }
    });
});

describe("correctWithVocabulary rules", () => {
    const vocabulary = { terms: ["Ximena Achterberg"] };

    it("leaves a span that is already right, whatever its case or punctuation", () => {
        expect(correctWithVocabulary("send it to ximena achterberg.", vocabulary)).toBe("send it to ximena achterberg.");
        expect(correctWithVocabulary("send it to Ximena Achterberg.", vocabulary)).toBe("send it to Ximena Achterberg.");
    });

    it("does nothing without terms or text", () => {
        expect(correctWithVocabulary("Zamina Akterberg", { terms: [] })).toBe("Zamina Akterberg");
        expect(correctWithVocabulary("", vocabulary)).toBe("");
    });

    it("rejects windows that start or end with a stopword", () => {
        const { matches } = correctWithVocabularyDetailed("and Zamina Akterberg of", vocabulary);
        expect(matches).toHaveLength(1);
        expect(matches[0].original).toBe("Zamina Akterberg");
    });

    it("reads & as and, and ignores diacritics", () => {
        expect(correctWithVocabulary("Thibado and Nakamura LLP", { terms: ["Thibodeaux & Nakamura LLP"] })).toBe(
            "Thibodeaux & Nakamura LLP",
        );
        expect(correctWithVocabulary("Shepanski Holdings", { terms: ["Szczepański Holdings"] })).toBe(
            "Szczepański Holdings",
        );
    });

    it("applies the thresholds at their edges", () => {
        const { matches } = correctWithVocabularyDetailed("Zamina Akterberg", vocabulary);
        expect(matches[0].score).toBeGreaterThanOrEqual(0.7);
        // Sounds alike only in part: below the score floor.
        expect(correctWithVocabulary("Samantha Aldenberg", vocabulary)).toBe("Samantha Aldenberg");
        // Phonetically equal one-word windows that share too few characters.
        expect(correctWithVocabulary("Kay", { terms: ["Chi"] })).toBe("Kay");
    });

    it("resolves overlapping windows by score, once per span", () => {
        const text = "Conquo Lindqvist and Zamina Akterberg";
        const fixed = correctWithVocabulary(text, { terms: ["Okonkwo-Lindqvist", "Ximena Achterberg"] });
        expect(fixed).toBe("Okonkwo-Lindqvist and Ximena Achterberg");
    });

    it("lets the person's term win over an automatic one", () => {
        const fixed = correctWithVocabulary("Zamina Akterberg", {
            terms: ["Ximena Achterberg"],
            automatic: ["Ximena Achterberg Trust"],
        });
        expect(fixed).toBe("Ximena Achterberg");
    });

    it("fixes every occurrence of a name, left to right", () => {
        const text = "Zamina Akterberg called; then Zamina Akterberg wrote.";
        expect(correctWithVocabulary(text, { terms: ["Ximena Achterberg"] })).toBe(
            "Ximena Achterberg called; then Ximena Achterberg wrote.",
        );
    });

    it("skips blank, punctuation-only, over-long and repeated terms", () => {
        const detailed = correctWithVocabularyDetailed("Zamina Akterberg", {
            terms: ["", "  ", "--", "One Two Three Four Five", "Ximena Achterberg", "ximena achterberg"],
        });
        expect(detailed.text).toBe("Ximena Achterberg");
        expect(detailed.matches).toHaveLength(1);
    });

    it("ignores automatic terms under six characters, and short windows for them", () => {
        expect(correctWithVocabulary("the Smyth deal", { terms: [], automatic: ["Smith"] })).toBe("the Smyth deal");
        expect(correctWithVocabulary("the Smyth deal", { terms: ["Smith"] })).toBe("the Smith deal");
        expect(correctWithVocabulary("the Henderzon deal", { terms: [], automatic: ["Henderson"] })).toBe(
            "the Henderson deal",
        );
    });
});
