import { describe, expect, it } from "vitest";
import { LINK_WORDS } from "../linkWords";

// Whole words that must never appear in any language we draw from, and
// phishing bait. A sanity check, not a moderation system: new words are
// reviewed by hand (see the header of linkWords.ts).
const DENY = new Set(
    `login logon signin bank secure security account verify verified paypal admin password update
    support billing invoice wallet crypto token reset
    fuck shit cunt piss cock dick pussy slut whore bitch bastard damn crap fart porn sex nude
    rape nazi hitler kill murder bomb gun rifle pistol knife sword dagger weapon war
    weed pot dope coke crack heroin meth opium cocaine drug
    church mosque pope jesus allah god satan devil
    trump biden putin
    puta pene culo mierda polla verga cazzo figa merda caralho buceta kut lul hoer arsch scheisse fotze hure
    merde bite pute sik kuso baka unko vittu paska pillu kontol memek pau beer`.split(/\s+/),
);

// Substrings that no word may contain, in any language.
const DENY_INSIDE = ["fuck", "shit", "cunt", "nigg", "fagg", "nazi", "whore", "slut"];

describe("LINK_WORDS", () => {
    it("is big enough for 11 bits a word", () => {
        expect(LINK_WORDS.length).toBeGreaterThanOrEqual(2048);
    });

    it("is frozen, unique and plain lowercase", () => {
        expect(Object.isFrozen(LINK_WORDS)).toBe(true);
        expect(new Set(LINK_WORDS).size).toBe(LINK_WORDS.length);
        for (const word of LINK_WORDS) expect(word).toMatch(/^[a-z]{3,10}$/);
    });

    it("has no denied words", () => {
        for (const word of LINK_WORDS) {
            expect(DENY.has(word), word).toBe(false);
            for (const part of DENY_INSIDE) expect(word.includes(part), word).toBe(false);
        }
    });
});
