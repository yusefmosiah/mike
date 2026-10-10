// Citation grading (goals/mission-6-citation-verification-subagents.md).
//
// Pure: given one quoted passage and the source it cites, decide the verdict.
// Reading the source (a document version, a web page) happens elsewhere
// (citations.sources.ts) and arrives here as a snapshot, the same text that is
// stored, so grading a stored snapshot again later reproduces the verdict.
import { createHash } from "node:crypto";
import { verifyQuoteAgainstSource } from "../chat/chat.service";

export type Verdict =
    | "exists-and-matches"
    | "not-found"
    | "quote-mismatch"
    | "unverifiable";

export type SourceKind = "document" | "web" | "case" | "connector";

/** One quoted passage of one citation on an assistant message. */
export type CitationQuote = {
    citationRef: number;
    quoteIndex: number;
    sourceKind: SourceKind;
    quote: string;
    documentId: string | null;
    versionId: string | null;
    url: string | null;
    clusterId: number | null;
};

export type BlockOffset = { id: string; start: number; end: number };

/** The source text a verdict is graded against, as it is stored. */
export type SnapshotInput = {
    sourceKind: "document" | "web" | "connector";
    documentId?: string | null;
    versionId?: string | null;
    url?: string | null;
    content: string;
    blockOffsets?: BlockOffset[] | null;
};

/** A source that could be read, or why it could not. */
export type ResolvedSource =
    | { ok: true; snapshot: SnapshotInput }
    | { ok: false; verdict: "not-found" | "unverifiable"; reason: string };

export type Grade = {
    verdict: Verdict;
    reason: string | null;
    blockId: string | null;
    startChar: number | null;
    endChar: number | null;
    excerpt: string | null;
};

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Every quoted passage on a message's stored citations, in order. A citation
 * without quotes has nothing to grade and yields nothing.
 */
export function citationQuotes(citations: unknown): CitationQuote[] {
    if (!Array.isArray(citations)) return [];
    const out: CitationQuote[] = [];
    citations.forEach((value, position) => {
        const citation = record(value);
        if (!citation) return;
        const ref =
            typeof citation.ref === "number" && Number.isFinite(citation.ref)
                ? Math.floor(citation.ref)
                : position + 1;
        const document = record(citation.document);
        const kind: SourceKind =
            citation.kind === "case"
                ? "case"
                : citation.kind === "web" || text(citation.url)
                  ? "web"
                  : "document";
        const quotes = Array.isArray(citation.quotes)
            ? citation.quotes.map((entry) => text(record(entry)?.quote))
            : [text(citation.quote)];
        quotes.forEach((quote, quoteIndex) => {
            if (!quote) return;
            out.push({
                citationRef: ref,
                quoteIndex,
                sourceKind: kind,
                quote,
                documentId: text(document?.document_id),
                versionId: text(document?.version_id),
                url: text(citation.url),
                clusterId:
                    typeof citation.cluster_id === "number"
                        ? Math.floor(citation.cluster_id)
                        : null,
            });
        });
    });
    return out;
}

/** The block a character offset falls in, when the snapshot has blocks. */
export function blockAt(
    offsets: readonly BlockOffset[] | null | undefined,
    position: number,
): string | null {
    if (!offsets) return null;
    for (const block of offsets) {
        if (position >= block.start && position < block.end) return block.id;
    }
    return null;
}

/**
 * Grade one passage against its source. A source that could not be read keeps
 * its own verdict; a readable source either contains the passage (allowing
 * the whitespace, case and punctuation drift extraction introduces, and `...`
 * omissions) or does not, which is a quote mismatch, not "not found".
 */
export function gradeQuote(quote: string, source: ResolvedSource): Grade {
    if (!source.ok) {
        return {
            verdict: source.verdict,
            reason: source.reason,
            blockId: null,
            startChar: null,
            endChar: null,
            excerpt: null,
        };
    }
    const { content, blockOffsets } = source.snapshot;
    const result = verifyQuoteAgainstSource(content, quote);
    if (!result.verified) {
        return {
            verdict: "quote-mismatch",
            reason: "The source does not contain this passage.",
            blockId: null,
            startChar: null,
            endChar: null,
            excerpt: null,
        };
    }
    const start = typeof result.start_char === "number" ? result.start_char : null;
    const located =
        start ?? (result.source_excerpt ? content.indexOf(result.source_excerpt.split(" ... ")[0]) : -1);
    return {
        verdict: "exists-and-matches",
        reason: result.needs_correction
            ? "Matches the source apart from spacing, case or punctuation."
            : null,
        blockId: located !== null && located >= 0 ? blockAt(blockOffsets, located) : null,
        startChar: start,
        endChar: typeof result.end_char === "number" ? result.end_char : null,
        excerpt: result.source_excerpt ?? null,
    };
}
