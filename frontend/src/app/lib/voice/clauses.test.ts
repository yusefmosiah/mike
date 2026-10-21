import { describe, expect, it } from "vitest";
import { ClauseCutter, endsSentence, MAX_CLAUSE_WORDS, type Clause } from "./clauses";
import { speakable, SpeakableStream } from "./speakable";
import { LEGAL_CORPUS } from "./speakable.fixtures";

const words = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

function cutAll(text: string, step = text.length): Clause[] {
    const cutter = new ClauseCutter();
    const clauses: Clause[] = [];
    for (let i = 0; i < text.length; i += step) clauses.push(...cutter.push(text.slice(i, i + step)));
    return [...clauses, ...cutter.finish()];
}

describe("endsSentence", () => {
    it("guards abbreviations and initials, not capitalisation", () => {
        expect(endsSentence("lease.")).toBe(true);
        expect(endsSentence("now?")).toBe(true);
        expect(endsSentence("yes!)")).toBe(true);
        expect(endsSentence('said."')).toBe(true);
        expect(endsSentence("wait...")).toBe(true);
        expect(endsSentence("J.")).toBe(false);
        expect(endsSentence("U.S.")).toBe(false);
        expect(endsSentence("St.")).toBe(false);
        expect(endsSentence("(Inc.")).toBe(false);
        expect(endsSentence("clause,")).toBe(false);
        expect(endsSentence("3.5")).toBe(false);
    });
});

describe("ClauseCutter", () => {
    it("starts with a short clause, then cuts at sentences and at commas once a clause is long enough", () => {
        const text =
            "Under the lease, the tenant must give ninety days' written notice before ending it. " +
            "The landlord may then inspect the premises, and any damage beyond normal wear is the tenant's to repair.";
        expect(cutAll(text).map((clause) => clause.text)).toEqual([
            "Under the lease, the tenant must give",
            "ninety days' written notice before ending it.",
            "The landlord may then inspect the premises,",
            "and any damage beyond normal wear is the tenant's to repair.",
        ].map((clause, index) => (index === 0 ? `${clause},` : clause)));
    });

    it("never leaves a clause under four words: a short sentence joins the next, a comma near the end is skipped", () => {
        expect(cutAll("Yes. The notice period is ninety days, he said.").map((clause) => clause.text)).toEqual([
            "Yes. The notice period is ninety days, he said.",
        ]);
        expect(cutAll("The court held, in short, that the clause is void.").map((clause) => clause.text)).toEqual([
            "The court held, in short,",
            "that the clause is void.",
        ]);
    });

    it("ends a clause cut mid-sentence with a comma, also after a semicolon, colon or bracket", () => {
        const texts = cutAll(
            "Three points matter here: the notice, the cure period and the remedy; each of them is set out in the lease " +
                "(see clause four and its schedule) and none of them can be waived by the tenant without the landlord's written consent at all.",
        ).map((clause) => clause.text);
        expect(texts[0]).toBe("Three points matter here,");
        expect(texts.slice(0, -1).every((text) => text.endsWith(","))).toBe(true);
        expect(texts.at(-1)!.endsWith(".")).toBe(true);
        expect(texts.some((text) => text.includes("remedy,"))).toBe(true);
    });

    it("cuts a long clause without punctuation at the cap", () => {
        const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
        const clauses = cutAll(`A short opening clause is here. ${long}`);
        expect(clauses.every((clause) => words(clause.text) <= MAX_CLAUSE_WORDS + 3)).toBe(true);
        expect(clauses.length).toBeGreaterThan(2);
        expect(clauses[1].text.endsWith(",")).toBe(true);
    });

    it("cuts the same however the text arrives, and only once a cut is certain", () => {
        const text = LEGAL_CORPUS.map(([, spoken]) => spoken).join(" ");
        const whole = cutAll(text);
        expect(cutAll(text, 1)).toEqual(whole);
        expect(cutAll(text, 5)).toEqual(whole);
        for (const clause of whole) {
            expect(words(clause.text)).toBeGreaterThanOrEqual(4);
            expect(words(clause.text)).toBeLessThanOrEqual(MAX_CLAUSE_WORDS + 3);
            expect(text.slice(clause.start, clause.end).replace(/[,;:]$/, "")).toBe(clause.text.replace(/[,;:]$/, ""));
        }
        expect(whole.map((clause) => clause.id)).toEqual(whole.map((_, index) => index));
        expect(whole.at(-1)!.final).toBe(true);
        expect(whole.slice(0, -1).some((clause) => clause.final)).toBe(false);
    });

    it("waits for words after a possible cut before making it", () => {
        const cutter = new ClauseCutter();
        expect(cutter.push("Under the lease agreement, the")).toEqual([]);
        expect(cutter.push(" tenant")).toEqual([]);
        expect(cutter.push(" must")).toEqual([]);
        expect(cutter.push(" ")).toEqual([
            { id: 0, text: "Under the lease agreement,", start: 0, end: 26 },
        ]);
    });

    it("keeps a legal citation in one piece, since it arrives as words", () => {
        const written = "Dismissal under Fed. R. Civ. P. 12(b)(6) requires plausible facts, as the Court held.";
        const stream = new SpeakableStream();
        const cutter = new ClauseCutter();
        const clauses = [...cutter.push(stream.push(written)), ...cutter.push(stream.finish()), ...cutter.finish()];
        // The first clause is cut short for a quick start, but after the citation, not inside it.
        expect(clauses.map((clause) => clause.text)).toEqual([
            "Dismissal under Federal Rule of Civil Procedure twelve b six,",
            "requires plausible facts, as the Court held.",
        ]);
        expect(clauses.map((clause) => clause.text).join(" ").replace("six,", "six")).toBe(speakable(written));
    });

    it("marks the last clause final, even when the rest is only punctuation, and handles an empty answer", () => {
        const cutter = new ClauseCutter();
        const clauses = cutter.push("The tenant pays the rent on the first day. ");
        expect(clauses).toHaveLength(1);
        expect(cutter.push(" ...")).toEqual([]);
        expect(cutter.finish()).toEqual([]);
        expect(new ClauseCutter().finish()).toEqual([]);
        const other = new ClauseCutter();
        other.push("The tenant pays the rent on the first day. ");
        expect(other.push("—")).toEqual([]);
        expect(other.finish()).toEqual([]);
        const last = new ClauseCutter();
        expect(last.push("The tenant pays the rent on the first day.")).toEqual([]);
        expect(last.finish()).toEqual([
            { id: 0, text: "The tenant pays the rent on the first day.", start: 0, end: 42, final: true },
        ]);
    });

    it("does not cut near the end of an answer that stops without a full stop", () => {
        const cutter = new ClauseCutter();
        expect(cutter.push("The court held that the tenant pays, and so")).toEqual([]);
        expect(cutter.finish()).toEqual([
            { id: 0, text: "The court held that the tenant pays, and so", start: 0, end: 43, final: true },
        ]);
    });

    it("marks a cut clause final when nothing follows it", () => {
        const cutter = new ClauseCutter();
        cutter.push("The tenant pays the rent on the first day. And ");
        expect(cutter.finish().at(-1)).toMatchObject({ text: "And", final: true });
        const stream = new SpeakableStream();
        const done = new ClauseCutter();
        const texts = done.push(stream.push("The rent is due on the first of the month. ").map((p) => p.text).join(""));
        expect(texts.map((clause) => clause.text)).toEqual([]);
        const rest = done.push(stream.finish().map((p) => p.text).join(""));
        const final = done.finish();
        expect([...rest, ...final].map((clause) => clause.final)).toEqual([true]);
    });
});
