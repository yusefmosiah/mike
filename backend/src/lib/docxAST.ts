/**
 * In-Memory OpenXML Document AST & Block Tools (Phase 1 / Station 1)
 *
 * Implements a preservation-first in-memory document tree over Office Open XML
 * packages (.docx). Unlike flat-string regex substitution, this operates on
 * structural blocks (paragraphs, tables) with stable IDs while preserving 100% of
 * untouched OPC package parts, styling, and drawing objects.
 *
 * Layering: shared kernel (backend/src/lib/); zero imports from modules/.
 */

import crypto from "node:crypto";
import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface ParagraphBlock {
  type: "paragraph";
  id: string; // e.g. "p_1", "p_2"
  text: string;
  style?: string;
  headingLevel?: number;
  isEmpty: boolean;
  isHeading: boolean;
  hasSectionBreak: boolean;
  hasDrawing: boolean;
  paraId?: string;
}

export interface TableBlock {
  type: "table";
  id: string; // e.g. "tbl_1", "tbl_2"
  rowCount: number;
  colCount: number;
  headers: string[];
  rows: string[][];
  text: string;
}

export type DocBlock = ParagraphBlock | TableBlock;

export interface ReadBlocksOptions {
  startId?: string;
  endId?: string;
  limit?: number;
  includeEmpty?: boolean;
}

export interface BlockOperationDeleteRange {
  op: "delete_blocks";
  startId: string;
  endId: string;
  reason?: string;
}

export interface BlockOperationDeleteEmpty {
  op: "delete_empty_blocks";
  scope?: "all" | "trailing";
  reason?: string;
}

export interface BlockOperationInsert {
  op: "insert_block";
  afterId: string | null; // null = insert at beginning of document
  content: string; // multiline text creates distinct paragraphs
  style?: string;
  reason?: string;
}

export interface BlockOperationReplace {
  op: "replace_block";
  blockId: string;
  newContent: string;
  expectedContent?: string; // Precondition: fails closed if mismatch
  reason?: string;
}

export type BlockOperation =
  | BlockOperationDeleteRange
  | BlockOperationDeleteEmpty
  | BlockOperationInsert
  | BlockOperationReplace;

export interface AppliedBlockChange {
  id: string;
  delId?: string;
  insId?: string;
  deletedText: string;
  insertedText: string;
  blockId?: string;
  reason?: string;
}

export interface BatchMutationResult {
  bytes: Buffer;
  changes: AppliedBlockChange[];
  appliedOpsCount: number;
  blocksAfter: DocBlock[];
}

// ---------------------------------------------------------------------------
// XML Tree & Zip Helpers
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

function setChildren(n: XNode, children: XNode[]): void {
  const name = elName(n);
  if (!name) return;
  n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
  if (!n || typeof n !== "object") return {};
  const a = (n as XNode)[ATTR_KEY];
  return (a as Record<string, string>) ?? {};
}

function makeEl(
  name: string,
  children: XNode[] = [],
  attrs?: Record<string, string>,
): XNode {
  const el: XNode = { [name]: children };
  if (attrs) {
    const attrObj: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      attrObj[`@_${k}`] = v;
    }
    el[ATTR_KEY] = attrObj;
  }
  return el;
}

function makeText(s: string): XNode {
  return { [TEXT_KEY]: s };
}

function cloneNode<T>(n: T): T {
  return JSON.parse(JSON.stringify(n)) as T;
}

function getZipEntry(zip: JSZip, pathSlash: string) {
  const direct = zip.file(pathSlash);
  if (direct) return direct;
  return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
  zip: JSZip,
  pathSlash: string,
  content: string | Buffer,
): void {
  const backslash = pathSlash.replace(/\//g, "\\");
  if (!zip.file(pathSlash) && zip.file(backslash)) {
    zip.file(backslash, content);
    return;
  }
  zip.file(pathSlash, content);
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

function createBuilder() {
  return new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    suppressEmptyNode: false,
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

function replaceBody(doc: XNode[], bodyChildren: XNode[]): void {
  for (const top of doc) {
    if (elName(top) !== "w:document") continue;
    const docKids = elChildren(top);
    for (const c of docKids) {
      if (elName(c) === "w:body") setChildren(c, bodyChildren);
    }
  }
}

function maxTrackedId(doc: XNode[]): number {
  let max = 0;
  const visit = (n: unknown) => {
    const name = elName(n);
    if (!name) return;
    if (name === "w:ins" || name === "w:del") {
      const a = elAttrs(n);
      const raw = a["@_w:id"];
      if (raw != null) {
        const v = parseInt(String(raw), 10);
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    for (const c of elChildren(n as XNode)) visit(c);
  };
  for (const top of doc) visit(top);
  return max;
}

// ---------------------------------------------------------------------------
// Text & Structure Extractors
// ---------------------------------------------------------------------------

function extractParagraphText(pNode: XNode): {
  text: string;
  hasSectionBreak: boolean;
  hasDrawing: boolean;
  style?: string;
  headingLevel?: number;
  paraId?: string;
} {
  const parts: string[] = [];
  let hasSectionBreak = false;
  let hasDrawing = false;
  let style: string | undefined;
  let headingLevel: number | undefined;

  const attrs = elAttrs(pNode);
  const paraId = attrs["@_w14:paraId"] || attrs["@_w:paraId"];

  const visit = (n: unknown) => {
    const name = elName(n);
    if (!name) return;

    if (name === "w:sectPr") {
      hasSectionBreak = true;
    } else if (name === "w:drawing" || name === "w:pict") {
      hasDrawing = true;
    } else if (name === "w:pStyle") {
      const val = elAttrs(n)["@_w:val"];
      if (val) {
        style = val;
        const hlMatch = val.match(/^Heading\s*([1-9])$/i);
        if (hlMatch) {
          headingLevel = parseInt(hlMatch[1], 10);
        }
      }
    } else if (name === "w:t") {
      for (const c of elChildren(n as XNode)) {
        if (isTextNode(c)) parts.push(String(c[TEXT_KEY] ?? ""));
      }
    } else if (name === "w:tab") {
      parts.push("\t");
    } else if (name === "w:br") {
      parts.push("\n");
    }

    // Do not extract text from deleted runs
    if (name === "w:del") {
      return;
    }

    for (const c of elChildren(n as XNode)) visit(c);
  };

  visit(pNode);
  const text = parts.join("");
  return {
    text,
    hasSectionBreak,
    hasDrawing,
    style,
    headingLevel,
    paraId,
  };
}

function extractTableData(tblNode: XNode): {
  rowCount: number;
  colCount: number;
  headers: string[];
  rows: string[][];
  text: string;
} {
  const allRows: string[][] = [];
  const kids = elChildren(tblNode);

  for (const kid of kids) {
    if (elName(kid) === "w:tr") {
      const rowCells: string[] = [];
      for (const trChild of elChildren(kid)) {
        if (elName(trChild) === "w:tc") {
          const cellTextParts: string[] = [];
          for (const tcChild of elChildren(trChild)) {
            if (elName(tcChild) === "w:p") {
              const pInfo = extractParagraphText(tcChild);
              if (pInfo.text) cellTextParts.push(pInfo.text);
            }
          }
          rowCells.push(cellTextParts.join(" ").trim());
        }
      }
      if (rowCells.length > 0) {
        allRows.push(rowCells);
      }
    }
  }

  const rowCount = allRows.length;
  const colCount = allRows.reduce((max, r) => Math.max(max, r.length), 0);
  const headers = allRows.length > 0 ? allRows[0] : [];
  const dataRows = allRows.length > 1 ? allRows.slice(1) : [];

  const textLines = allRows.map((r) => r.join(" | "));
  const text = textLines.join("\n");

  return {
    rowCount,
    colCount,
    headers,
    rows: dataRows,
    text,
  };
}

// ---------------------------------------------------------------------------
// In-Memory Document AST Class
// ---------------------------------------------------------------------------

export class DocxASTDocument {
  private zip: JSZip;
  private tree: XNode[];
  private bodyChildren: XNode[];
  private originalBytes: Buffer;
  private currentNextTrackedId: number;

  private constructor(
    zip: JSZip,
    tree: XNode[],
    bodyChildren: XNode[],
    originalBytes: Buffer,
  ) {
    this.zip = zip;
    this.tree = tree;
    this.bodyChildren = bodyChildren;
    this.originalBytes = originalBytes;
    this.currentNextTrackedId = maxTrackedId(tree) + 1;
  }

  public static async load(bytes: Buffer): Promise<DocxASTDocument> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) {
      throw new Error("Invalid DOCX package: word/document.xml is missing");
    }
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) {
      throw new Error("Invalid DOCX package: w:body element missing");
    }
    return new DocxASTDocument(zip, tree, bodyChildren, bytes);
  }

  public getOriginalBytes(): Buffer {
    return this.originalBytes;
  }

  /**
   * Scans body elements and builds the indexed list of DocBlocks.
   * Maps 1-to-1 with top-level structural children of w:body.
   */
  public getBlocks(): DocBlock[] {
    const blocks: DocBlock[] = [];
    let pCount = 0;
    let tblCount = 0;

    for (const node of this.bodyChildren) {
      const name = elName(node);
      if (name === "w:p") {
        pCount++;
        const info = extractParagraphText(node);
        const isEmpty =
          info.text.trim().length === 0 &&
          !info.hasSectionBreak &&
          !info.hasDrawing;
        const isHeading =
          info.headingLevel !== undefined ||
          (info.style ? /heading|title/i.test(info.style) : false);

        blocks.push({
          type: "paragraph",
          id: `p_${pCount}`,
          text: info.text,
          style: info.style,
          headingLevel: info.headingLevel,
          isEmpty,
          isHeading,
          hasSectionBreak: info.hasSectionBreak,
          hasDrawing: info.hasDrawing,
          paraId: info.paraId,
        });
      } else if (name === "w:tbl") {
        tblCount++;
        const tblData = extractTableData(node);
        blocks.push({
          type: "table",
          id: `tbl_${tblCount}`,
          rowCount: tblData.rowCount,
          colCount: tblData.colCount,
          headers: tblData.headers,
          rows: tblData.rows,
          text: tblData.text,
        });
      }
    }

    return blocks;
  }

  /**
   * Reads bounded ranges of blocks by ID.
   */
  public readBlocks(options: ReadBlocksOptions = {}): DocBlock[] {
    const all = this.getBlocks();
    let startIdx = 0;
    let endIdx = all.length - 1;

    if (options.startId) {
      const found = all.findIndex((b) => b.id === options.startId);
      if (found !== -1) startIdx = found;
    }
    if (options.endId) {
      const found = all.findIndex((b) => b.id === options.endId);
      if (found !== -1) endIdx = found;
    }

    if (startIdx > endIdx) return [];

    let slice = all.slice(startIdx, endIdx + 1);
    if (!options.includeEmpty) {
      slice = slice.filter((b) => (b.type === "paragraph" ? !b.isEmpty : true));
    }
    if (options.limit && options.limit > 0) {
      slice = slice.slice(0, options.limit);
    }
    return slice;
  }

  /**
   * Performs an atomic batch mutation over the document tree.
   * If any precondition fails, no change is made and an error is thrown.
   */
  public async batchMutate(
    operations: BlockOperation[],
    opts?: { author?: string },
  ): Promise<BatchMutationResult> {
    if (operations.length === 0) {
      return {
        bytes: this.originalBytes,
        changes: [],
        appliedOpsCount: 0,
        blocksAfter: this.getBlocks(),
      };
    }

    const author = opts?.author ?? "Mike";
    const now = new Date().toISOString();

    // 1. Validation Pre-flight: verify block targets exist and expected content matches
    const currentBlocks = this.getBlocks();
    const blockMap = new Map<string, DocBlock>(currentBlocks.map((b) => [b.id, b]));

    for (const op of operations) {
      if (op.op === "replace_block") {
        const target = blockMap.get(op.blockId);
        if (!target) {
          throw new Error(`replace_block target block '${op.blockId}' not found`);
        }
        if (op.expectedContent !== undefined) {
          const normExpected = op.expectedContent.replace(/\s+/g, " ").trim();
          const normActual = target.text.replace(/\s+/g, " ").trim();
          if (normExpected && !normActual.includes(normExpected)) {
            throw new Error(
              `Precondition failed for block '${op.blockId}': expected content does not match document. ` +
                `Expected: "${op.expectedContent.slice(0, 60)}...", Actual: "${target.text.slice(0, 60)}..."`,
            );
          }
        }
      } else if (op.op === "delete_blocks") {
        if (!blockMap.has(op.startId)) {
          throw new Error(`delete_blocks startId '${op.startId}' not found`);
        }
        if (!blockMap.has(op.endId)) {
          throw new Error(`delete_blocks endId '${op.endId}' not found`);
        }
      } else if (op.op === "insert_block") {
        if (op.afterId !== null && !blockMap.has(op.afterId)) {
          throw new Error(`insert_block afterId '${op.afterId}' not found`);
        }
      }
    }

    // 2. Execution on cloned body
    const bodyCopy = cloneNode(this.bodyChildren);
    const changes: AppliedBlockChange[] = [];

    // Helper: Find node index in bodyChildren given block ID
    const findNodeIndexForBlock = (
      body: XNode[],
      blockId: string,
    ): number => {
      let pCount = 0;
      let tblCount = 0;
      for (let i = 0; i < body.length; i++) {
        const name = elName(body[i]);
        if (name === "w:p") {
          pCount++;
          if (`p_${pCount}` === blockId) return i;
        } else if (name === "w:tbl") {
          tblCount++;
          if (`tbl_${tblCount}` === blockId) return i;
        }
      }
      return -1;
    };

    for (const op of operations) {
      if (op.op === "replace_block") {
        const idx = findNodeIndexForBlock(bodyCopy, op.blockId);
        if (idx === -1) continue;

        const targetNode = bodyCopy[idx];
        const oldInfo = extractParagraphText(targetNode);
        const delId = String(this.currentNextTrackedId++);
        const insId = String(this.currentNextTrackedId++);

        // Wrap existing content in w:del and append w:ins with new text
        const pPr = this.getOrCreateParagraphPr(targetNode);
        const deletedRuns: XNode[] = [
          makeEl(
            "w:del",
            [
              makeEl("w:r", [
                makeEl(
                  "w:delText",
                  [makeText(oldInfo.text)],
                  { "xml:space": "preserve" },
                ),
              ]),
            ],
            { "w:id": delId, "w:author": author, "w:date": now },
          ),
        ];

        const insertedRuns: XNode[] = [
          makeEl(
            "w:ins",
            [
              makeEl("w:r", [
                makeEl(
                  "w:t",
                  [makeText(op.newContent)],
                  { "xml:space": "preserve" },
                ),
              ]),
            ],
            { "w:id": insId, "w:author": author, "w:date": now },
          ),
        ];

        // Retain pPr, replace body with deleted + inserted runs
        setChildren(targetNode, [pPr, ...deletedRuns, ...insertedRuns]);

        changes.push({
          id: crypto.randomUUID(),
          delId,
          insId,
          deletedText: oldInfo.text,
          insertedText: op.newContent,
          blockId: op.blockId,
          reason: op.reason,
        });
      } else if (op.op === "delete_blocks") {
        const startIdx = findNodeIndexForBlock(bodyCopy, op.startId);
        const endIdx = findNodeIndexForBlock(bodyCopy, op.endId);
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue;

        for (let i = startIdx; i <= endIdx; i++) {
          const node = bodyCopy[i];
          const name = elName(node);
          const delId = String(this.currentNextTrackedId++);

          if (name === "w:p") {
            const oldInfo = extractParagraphText(node);
            const pPr = this.getOrCreateParagraphPr(node);

            // Add paragraph mark deletion in pPr/rPr/del so Word shows paragraph deletion
            let rPr = elChildren(pPr).find((c) => elName(c) === "w:rPr");
            if (!rPr) {
              rPr = makeEl("w:rPr", []);
              elChildren(pPr).push(rPr);
            }
            elChildren(rPr).push(
              makeEl("w:del", [], {
                "w:id": delId,
                "w:author": author,
                "w:date": now,
              }),
            );

            // Wrap text in w:del run
            const delWrapper = makeEl(
              "w:del",
              [
                makeEl("w:r", [
                  makeEl(
                    "w:delText",
                    [makeText(oldInfo.text)],
                    { "xml:space": "preserve" },
                  ),
                ]),
              ],
              { "w:id": delId, "w:author": author, "w:date": now },
            );

            setChildren(node, [pPr, delWrapper]);

            changes.push({
              id: crypto.randomUUID(),
              delId,
              deletedText: oldInfo.text,
              insertedText: "",
              reason: op.reason,
            });
          }
        }
      } else if (op.op === "delete_empty_blocks") {
        const isTrailingOnly = op.scope === "trailing";

        // Find truly empty paragraphs (no text, no sectPr, no drawing)
        for (let i = bodyCopy.length - 1; i >= 0; i--) {
          const node = bodyCopy[i];
          if (elName(node) === "w:p") {
            const info = extractParagraphText(node);
            const isTrulyEmpty =
              info.text.trim().length === 0 &&
              !info.hasSectionBreak &&
              !info.hasDrawing;

            if (isTrulyEmpty) {
              bodyCopy.splice(i, 1);
              changes.push({
                id: crypto.randomUUID(),
                deletedText: "",
                insertedText: "",
                reason: op.reason ?? "clean empty paragraph",
              });
            } else if (isTrailingOnly) {
              // Stop once we hit the first non-empty block from the end
              break;
            }
          }
        }
      } else if (op.op === "insert_block") {
        let insertPos = 0;
        if (op.afterId !== null) {
          const idx = findNodeIndexForBlock(bodyCopy, op.afterId);
          insertPos = idx !== -1 ? idx + 1 : bodyCopy.length;
        }

        // Multiline support: split on double newlines to produce separate paragraphs
        const paragraphs = op.content.split(/\n\n+/).filter((s) => s.trim().length > 0);
        const newNodes: XNode[] = [];

        for (const pText of (paragraphs.length > 0 ? paragraphs : [op.content])) {
          const insId = String(this.currentNextTrackedId++);
          const pPrChildren: XNode[] = [];
          if (op.style) {
            pPrChildren.push(
              makeEl("w:pStyle", [], { "w:val": op.style }),
            );
          }
          const pPr = makeEl("w:pPr", pPrChildren);

          const insNode = makeEl(
            "w:ins",
            [
              makeEl("w:r", [
                makeEl(
                  "w:t",
                  [makeText(pText)],
                  { "xml:space": "preserve" },
                ),
              ]),
            ],
            { "w:id": insId, "w:author": author, "w:date": now },
          );

          const pNode = makeEl("w:p", [pPr, insNode]);
          newNodes.push(pNode);

          changes.push({
            id: crypto.randomUUID(),
            insId,
            deletedText: "",
            insertedText: pText,
            reason: op.reason,
          });
        }

        bodyCopy.splice(insertPos, 0, ...newNodes);
      }
    }

    // 3. Serialize back into a fresh Buffer
    this.bodyChildren = bodyCopy;
    replaceBody(this.tree, this.bodyChildren);

    const builder = createBuilder();
    const updatedXml = builder.build(this.tree);
    setZipEntry(this.zip, "word/document.xml", updatedXml);

    const bytes = await this.toBuffer();

    return {
      bytes,
      changes,
      appliedOpsCount: operations.length,
      blocksAfter: this.getBlocks(),
    };
  }

  public async toBuffer(): Promise<Buffer> {
    return this.zip.generateAsync({ type: "nodebuffer" });
  }

  private getOrCreateParagraphPr(pNode: XNode): XNode {
    const kids = elChildren(pNode);
    let pPr = kids.find((c) => elName(c) === "w:pPr");
    if (!pPr) {
      pPr = makeEl("w:pPr", []);
      kids.unshift(pPr);
    }
    return pPr;
  }
}
