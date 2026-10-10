// The drafted memo the citation checker is tested against: one citation of
// each kind of failure and one that holds up, with scripted sources and a
// scripted model, so nothing leaves the machine.
import JSZip from "jszip";
import { vi } from "vitest";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export const MEMO_PARAGRAPHS = [
    "MEMORANDUM",
    "Under Smith v. Jones, 123 F.3d 456 (9th Cir. 1999), a landlord owes no duty to repair, so the claim fails.",
    "In Doe v. Roe, 999 U.S. 1 (2031), the Supreme Court held that oral leases are void.",
    'Section 4 of the Records Act 2020 provides that "records must be kept for seven years".',
    "The regulator's guidance at https://example.org/guidance confirms that notices may be served by email.",
    "The withdrawn note at https://example.org/withdrawn says the opposite.",
];

export const MEMO_VERDICTS = [
    ["Smith v. Jones, 123 F.3d 456 (9th Cir. 1999)", "contradicted"],
    ["Doe v. Roe, 999 U.S. 1 (2031)", "not-found"],
    ["Records Act 2020, s. 4", "quote-mismatch"],
    ["Regulator guidance", "exists-and-matches"],
    ["Withdrawn note", "not-found"],
];

export const SMITH_TEXT =
    "OPINION. The tenant sued for damages. We hold that the landlord owes a duty to repair the premises, and the judgment below is reversed.";
export const STATUTE_TEXT = "Records Act 2020. Section 4. Retention. Records must be kept for six years from the date of the transaction.";
export const GUIDANCE_TEXT = "Service of notices. Notices may be served by email or by post to the registered address.";

/** The scripted model: the extractor's list, then one judgement per citation. */
export function scriptedModel(log: { extract: number; inFlight: number; maxInFlight: number }) {
    return vi.fn(async (args: { systemPrompt: string; user: string }) => {
        log.inFlight += 1;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.inFlight -= 1;
        if (args.systemPrompt.startsWith("You find the citations")) {
            log.extract += 1;
            return JSON.stringify({
                citations: [
                    { para: 2, citation: "Smith v. Jones, 123 F.3d 456 (9th Cir. 1999)", kind: "case", url: null, quote: null, proposition: "A landlord owes no duty to repair." },
                    { para: 3, citation: "Doe v. Roe, 999 U.S. 1 (2031)", kind: "case", url: null, quote: null, proposition: "Oral leases are void." },
                    { para: 4, citation: "Records Act 2020, s. 4", kind: "legislation", url: null, quote: "records must be kept for seven years", proposition: "Records must be kept for seven years." },
                    { para: 5, citation: "Regulator guidance", kind: "web", url: "https://example.org/guidance", quote: null, proposition: "Notices may be served by email." },
                    { para: 6, citation: "Withdrawn note", kind: "web", url: "https://example.org/withdrawn", quote: null, proposition: "Notices may not be served by email." },
                    { para: 99, citation: "Out of range", kind: "case", url: null, quote: null, proposition: "Dropped." },
                ],
            });
        }
        if (args.user.includes("Smith v. Jones")) {
            return JSON.stringify({ identified: true, support: "contradicts", reason: "The court held the landlord does owe a duty to repair.", evidence: "the landlord owes a duty to repair the premises" });
        }
        if (args.user.includes("Records Act")) {
            return JSON.stringify({ identified: true, support: "does-not-support", reason: "Section 4 requires six years, not seven.", evidence: "Records must be kept for six years" });
        }
        if (args.user.includes("Regulator guidance")) {
            return JSON.stringify({ identified: true, support: "supports", reason: "The guidance allows service by email.", evidence: "Notices may be served by email" });
        }
        return JSON.stringify({ identified: false, support: "unclear", reason: "Not this source.", evidence: null });
    });
}

export const fetchWeb = vi.fn(async (url: string) =>
    url === "https://example.org/guidance"
        ? { status: 200, text: GUIDANCE_TEXT, finalUrl: url }
        : url === "https://example.org/records-act-2020"
          ? { status: 200, text: STATUTE_TEXT, finalUrl: url }
          : { status: 404, text: "", finalUrl: url },
);
export const searchWeb = vi.fn(async (query: string) =>
    query.includes("Records Act") ? [{ url: "https://example.org/records-act-2020", title: "Records Act 2020" }] : [],
);
export const lookupCase = vi.fn(async (citation: string) =>
    citation.startsWith("Smith")
        ? { status: "found" as const, url: "https://www.courtlistener.com/opinion/1/smith-v-jones/", caseName: "Smith v. Jones", text: SMITH_TEXT }
        : { status: "not-found" as const },
);

export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
    const zip = new JSZip();
    const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("");
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}
