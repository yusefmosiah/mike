// A .docx as a reader sees it, for checking quotes against it: one line per
// paragraph in document order, each prefixed by the list number Word displays
// ("23.7.1", "(b)"; bullets excepted), with each block's span in the text.
// The flat accepted-view extractor (lib/docxTrackedChanges) drops those
// numbers, so a model that quotes "23.7.1 any indirect ..." from its read of
// the document would otherwise be called a misquote.
import { idSlots } from "./blockIds";
import type { DocxDocument } from "./view";

export type BlockSpan = { id: string; start: number; end: number };

export function docxReadingText(view: DocxDocument): { content: string; blocks: BlockSpan[] } {
    const blocks: BlockSpan[] = [];
    let content = "";
    for (const block of idSlots(view)) {
        if (block.kind !== "paragraph") continue;
        if (content) content += "\n";
        const line = block.label && !block.isBullet ? `${block.label} ${block.text}` : block.text;
        blocks.push({ id: block.id, start: content.length, end: content.length + line.length });
        content += line;
    }
    return { content, blocks };
}
