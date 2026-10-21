import { describe, expect, it } from "vitest";
import {
    cardinalWords,
    ordinalWords,
    speakable,
    speakableInline,
    SpeakableStream,
    yearWords,
} from "./speakable";
import { LEGAL_CORPUS } from "./speakable.fixtures";

describe("number words", () => {
    it("reads cardinals, ordinals and years", () => {
        expect(cardinalWords(0)).toBe("zero");
        expect(cardinalWords(42)).toBe("forty-two");
        expect(cardinalWords(40)).toBe("forty");
        expect(cardinalWords(300)).toBe("three hundred");
        expect(cardinalWords(1234)).toBe("one thousand two hundred thirty-four");
        expect(cardinalWords(5000)).toBe("five thousand");
        expect(cardinalWords(2_000_000)).toBe("two million");
        expect(cardinalWords(3_000_001)).toBe("three million one");
        expect(cardinalWords(1e9)).toBe("1000000000");
        expect(cardinalWords(1.5)).toBe("1.5");
        expect(ordinalWords(1)).toBe("first");
        expect(ordinalWords(22)).toBe("twenty-second");
        expect(ordinalWords(23)).toBe("twenty-third");
        expect(ordinalWords(12)).toBe("twelfth");
        expect(ordinalWords(20)).toBe("twentieth");
        expect(ordinalWords(14)).toBe("fourteenth");
        expect(yearWords(1983)).toBe("nineteen eighty-three");
        expect(yearWords(1900)).toBe("nineteen hundred");
        expect(yearWords(1905)).toBe("nineteen oh five");
        expect(yearWords(2000)).toBe("two thousand");
        expect(yearWords(2005)).toBe("two thousand five");
        expect(yearWords(2010)).toBe("twenty ten");
        expect(yearWords(999)).toBe("nine hundred ninety-nine");
    });
});

describe("speakable", () => {
    it.each(LEGAL_CORPUS)("speaks %j", (written, spoken) => {
        expect(speakable(written)).toBe(spoken);
    });

    it("is the same however the answer is split", () => {
        for (const [written] of LEGAL_CORPUS) {
            const whole = speakable(written);
            const byChar = new SpeakableStream();
            for (const char of written) byChar.push(char);
            byChar.finish();
            expect(byChar.text).toBe(whole);
            const byChunks = new SpeakableStream();
            for (let i = 0; i < written.length; i += 7) byChunks.push(written.slice(i, i + 7));
            byChunks.finish();
            expect(byChunks.text).toBe(whole);
        }
    });

    it("never changes what it has emitted, and its pieces cover the answer in order", () => {
        const written = LEGAL_CORPUS.map(([text]) => text).join("\n\n");
        const stream = new SpeakableStream();
        let previous = "";
        for (let i = 0; i < written.length; i += 3) {
            stream.push(written.slice(i, i + 3));
            expect(stream.text.startsWith(previous)).toBe(true);
            previous = stream.text;
        }
        stream.finish();
        expect(stream.source).toBe(written);
        let end = 0;
        let textEnd = 0;
        for (const piece of stream.pieces) {
            expect(piece.start).toBe(end);
            expect(piece.textStart).toBe(textEnd);
            expect(stream.text.slice(piece.textStart, piece.textEnd)).toBe(piece.text);
            end = piece.end;
            textEnd = piece.textEnd;
        }
        expect(end).toBe(written.length);
    });

    it("holds back a word until it is complete and the next one can change its reading", () => {
        const stream = new SpeakableStream();
        expect(stream.push("See No.")).toEqual([expect.objectContaining({ text: "See" }), expect.objectContaining({ text: "" })]);
        expect(stream.push(" 123")).toEqual([]);
        expect(stream.push(" today")).toEqual([expect.objectContaining({ text: " number 123" }), expect.objectContaining({ text: "" })]);
        expect(stream.finish().map((piece) => piece.text)).toEqual([" today"]);
    });

    it("strips markdown and turns code, tables and long quotes into a pointer to the screen", () => {
        expect(
            speakable(
                "## Summary\n\n- **First**, the *tenant* pays.\n- Second, see [the lease](https://x.com/a) at p. 4\n" +
                    "1. Third: `rent_due` and __bold__ ~~old~~ ![chart](c.png)\n\n```js\nconst x = 1;\n```\nThat is all.",
            ),
        ).toBe(
            "Summary. First, the tenant pays. Second, see the lease at page 4. Third: rent_due and bold old. It's on the screen. That is all.",
        );
        expect(speakable("Here are the dates:\n| a | b |\n|---|---|\n| 1 | 2 |\nAfter the table.")).toBe(
            "Here are the dates: it's on the screen. After the table.",
        );
        expect(speakable("| a |\n| b |")).toBe("It's on the screen.");
        expect(speakable("Before\n\n---\n\nAfter")).toBe("Before. After");
        expect(speakable("> Short quote here\n> on two lines\nAnd then text.")).toBe("Short quote here on two lines. And then text.");
        expect(speakable("Intro.\n> " + "word ".repeat(40) + "\nAfter.")).toBe("Intro. The quote is on the screen. After.");
        expect(speakable("Intro:\n> " + "word ".repeat(40))).toBe("Intro: the quote is on the screen.");
        expect(speakable("> Ends here.")).toBe("Ends here.");
        expect(speakable("~~~\nunclosed code")).toBe("It's on the screen.");
    });

    it("says links and bare URLs are on the screen", () => {
        expect(speakable("Visit https://example.com/a. Or <https://b.example> or www.c.org.")).toBe(
            "Visit a link on the screen. Or a link on the screen or a link on the screen.",
        );
    });

    it("drops citation markers, escaped ones too, without leaving a space", () => {
        expect(speakable("Rent is due [1][2]. It is late \\[3\\], says the lease [4]")).toBe(
            "Rent is due. It is late, says the lease",
        );
    });

    it("keeps an abbreviation's period only where a sentence ends", () => {
        expect(speakable("Acme Corp. sued Beta Ltd. in the U.S. In June it settled, etc.")).toBe(
            "Acme Corporation sued Beta Limited in the U S. In June it settled, et cetera.",
        );
        expect(speakable("Paid by Jones Jr., then by Smith Sr.\nNext")).toBe("Paid by Jones Junior, then by Smith Senior. Next");
    });

    it("turns dashes into commas or, in a range, into 'to'", () => {
        expect(speakable("The term—five years—ends 2030 – 2031, then - maybe -- renews 10—12 times.")).toBe(
            "The term, five years, ends 2030 to 2031, then, maybe, renews 10 to 12 times.",
        );
    });

    it("reads remaining dates, months and pinpoints", () => {
        expect(speakable("Filed Jan. 3, 2020; heard Sept. 9th; argued Dec. 2019; decided 2020-13-40 and 13/40/2020.")).toBe(
            "Filed January third, twenty twenty; heard September ninth; argued December twenty nineteen; decided 2020-13-40 and 13/40/2020.",
        );
        expect(speakable("Not on May 45 or 45 May.")).toBe("Not on May 45 or 45 May.");
        expect(speakable("By 5 January the notice under 12(a)(i) and (x) was due, not January 6 2025.")).toBe(
            "By the fifth of January the notice under twelve a one and x was due, not January sixth, twenty twenty-five.",
        );
        expect(speakable("Invoices dated Feb. and Oct., Vol. 2, Ch. 3, Ex. A, Fig. 1, Dist. Ct., approx. 9 a.m.")).toBe(
            "Invoices dated February and October, Volume 2, Chapter 3, Exhibit A, Figure 1, District Court, approximately 9 A M",
        );
        expect(speakable("See 12345(a) and (1)(b) of Arts. 1, Secs. 2, paras. 3, Para. 4, Nos. 5")).toBe(
            "See 12345 a and one b of Articles 1, Sections 2, paragraphs 3, paragraph 4, numbers 5",
        );
        expect(speakable("Seven (7) days and (90) days. ibid. viz. passim vs Bros. Ass'n Dep't Gov't Nat'l Int'l Mrs. Ex. and/or")).toBe(
            "Seven days and ninety days. the same source namely throughout versus Brothers Association Department Government National International Missus Exhibit and or",
        );
    });

    it("reads Latin and procedure abbreviations in any case they come", () => {
        expect(speakableInline("E.g. Fed. R. App. P. 4 and Fed. R. Bankr. P. 7001")).toBe(
            "for example Federal Rule of Appellate Procedure 4 and Federal Rule of Bankruptcy Procedure 7001",
        );
        expect(speakableInline("2024", "signed March 3, ")).toBe("twenty twenty-four");
        expect(speakableInline("– 12", "pages 10 ")).toBe("to 12");
        expect(speakableInline("<br>(  )`")).toBe("");
        expect(speakableInline("one • two … three")).toBe("one two... three");
    });

    it("waits for a line's first word, and for a whole fence, table or quote line", () => {
        const stream = new SpeakableStream();
        expect(stream.push("Hel")).toEqual([]);
        expect(stream.push("lo\n`")).toEqual([
            expect.objectContaining({ text: "Hello" }),
            expect.objectContaining({ text: "." }),
        ]);
        expect(stream.push("``js\ncode")).toEqual([expect.objectContaining({ text: " It's on the screen." })]);
        expect(stream.push(" more")).toEqual([]);
        expect(stream.push("\n```\n> quo")).toEqual([
            expect.objectContaining({ text: "" }),
            expect.objectContaining({ text: "" }),
        ]);
        expect(stream.push("ted\n")).toEqual([]);
        expect(stream.push("| t")).toEqual([expect.objectContaining({ text: " quoted." })]);
        expect(stream.push(" |\n")).toEqual([expect.objectContaining({ text: " It's on the screen." })]);
        expect(stream.finish()).toEqual([]);
        expect(stream.text).toBe("Hello. It's on the screen. quoted. It's on the screen.");
    });

    it("holds an open link or bracket until it closes, or the line ends", () => {
        const stream = new SpeakableStream();
        expect(stream.push("See [the lease ")).toEqual([expect.objectContaining({ text: "See" }), expect.objectContaining({ text: "" })]);
        expect(stream.push("terms](https://x.y) now ")).toEqual([
            expect.objectContaining({ text: " the lease terms" }),
            expect.objectContaining({ text: "" }),
        ]);
        expect(speakable("An (open aside\nnext")).toBe("An (open aside. next");
    });

    it("speaks nothing for an empty answer or blank lines", () => {
        expect(speakable("")).toBe("");
        expect(speakable("\n\n   \n")).toBe("");
        const stream = new SpeakableStream();
        stream.push("   ");
        expect(stream.text).toBe("");
    });
});
