// Quote matching and hashing for citation checks
// (goals/mission-6-citation-verification-subagents.md).
//
// Pure: given a quoted passage and the stored text of the source it cites,
// say whether the source contains it. Grading a stored snapshot again later
// reproduces the answer, which is what lets a third person re-check it.
import { createHash } from "node:crypto";
import { verifyQuoteAgainstSource } from "../chat/chat.service";

export type Verdict =
    | "exists-and-matches"
    | "not-found"
    | "quote-mismatch"
    | "unverifiable"
    | "unsupported"
    | "contradicted";

export type SourceKind = "document" | "web" | "case" | "connector";

export type BlockOffset = { id: string; start: number; end: number };

/** The source text a verdict is graded against, as it is stored. */
export type SnapshotInput = {
    sourceKind: "document" | "web" | "case" | "connector";
    documentId?: string | null;
    versionId?: string | null;
    url?: string | null;
    content: string;
    blockOffsets?: BlockOffset[] | null;
};

export type QuoteMatch = {
    found: boolean;
    startChar: number | null;
    endChar: number | null;
    /** The source's own words for the passage (corrects spacing and case drift). */
    excerpt: string | null;
};

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** The block a character offset falls in, when the snapshot has blocks. */
export function blockAt(offsets: readonly BlockOffset[] | null | undefined, position: number): string | null {
    if (!offsets) return null;
    for (const block of offsets) {
        if (position >= block.start && position < block.end) return block.id;
    }
    return null;
}

/** Words only: line-break hyphens joined, punctuation and spacing dropped. */
function words(text: string): string {
    return text
        .toLowerCase()
        .replace(/-\s*\n\s*/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/**
 * Whether an excerpt the checker offers as evidence is in the source: the
 * same words in the same order. Scanned court opinions carry OCR noise inside
 * real sentences ("he-does", "and'that", words split across lines), which a
 * stricter match rejects; changed or invented words still fail.
 */
export function evidenceInSource(content: string, excerpt: string): boolean {
    if (verifyQuoteAgainstSource(content, excerpt).verified) return true;
    const wanted = words(excerpt);
    return wanted.length >= 20 && ` ${words(content)} `.includes(` ${wanted} `);
}

/**
 * Whether the source contains the passage, allowing the whitespace, case and
 * punctuation drift extraction introduces, and `...` omissions.
 */
export function matchQuote(content: string, quote: string): QuoteMatch {
    const result = verifyQuoteAgainstSource(content, quote);
    if (!result.verified) return { found: false, startChar: null, endChar: null, excerpt: null };
    return {
        found: true,
        startChar: typeof result.start_char === "number" ? result.start_char : null,
        endChar: typeof result.end_char === "number" ? result.end_char : null,
        excerpt: result.source_excerpt ?? null,
    };
}
