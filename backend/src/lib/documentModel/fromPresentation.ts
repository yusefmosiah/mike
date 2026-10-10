import JSZip from "jszip";
import type { DocBlock, DocumentModel } from "./types";

// A .pptx into the common model: per slide, its title as a level-1 heading
// (or "Slide N" when it has none), each other text frame's paragraphs as
// paragraphs or list items (by their indent level), tables as tables, and
// the speaker notes as note blocks. Ids are `s<slide>.<n>`; `page` is the
// slide number.

const decode = (text: string) =>
    text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&amp;/g, "&");

/** The text of each <a:p> in a fragment, with its indent level. */
function paragraphsOf(xml: string): { text: string; level: number; bullet: boolean }[] {
    const out: { text: string; level: number; bullet: boolean }[] = [];
    for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
        const body = match[1];
        const text = [...body.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)]
            .map((part) => (part[1] === undefined ? "\n" : decode(part[1])))
            .join("")
            .trim();
        if (!text) continue;
        const pPr = /<a:pPr\b([^>]*)>/.exec(body)?.[1] ?? /<a:pPr\b([^>]*)\/>/.exec(body)?.[1] ?? "";
        const level = Number(/\blvl="(\d)"/.exec(pPr)?.[1] ?? 0);
        const bullet = /<a:bu(Char|AutoNum)\b/.test(body);
        out.push({ text, level, bullet });
    }
    return out;
}

const slideNumber = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

export async function presentationToModel(buffer: Buffer): Promise<DocumentModel> {
    const zip = await JSZip.loadAsync(buffer);
    const slidePaths = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => slideNumber(a) - slideNumber(b));
    const blocks: DocBlock[] = [];
    for (const [index, path] of slidePaths.entries()) {
        const slide = index + 1;
        const xml = (await zip.file(path)?.async("text")) ?? "";
        let n = 0;
        const id = () => `s${slide}.${++n}`;
        const slideBlocks: DocBlock[] = [];
        let title: string | null = null;
        for (const shape of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)) {
            const frame = shape[0];
            if (frame.startsWith("<p:graphicFrame")) {
                const rows = [...frame.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((row) =>
                    [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((cell) =>
                        paragraphsOf(cell[0]).map((p) => p.text).join("\n"),
                    ),
                );
                if (rows.length) {
                    slideBlocks.push({ id: id(), page: slide, kind: "table", text: rows.map((row) => row.join(" | ")).join("\n"), rows });
                }
                continue;
            }
            const placeholder = /<p:ph\b[^>]*type="(\w+)"/.exec(frame)?.[1];
            const ps = paragraphsOf(frame);
            if (!ps.length) continue;
            if ((placeholder === "title" || placeholder === "ctrTitle") && title === null) {
                title = ps.map((p) => p.text).join(" ");
                continue;
            }
            for (const p of ps) {
                slideBlocks.push(
                    p.bullet || p.level > 0
                        ? { id: id(), page: slide, kind: "list_item", level: p.level + 1, text: p.text }
                        : { id: id(), page: slide, kind: "paragraph", text: p.text },
                );
            }
        }
        blocks.push({ id: `s${slide}.0`, page: slide, kind: "heading", level: 1, text: title ?? `Slide ${slide}`, ...(title ? {} : { inferred: true }) });
        blocks.push(...slideBlocks);
        // Speaker notes: the notes slide this slide's relationships name.
        const rels = (await zip.file(path.replace(/slides\/(slide\d+\.xml)$/i, "slides/_rels/$1.rels"))?.async("text")) ?? "";
        const notesTarget = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
        const notes = notesTarget ? ((await zip.file(`ppt/notesSlides/${notesTarget}`)?.async("text")) ?? "") : "";
        for (const shape of notes.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
            if (!/<p:ph\b[^>]*type="body"/.test(shape[0])) continue;
            const text = paragraphsOf(shape[0]).map((p) => p.text).join("\n");
            if (text) blocks.push({ id: id(), page: slide, kind: "note", text, source: "speaker notes" });
        }
    }
    return { format: "presentation", blocks, pages: slidePaths.length, warnings: [] };
}
