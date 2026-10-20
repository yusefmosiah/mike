/**
 * Whether a piece of text is English, for choosing a voice: Phonon speaks
 * English only, so anything else is read by Apple's voices. A cheap guess, not
 * a language detector: text with letters outside the Latin alphabet is not
 * English; Latin-script text is English when enough of its words are the
 * common English function words (French, German and Spanish prose has almost
 * none of them).
 */

const ENGLISH_WORDS = new Set(
    (
        "the of and to a in is that it for on with as are was be this by at or from an have not but they you we " +
        "his her their its which will would can has had been were what there when who if more all so about into"
    ).split(" "),
);

/** The share of the words that must be English function words. */
const MIN_SHARE = 0.12;
/** Fewer words than this are judged by their letters alone. */
const MIN_WORDS = 4;

export function looksEnglish(text: string): boolean {
    const letters = text.match(/\p{L}/gu) ?? [];
    if (letters.length === 0) return true;
    if (letters.some((letter) => !/[A-Za-z]/.test(letter) && !/[À-ɏ]/.test(letter))) return false;
    const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
    if (words.length < MIN_WORDS) return !/[À-ɏ]/.test(text);
    return words.filter((word) => ENGLISH_WORDS.has(word)).length / words.length >= MIN_SHARE;
}
