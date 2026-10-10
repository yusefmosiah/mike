// Court opinions and statutes are often served as PDFs; the checker must read
// their text, not their bytes, or no excerpt a judge quotes can be confirmed.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/search/egress", async (original) => ({
    ...(await original<typeof import("../../../lib/search/egress")>()),
    assertSafeEgressUrl: vi.fn(async (url: string) => new URL(url)),
}));

import { fetchWebPage } from "../citations.sources";

function textPdf(line: string): Buffer {
    const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.7\n";
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "binary");
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchWebPage", () => {
    it("reads a PDF's text", async () => {
        const body = textPdf("The person in custody must be warned of the right to remain silent.");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } })),
        );
        const page = await fetchWebPage("https://example.org/opinion.pdf");
        expect(page.status).toBe(200);
        expect(page.text).toContain("must be warned of the right to remain silent");
        expect(page.text).not.toContain("%PDF");
    });

    it("reduces HTML to its readable text", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<html><body><p>Notices may be served by email.</p></body></html>", { status: 200, headers: { "content-type": "text/html" } })),
        );
        const page = await fetchWebPage("https://example.org/guidance");
        expect(page.text).toContain("Notices may be served by email.");
        expect(page.text).not.toContain("<p>");
    });
});
