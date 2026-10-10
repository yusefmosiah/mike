// Judging whether a source supports what a document cites it for
// (goals/mission-6-citation-verification-subagents.md).
//
// A separate model call, with none of the drafting conversation, reads the
// document's claim and the source's most relevant passages and says whether
// the source supports, partly supports, does not support or contradicts it.
// The judge must quote the source for "supports" and "contradicts": an
// excerpt that is not actually in the source turns the judgement into
// "unclear", so a judge cannot invent its own evidence.
import { verifyQuoteAgainstSource } from "../chat/chat.service";
import { parseJsonObject, type Complete, type ExtractedCitation } from "./citations.extract";
import type { Verdict } from "./citations.verifier";

export type Support = "supports" | "partial" | "does-not-support" | "contradicts" | "unclear";

export type Judgement = {
    /** Whether the source is the cited authority at all (search candidates may not be). */
    identified: boolean;
    support: Support;
    reason: string;
    /** A verbatim excerpt of the source, checked to be in it. */
    evidence: string | null;
};

const SUPPORTS: readonly Support[] = ["supports", "partial", "does-not-support", "contradicts", "unclear"];
const PASSAGE_CHARS = 1_500;
const PASSAGE_BUDGET = 14_000;
const STOP = new Set(
    "the a an and or of to in on for by with that this is are was were be as at from it its which not no any".split(" "),
);

function terms(value: string): string[] {
    return value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOP.has(word));
}

/**
 * The parts of a long source most likely to bear on the claim: fixed windows
 * scored by how many of the claim's words they contain, best first within a
 * budget, then put back in source order. A short source is passed whole.
 */
export function relevantPassages(source: string, about: string, budget = PASSAGE_BUDGET): string {
    if (source.length <= budget) return source;
    const wanted = new Set(terms(about));
    const passages: Array<{ start: number; text: string; score: number }> = [];
    for (let start = 0; start < source.length; start += PASSAGE_CHARS / 2) {
        const slice = source.slice(start, start + PASSAGE_CHARS);
        const words = terms(slice);
        const hits = new Set(words.filter((word) => wanted.has(word))).size;
        passages.push({ start, text: slice, score: hits });
    }
    passages.sort((a, b) => b.score - a.score || a.start - b.start);
    const chosen: typeof passages = [];
    let size = 0;
    for (const passage of passages) {
        if (size + passage.text.length > budget) break;
        if (chosen.some((other) => Math.abs(other.start - passage.start) < PASSAGE_CHARS)) continue;
        chosen.push(passage);
        size += passage.text.length;
    }
    return chosen
        .sort((a, b) => a.start - b.start)
        .map((passage) => passage.text)
        .join("\n[...]\n");
}

const JUDGE_SYSTEM = `You check whether a legal document cites its sources honestly. You are given one citation from the document, the sentence or paragraph that uses it, what the document says it establishes, and text retrieved from a candidate source.

Decide:
- "identified": true if the retrieved text is the cited authority (the same case, provision, article or page), false if it is something else.
- "support": "supports" (the source establishes the document's proposition), "partial" (supports part of it, or with qualifications the document omits), "does-not-support" (the source does not say this), "contradicts" (the source says the opposite, or the holding goes the other way), or "unclear" (the retrieved text is not enough to tell).
- "reason": one or two sentences a lawyer can act on.
- "evidence": an exact excerpt copied from the retrieved source text that shows your answer (required for "supports", "partial" and "contradicts"), or null.

Judge the substance, not wording: a paraphrase that reflects what the source holds supports it; a quote that is accurate but used for a point the source rejects contradicts it.

Return ONLY JSON: {"identified": boolean, "support": string, "reason": string, "evidence": string|null}.`;

export async function judgeSupport(
    complete: Complete,
    args: { citation: ExtractedCitation; source: string; sourceLabel: string },
): Promise<Judgement> {
    const { citation } = args;
    const passages = relevantPassages(args.source, `${citation.proposition} ${citation.quote ?? ""}`);
    const user = [
        `Citation: ${citation.citation}`,
        `Paragraph that uses it: ${citation.context}`,
        `What the document says it establishes: ${citation.proposition}`,
        citation.quote ? `Words the document quotes from it: "${citation.quote}"` : "The document quotes nothing from it.",
        "",
        `Retrieved source (${args.sourceLabel}):`,
        passages,
    ].join("\n");
    const parsed = parseJsonObject(await complete({ systemPrompt: JUDGE_SYSTEM, user, maxTokens: 1024 }));
    if (!parsed) return { identified: false, support: "unclear", reason: "The checker gave no usable answer.", evidence: null };

    let support: Support = SUPPORTS.includes(parsed.support as Support) ? (parsed.support as Support) : "unclear";
    let reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.";
    let evidence = typeof parsed.evidence === "string" && parsed.evidence.trim() ? parsed.evidence.trim() : null;
    if (evidence && !verifyQuoteAgainstSource(args.source, evidence).verified) evidence = null;
    if (!evidence && (support === "supports" || support === "partial" || support === "contradicts")) {
        reason = `${reason} (Not confirmed: the checker's excerpt is not in the source.)`;
        support = "unclear";
    }
    return { identified: parsed.identified !== false, support, reason, evidence };
}

/**
 * One verdict from what was found. Most serious first: a missing source, a
 * source that says the opposite, a quote the source does not contain, a
 * source that does not say it; otherwise verified, or unverifiable.
 */
export function verdictFor(args: { quoteFound: boolean | null; judgement: Judgement }): Verdict {
    const { judgement } = args;
    if (judgement.support === "contradicts") return "contradicted";
    if (args.quoteFound === false) return "quote-mismatch";
    if (judgement.support === "does-not-support") return "unsupported";
    if (judgement.support === "supports" || judgement.support === "partial") return "exists-and-matches";
    return "unverifiable";
}
