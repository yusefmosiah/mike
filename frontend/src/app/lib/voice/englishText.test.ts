import { describe, expect, it } from "vitest";
import { looksEnglish } from "./englishText";

describe("looksEnglish", () => {
    it("accepts English prose, including a few accented words", () => {
        expect(looksEnglish("The court held that the contract was void for want of consideration.")).toBe(true);
        expect(looksEnglish("She filed a résumé with the clerk and it was accepted by the court.")).toBe(true);
        expect(looksEnglish("Yes.")).toBe(true);
        expect(looksEnglish("OK, sure")).toBe(true);
    });

    it("accepts text with no letters", () => {
        expect(looksEnglish("")).toBe(true);
        expect(looksEnglish("1, 2, 3 — 4.5%")).toBe(true);
    });

    it("rejects other scripts", () => {
        expect(looksEnglish("これは日本語の文章です。")).toBe(false);
        expect(looksEnglish("Это русское предложение, и оно длинное.")).toBe(false);
        expect(looksEnglish("The word 日本 is Japanese and it is short.")).toBe(false);
    });

    it("rejects Latin-script prose in other languages", () => {
        expect(looksEnglish("Le tribunal a jugé que le contrat était nul faute de cause suffisante.")).toBe(false);
        expect(looksEnglish("Das Gericht entschied, dass der Vertrag mangels Gegenleistung nichtig sei.")).toBe(false);
        expect(looksEnglish("El tribunal resolvió que el contrato era nulo por falta de causa.")).toBe(false);
        expect(looksEnglish("Café ouvert")).toBe(false);
        expect(looksEnglish("é")).toBe(false);
    });
});
