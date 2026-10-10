// Finding the citations in a document (goals/mission-6-citation-verification-subagents.md).
//
// A model reads the document and lists each authority it relies on, where it
// sits (a paragraph marker that maps back to a stable block id), any words it
// presents as quoted from the source, and what the document uses it to
// establish. Long documents are read in windows, in parallel.
import type { BlockOffset } from "./citations.verifier";

export type CitationKind = "case" | "legislation" | "web" | "secondary" | "other";

export type ExtractedCitation = {
    /** Position in the document's citation list; the check row's citation_ref. */
    index: number;
    /** The citing paragraph's stable block id, when the document has them. */
    blockId: string | null;
    /** The citing paragraph's text, so the judge reads the usage in context. */
    context: string;
    citation: string;
    kind: CitationKind;
    url: string | null;
    quote: string | null;
    proposition: string;
};

export type Complete = (args: { systemPrompt: string; user: string; maxTokens?: number }) => Promise<string>;

const WINDOW_CHARS = 24_000;
const KINDS: readonly CitationKind[] = ["case", "legislation", "web", "secondary", "other"];

const EXTRACT_SYSTEM = `You find the citations in a legal document so each can be checked against its source.

List every reference to an external authority the document relies on: cases, legislation and regulations, court rules, treaties, articles, books, reports, guidance and web pages. Do not list cross-references to the document's own clauses, schedules or defined terms, and do not list parties or people.

For each citation return:
- "para": the number in the [¶N] marker of the paragraph where it appears
- "citation": the citation exactly as written (case name and reporter, section and act, title and author, or URL)
- "kind": one of "case", "legislation", "web", "secondary", "other"
- "url": a URL written in the document for it, or null
- "quote": the exact words the document presents as quoted from the source, or null if it quotes nothing
- "proposition": one sentence stating what the document uses the authority to establish, faithful to the document's own claim

Return ONLY JSON: {"citations": [...]}. Return {"citations": []} when there are none.`;

/** Parse a model's JSON answer, tolerating a code fence or surrounding prose. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const value = JSON.parse(text.slice(start, end + 1)) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
}

type Paragraph = { text: string; blockId: string | null };

/** The document as paragraphs, each with its block id when it has one. */
export function paragraphs(content: string, blocks: readonly BlockOffset[] | null): Paragraph[] {
    if (blocks?.length) {
        return blocks.map((block) => ({ text: content.slice(block.start, block.end), blockId: block.id }));
    }
    return content
        .split(/\n+/)
        .map((text) => ({ text, blockId: null }))
        .filter((p) => p.text.trim());
}

/** Consecutive paragraph ranges of at most `maxChars` (a longer paragraph stands alone). */
export function windows(paras: readonly Paragraph[], maxChars = WINDOW_CHARS): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = [];
    let from = 0;
    let size = 0;
    paras.forEach((para, index) => {
        const length = para.text.length + 8;
        if (index > from && size + length > maxChars) {
            out.push({ from, to: index });
            from = index;
            size = 0;
        }
        size += length;
    });
    if (from < paras.length) out.push({ from, to: paras.length });
    return out;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Every citation in the document, in reading order, deduplicated. */
export async function extractCitations(
    doc: { content: string; blocks: readonly BlockOffset[] | null },
    complete: Complete,
    opts: { concurrency?: number; maxChars?: number } = {},
): Promise<ExtractedCitation[]> {
    const paras = paragraphs(doc.content, doc.blocks);
    const ranges = windows(paras, opts.maxChars);
    const found = await mapPool(ranges, opts.concurrency ?? 4, async ({ from, to }) => {
        const body = paras
            .slice(from, to)
            .map((para, offset) => `[¶${from + offset + 1}] ${para.text}`)
            .join("\n");
        const raw = await complete({ systemPrompt: EXTRACT_SYSTEM, user: body, maxTokens: 8192 });
        const list = parseJsonObject(raw)?.citations;
        if (!Array.isArray(list)) throw new Error("citation extraction returned no list");
        return list.flatMap((entry) => {
            const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            const citation = text(item.citation);
            const proposition = text(item.proposition);
            const para = Number(item.para);
            if (!citation || !proposition || !Number.isInteger(para) || para < from + 1 || para > to) return [];
            const kind = KINDS.includes(item.kind as CitationKind) ? (item.kind as CitationKind) : "other";
            const url = text(item.url);
            return [
                {
                    para: para - 1,
                    citation,
                    kind: url && kind === "other" ? ("web" as const) : kind,
                    url: url && /^https?:\/\//i.test(url) ? url : null,
                    quote: text(item.quote),
                    proposition,
                },
            ];
        });
    });

    const seen = new Set<string>();
    const out: ExtractedCitation[] = [];
    for (const item of found.flat().sort((a, b) => a.para - b.para)) {
        const key = `${item.para}\u0000${item.citation.toLowerCase()}\u0000${item.quote ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            index: out.length,
            blockId: paras[item.para].blockId,
            context: paras[item.para].text,
            citation: item.citation,
            kind: item.kind,
            url: item.url,
            quote: item.quote,
            proposition: item.proposition,
        });
    }
    return out;
}
