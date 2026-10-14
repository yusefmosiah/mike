/**
 * Writing-system detection for the report's language check: an answer in
 * Chinese or Russian to an English prompt is a harness bug (a compaction
 * summary in the wrong language leaks into the next turns), not a style
 * choice, and it shows up as a change of script long before anyone reads it.
 */

export type Script =
    | "latin"
    | "cjk"
    | "cyrillic"
    | "arabic"
    | "hebrew"
    | "greek"
    | "devanagari"
    | "thai"
    | "other";

const RANGES: [Script, RegExp][] = [
    ["latin", /\p{Script=Latin}/u],
    // Han, kana and Hangul together: the check is "is this CJK at all".
    ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
    ["cyrillic", /\p{Script=Cyrillic}/u],
    ["arabic", /\p{Script=Arabic}/u],
    ["hebrew", /\p{Script=Hebrew}/u],
    ["greek", /\p{Script=Greek}/u],
    ["devanagari", /\p{Script=Devanagari}/u],
    ["thai", /\p{Script=Thai}/u],
];

/**
 * Text with the parts that are not prose removed: fenced and inline code,
 * URLs, and markdown link targets. Code and links are written in Latin
 * whatever the answer's language, so they would mask a switch.
 */
export function proseOnly(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .replace(/\]\([^)]*\)/g, "] ")
        .replace(/\bhttps?:\/\/\S+/g, " ");
}

export type ScriptProfile = {
    letters: number;
    counts: Partial<Record<Script, number>>;
    dominant: Script | null;
};

export function scriptProfile(text: string): ScriptProfile {
    const counts: Partial<Record<Script, number>> = {};
    let letters = 0;
    for (const ch of proseOnly(text)) {
        if (!/\p{L}/u.test(ch)) continue;
        letters += 1;
        let script: Script = "other";
        for (const [name, pattern] of RANGES) {
            if (pattern.test(ch)) {
                script = name;
                break;
            }
        }
        counts[script] = (counts[script] ?? 0) + 1;
    }
    let dominant: Script | null = null;
    let best = 0;
    for (const [script, count] of Object.entries(counts) as [Script, number][]) {
        if (count > best) {
            best = count;
            dominant = script;
        }
    }
    return { letters, counts, dominant };
}

export type ScriptMismatch = {
    expected: Script;
    dominant: Script | null;
    /** Scripts absent from the prompt that make up a visible share of the answer. */
    foreign: { script: Script; letters: number; share: number }[];
};

/**
 * Compares an answer's scripts with its prompt's. Flags the answer when its
 * dominant script differs, or when a script the prompt does not use makes up
 * at least `minShare` of its letters and at least `minLetters` letters (a
 * stray "日本" quoted in an English answer is fine; a Chinese paragraph is
 * not). Returns null when there is nothing to flag or too little text.
 *
 * `expected` defaults to the prompt's dominant script, and to Latin for a
 * prompt with no letters (a bare link).
 */
export function scriptMismatch(
    prompt: string,
    answer: string,
    opts: { minShare?: number; minLetters?: number; expected?: Script } = {},
): ScriptMismatch | null {
    const minShare = opts.minShare ?? 0.05;
    const minLetters = opts.minLetters ?? 20;
    const promptProfile = scriptProfile(prompt);
    const expected = opts.expected ?? promptProfile.dominant ?? "latin";
    const answerProfile = scriptProfile(answer);
    if (answerProfile.letters === 0) return null;
    const allowed = new Set<Script>([expected]);
    for (const [script, count] of Object.entries(promptProfile.counts) as [Script, number][]) {
        if (count >= 3) allowed.add(script);
    }
    const foreign = (Object.entries(answerProfile.counts) as [Script, number][])
        .filter(([script, count]) =>
            !allowed.has(script) &&
            script !== "other" &&
            count >= minLetters &&
            count / answerProfile.letters >= minShare,
        )
        .map(([script, count]) => ({
            script,
            letters: count,
            share: Math.round((count / answerProfile.letters) * 1000) / 1000,
        }));
    const dominantSwitched =
        answerProfile.dominant !== null &&
        !allowed.has(answerProfile.dominant) &&
        answerProfile.letters >= minLetters;
    if (!dominantSwitched && foreign.length === 0) return null;
    return { expected, dominant: answerProfile.dominant, foreign };
}
