import type { LiveTranscript } from "./engines";

/** The words heard so far while dictating live: confirmed text, then the tail that may still change. */
export function liveTextOf({ confirmed, volatile }: LiveTranscript): string {
    return [confirmed.trim(), volatile.trim()].filter(Boolean).join(" ");
}

/**
 * The composer's text with `inserted` placed between what came before the
 * caret and what follows it, adding a space on a side only where the words
 * would otherwise run together (not before closing punctuation, and not when
 * the person's own text already has the space). Nothing is added for empty
 * `inserted`.
 */
export function spliceDictation(before: string, inserted: string, after: string): string {
    if (!inserted) return before + after;
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^[\s.,;:!?)\]}]/.test(after) ? " " : "";
    return before + lead + inserted + trail + after;
}
