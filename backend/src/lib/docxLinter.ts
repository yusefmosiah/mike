/**
 * OpenXML Document Invariant Linter (Phase 2 / Station 2)
 *
 * Pre-flight validation executed before activating document versions to guarantee:
 * 1. Package XML structure is well-formed.
 * 2. Footnote balance: all footnote references resolve to definitions (with standard
 *    OpenXML separators -1 and 0 exempted from orphan checks).
 * 3. Relationship integrity: all r:id references in document.xml resolve to targets
 *    in word/_rels/document.xml.rels.
 * 4. Revision and table structure in document.xml: text inside a tracked
 *    deletion is w:delText (and only there), tracked-change ids are unique,
 *    every table has a row and every cell ends with a paragraph.
 *
 * Layering: shared kernel (backend/src/lib/); zero imports from modules/.
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export interface LintIssue {
  severity: "error" | "warning";
  category: "package" | "footnote" | "relationship" | "structure";
  message: string;
  target?: string;
}

export interface LintResult {
  ok: boolean;
  issues: LintIssue[];
  errorCount: number;
  warningCount: number;
}

type XNode = Record<string, unknown>;

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

function elName(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  for (const k of Object.keys(n as XNode)) {
    if (k === ":@" || k === "#text") continue;
    return k;
  }
  return null;
}

function elChildren(n: unknown): XNode[] {
  const name = elName(n);
  if (!name) return [];
  const v = (n as XNode)[name];
  return Array.isArray(v) ? (v as XNode[]) : [];
}

function elAttrs(n: unknown): Record<string, string> {
  if (!n || typeof n !== "object") return {};
  const a = (n as XNode)[":@"];
  return (a as Record<string, string>) ?? {};
}

function getZipEntry(zip: JSZip, pathSlash: string) {
  const direct = zip.file(pathSlash);
  if (direct) return direct;
  return zip.file(pathSlash.replace(/\//g, "\\"));
}

/**
 * Validates a DOCX package against OpenXML integrity invariants.
 */
export async function lintDocx(bytes: Buffer): Promise<LintResult> {
  const issues: LintIssue[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    issues.push({
      severity: "error",
      category: "package",
      message: `Invalid zip archive: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: false, issues, errorCount: 1, warningCount: 0 };
  }

  // 1. Check document.xml
  const docXmlEntry = getZipEntry(zip, "word/document.xml");
  if (!docXmlEntry) {
    issues.push({
      severity: "error",
      category: "package",
      message: "word/document.xml is missing from the package",
    });
    return { ok: false, issues, errorCount: 1, warningCount: 0 };
  }

  const parser = createParser();
  let docTree: XNode[];
  try {
    const rawXml = await docXmlEntry.async("string");
    docTree = parser.parse(rawXml) as XNode[];
  } catch (err) {
    issues.push({
      severity: "error",
      category: "package",
      message: `Malformed word/document.xml: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { ok: false, issues, errorCount: 1, warningCount: 0 };
  }

  // Collect references from document.xml
  const footnoteRefs = new Set<string>();
  const relationshipRefs = new Set<string>();

  const scanDocRefs = (n: unknown) => {
    const name = elName(n);
    if (!name) return;

    if (name === "w:footnoteReference") {
      const id = elAttrs(n)["@_w:id"];
      if (id != null) footnoteRefs.add(String(id));
    } else if (name === "w:hyperlink") {
      const rId =
        elAttrs(n)["@_r:id"] ||
        elAttrs(n)["@_w:id"] ||
        elAttrs(n)["@_Id"];
      if (rId != null) relationshipRefs.add(String(rId));
    } else if (name === "a:blip") {
      const embedId = elAttrs(n)["@_r:embed"];
      if (embedId != null) relationshipRefs.add(String(embedId));
    }

    for (const c of elChildren(n as XNode)) scanDocRefs(c);
  };

  for (const top of docTree) scanDocRefs(top);

  // 4. Revision and table structure
  issues.push(...structureIssues(docTree));

  // 2. Validate Footnotes
  const fnEntry = getZipEntry(zip, "word/footnotes.xml");
  if (fnEntry) {
    try {
      const rawFnXml = await fnEntry.async("string");
      const fnTree = parser.parse(rawFnXml) as XNode[];
      const fnDefs = new Set<string>();

      const scanFnDefs = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:footnote") {
          const id = elAttrs(n)["@_w:id"];
          if (id != null) fnDefs.add(String(id));
        }
        for (const c of elChildren(n as XNode)) scanFnDefs(c);
      };

      for (const top of fnTree) scanFnDefs(top);

      // Verify every body reference has a definition
      for (const ref of footnoteRefs) {
        if (!fnDefs.has(ref)) {
          issues.push({
            severity: "error",
            category: "footnote",
            message: `Dangling footnote reference: footnote [${ref}] is cited in body text but missing definition in footnotes.xml`,
            target: ref,
          });
        }
      }

      // Check for orphan definitions (excluding standard Word separators: -1 and 0)
      for (const def of fnDefs) {
        if (def === "-1" || def === "0") {
          // Exempt: standard OpenXML separator and continuationSeparator
          continue;
        }
        if (!footnoteRefs.has(def)) {
          issues.push({
            severity: "warning",
            category: "footnote",
            message: `Unreferenced footnote definition: footnote [${def}] defined in footnotes.xml but never cited in body text`,
            target: def,
          });
        }
      }
    } catch (err) {
      issues.push({
        severity: "error",
        category: "footnote",
        message: `Malformed word/footnotes.xml: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (footnoteRefs.size > 0) {
    issues.push({
      severity: "error",
      category: "footnote",
      message: `Document cites ${footnoteRefs.size} footnote(s) in body text, but word/footnotes.xml is missing entirely`,
    });
  }

  // 3. Validate Relationships
  const relsEntry = getZipEntry(zip, "word/_rels/document.xml.rels");
  if (relsEntry) {
    try {
      const rawRels = await relsEntry.async("string");
      const relsTree = parser.parse(rawRels) as XNode[];
      const definedRels = new Set<string>();

      const scanRels = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "Relationship") {
          const id = elAttrs(n)["@_Id"];
          if (id != null) definedRels.add(String(id));
        }
        for (const c of elChildren(n as XNode)) scanRels(c);
      };

      for (const top of relsTree) scanRels(top);

      for (const ref of relationshipRefs) {
        if (!definedRels.has(ref)) {
          issues.push({
            severity: "error",
            category: "relationship",
            message: `Dangling relationship reference: '${ref}' cited in document.xml but missing from word/_rels/document.xml.rels`,
            target: ref,
          });
        }
      }
    } catch (err) {
      issues.push({
        severity: "error",
        category: "relationship",
        message: `Malformed word/_rels/document.xml.rels: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (relationshipRefs.size > 0) {
    issues.push({
      severity: "error",
      category: "relationship",
      message: `Document references relationships, but word/_rels/document.xml.rels is missing`,
    });
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    ok: errorCount === 0,
    issues,
    errorCount,
    warningCount,
  };
}

const REVISION_WRAPPERS = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]);
const PROPERTY_CONTAINERS = new Set(["w:rPr", "w:pPr", "w:trPr", "w:numPr", "w:tcPr"]);

function structureIssues(tree: XNode[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const ids = new Map<string, number>();
  const visit = (n: unknown, parent: string | null, revision: string | null) => {
    const name = elName(n);
    if (!name) return;
    let inRevision = revision;
    if (REVISION_WRAPPERS.has(name)) {
      const id = elAttrs(n)["@_w:id"];
      if (id != null) ids.set(String(id), (ids.get(String(id)) ?? 0) + 1);
      if (!parent || !PROPERTY_CONTAINERS.has(parent)) inRevision = name;
    }
    // Word writes moved-from text as w:t; only a deletion needs w:delText.
    if (name === "w:t" && revision === "w:del") {
      issues.push({ severity: "error", category: "structure", message: "Text inside a tracked deletion is w:t instead of w:delText" });
    }
    if (name === "w:delText" && revision !== "w:del" && revision !== "w:moveFrom") {
      issues.push({ severity: "error", category: "structure", message: "w:delText outside a tracked deletion" });
    }
    const kids = elChildren(n as XNode);
    if (name === "w:tbl" && !kids.some((k) => elName(k) === "w:tr" || elName(k) === "w:sdt" || elName(k) === "w:customXml")) {
      issues.push({ severity: "error", category: "structure", message: "Table without rows" });
    }
    if (name === "w:tc") {
      const elements = kids.filter((k) => elName(k) !== null);
      const last = elName(elements[elements.length - 1]);
      if (last !== "w:p" && last !== "w:sdt" && last !== "w:customXml") {
        issues.push({ severity: "error", category: "structure", message: "Table cell does not end with a paragraph" });
      }
    }
    for (const c of kids) visit(c, name, inRevision);
  };
  for (const top of tree) visit(top, null, null);
  for (const [id, count] of ids) {
    if (count > 1) {
      issues.push({ severity: "error", category: "structure", message: `Tracked-change id ${id} is used ${count} times`, target: id });
    }
  }
  return issues;
}
