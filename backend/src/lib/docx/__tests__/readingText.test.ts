import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocxDocument } from "../view";
import { docxReadingText } from "../readingText";
import { extractDocxBodyText } from "../../docxTrackedChanges";

const FIXTURE = path.join(__dirname, "../../../__tests__/fixtures/docx/public-legal/uk-msc-core-terms-v2.2a.docx");

describe("docxReadingText", () => {
    it("keeps the list numbers a reader sees, which the flat text drops, with each block's span", async () => {
        const bytes = fs.readFileSync(FIXTURE);
        const { content, blocks } = docxReadingText(await DocxDocument.load(bytes));
        const quoted = "23.7.1 any indirect, special or consequential Loss; and/or";
        expect(content).toContain(quoted);
        expect(await extractDocxBodyText(bytes)).not.toContain(quoted);

        const at = content.indexOf(quoted);
        const block = blocks.find((span) => at >= span.start && at < span.end)!;
        expect(content.slice(block.start, block.end)).toBe(quoted);
        // Spans are ordered, disjoint and cover each line exactly.
        for (let i = 1; i < blocks.length; i += 1) expect(blocks[i].start).toBe(blocks[i - 1].end + 1);
    });
});
