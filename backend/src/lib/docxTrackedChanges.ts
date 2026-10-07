/**
 * Read-only .docx helpers kept from the original tracked-changes module.
 *
 * `extractDocxBodyText` returns the body text in accepted view (insertions
 * in, deletions out), one paragraph per line; `extractTrackedChangeIds`
 * lists w:ins / w:del ids in document order for the viewer. Editing and
 * accept/reject live in lib/docx/ (edit.ts, revisions.ts).
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// JSZip path helpers
// ---------------------------------------------------------------------------
//
// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

// ---------------------------------------------------------------------------
// Preserve-order tree helpers
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// ---------------------------------------------------------------------------
// Paragraph flattening
// ---------------------------------------------------------------------------

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Non-textual run children (w:tab, w:br, ...) are ignored for
     * the char stream but left in place via their surrounding w:r.
     */
    textNodes: { wtEl: XNode; text: string; paraStart: number; paraEnd: number }[];
}

interface Flattened {
    paraText: string;
    // For each char index in paraText: which run slot + which textNode + offset within text
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
    charOffset: Int32Array;   // offset within that textNode.text
    runs: RunSlot[];          // order corresponds to their paragraph position
}

function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";
    const charRunArr: number[] = [];
    const charTextNodeArr: number[] = [];
    const charOffsetArr: number[] = [];

    const processRun = (rEl: XNode, topChildIdx: number) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
            } else if (name === "w:t") {
                const txt = getTextContent(rk);
                const start = paraText.length;
                textNodes.push({
                    wtEl: rk,
                    text: txt,
                    paraStart: start,
                    paraEnd: start + txt.length,
                });
                const runIdx = runs.length;
                const tnIdx = textNodes.length - 1;
                paraText += txt;
                for (let i = 0; i < txt.length; i++) {
                    charRunArr.push(runIdx);
                    charTextNodeArr.push(tnIdx);
                    charOffsetArr.push(i);
                }
            }
            // other run children (w:tab, w:br, w:sym, …) are left alone
        }
        runs.push({ childIndex: topChildIdx, rPr, textNodes });
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        const child = paraChildren[ci];
        const name = elName(child);
        if (name === "w:r") {
            processRun(child, ci);
        } else if (name === "w:ins") {
            // Accepted view: include inner runs as if bare. childIndex points
            // at the w:ins wrapper so reconstruction can drop the wrapper
            // whole when a new edit touches any of these runs.
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") processRun(inner, ci);
            }
        }
        // w:del: skip entirely — accepted view excludes deleted text.
    }

    return {
        paraText,
        charRun: Int32Array.from(charRunArr),
        charTextNode: Int32Array.from(charTextNodeArr),
        charOffset: Int32Array.from(charOffsetArr),
        runs,
    };
}

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return "";
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return "";

    const lines: string[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const flat = flattenParagraph(elChildren(n));
                lines.push(flat.paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    return lines.join("\n");
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}
