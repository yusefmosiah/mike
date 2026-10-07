// OPC package access for .docx files.
//
// Parts are read lazily and scanned once. Saving with no modified parts
// returns the original bytes; otherwise only the modified parts are written
// back and every other entry keeps its original content.

import JSZip from "jszip";
import { childElements, documentElement, encodeXmlAttr, scanXml, type XmlSource } from "./xmlSource";

export const MAIN_DOCUMENT_PART = "word/document.xml";

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Relationship types by their stable suffix. */
export const REL = {
  hyperlink: "/hyperlink",
  footnotes: "/footnotes",
  endnotes: "/endnotes",
  numbering: "/numbering",
  styles: "/styles",
  comments: "/comments",
} as const;

export class DocxPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxPackageError";
  }
}

export class DocxPackage {
  private readonly zip: JSZip;
  private readonly originalBytes: Buffer;
  private readonly texts = new Map<string, string>();
  private readonly scans = new Map<string, XmlSource>();
  private readonly modified = new Map<string, string>();
  private readonly encodings = new Map<string, PartEncoding>();
  private readonly entryNames: Map<string, string>;

  private constructor(zip: JSZip, bytes: Buffer, texts: Map<string, string>) {
    this.zip = zip;
    this.originalBytes = bytes;
    this.texts = texts;
    // Some Windows archives store backslash paths; map canonical -> stored.
    this.entryNames = new Map();
    for (const name of Object.keys(zip.files)) {
      if (!zip.files[name].dir) this.entryNames.set(name.replace(/\\/g, "/"), name);
    }
  }

  static async load(bytes: Buffer): Promise<DocxPackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new DocxPackageError("Not a valid .docx (zip) package");
    }
    const pkg = new DocxPackage(zip, bytes, new Map());
    if (!pkg.has(MAIN_DOCUMENT_PART)) {
      throw new DocxPackageError("Invalid .docx package: word/document.xml is missing");
    }
    // Read every XML part up front so later access is synchronous. Parts
    // are decoded by their BOM: document-management systems (iManage, for
    // one) write UTF-16 customXml parts into otherwise UTF-8 packages.
    for (const name of pkg.entryNames.keys()) {
      if (/\.(xml|rels)$/i.test(name)) {
        const raw = await zip.file(pkg.entryNames.get(name)!)!.async("uint8array");
        const { text, encoding } = decodePart(raw);
        pkg.texts.set(name, text);
        pkg.encodings.set(name, encoding);
      }
    }
    return pkg;
  }

  get bytes(): Buffer {
    return this.originalBytes;
  }

  partNames(): string[] {
    return [...this.entryNames.keys()];
  }

  has(path: string): boolean {
    return this.entryNames.has(path);
  }

  /** Current text of an XML part (modified text if it was replaced). */
  text(path: string): string | undefined {
    return this.modified.get(path) ?? this.texts.get(path);
  }

  /** Offset-annotated scan of an XML part, cached per text version. */
  xml(path: string): XmlSource | undefined {
    const text = this.text(path);
    if (text === undefined) return undefined;
    const cached = this.scans.get(path);
    if (cached && cached.source === text) return cached;
    const scanned = scanXml(text);
    this.scans.set(path, scanned);
    return scanned;
  }

  /** Replace a part's text. Used by editing (Mission 1b). */
  setText(path: string, text: string): void {
    if (!this.texts.has(path)) throw new DocxPackageError(`No XML part ${path}`);
    if (text === this.texts.get(path)) this.modified.delete(path);
    else this.modified.set(path, text);
  }

  /** Add a new XML part (and its content-type override). */
  addPart(path: string, text: string, contentType: string): void {
    if (this.has(path)) throw new DocxPackageError(`Part ${path} already exists`);
    this.entryNames.set(path, path);
    this.texts.set(path, "");
    this.encodings.set(path, "utf-8");
    this.modified.set(path, text);
    const types = this.text(CONTENT_TYPES_PART);
    if (types !== undefined && !types.includes(`PartName="/${path}"`)) {
      this.setText(
        CONTENT_TYPES_PART,
        types.replace(/<\/Types>\s*$/, `<Override PartName="/${encodeXmlAttr(path)}" ContentType="${encodeXmlAttr(contentType)}"/></Types>`),
      );
    }
  }

  /**
   * Add a relationship from a part and return its id. Creates the part's
   * .rels file if it has none.
   */
  addRelationship(fromPart: string, type: string, target: string, external: boolean): string {
    const relsPath = relsPathFor(fromPart);
    const existing = this.relationships(fromPart);
    let n = existing.size + 1;
    while (existing.has(`rId${n}`)) n++;
    const id = `rId${n}`;
    const rel = `<Relationship Id="${id}" Type="${encodeXmlAttr(type)}" Target="${encodeXmlAttr(target)}"${external ? ' TargetMode="External"' : ""}/>`;
    const text = this.text(relsPath);
    if (text === undefined) {
      this.addPart(
        relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`,
        "application/vnd.openxmlformats-package.relationships+xml",
      );
    } else {
      this.setText(relsPath, text.replace(/<\/Relationships>\s*$/, `${rel}</Relationships>`));
    }
    return id;
  }

  isModified(): boolean {
    return this.modified.size > 0;
  }

  async save(): Promise<Buffer> {
    if (!this.isModified()) return this.originalBytes;
    for (const [path, text] of this.modified) {
      // createFolders: false, or JSZip adds directory entries Word never wrote.
      this.zip.file(this.entryNames.get(path)!, encodePart(text, this.encodings.get(path) ?? "utf-8"), {
        createFolders: false,
      });
    }
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }

  /** Relationships of a part, e.g. word/document.xml -> word/_rels/document.xml.rels. */
  relationships(partPath: string): Map<string, Relationship> {
    const relsPath = relsPathFor(partPath);
    const out = new Map<string, Relationship>();
    const rels = this.xml(relsPath);
    if (!rels) return out;
    for (const rel of childElements(documentElement(rels), "Relationship")) {
      const id = rel.attrs.Id;
      if (!id) continue;
      out.set(id, {
        id,
        type: rel.attrs.Type ?? "",
        target: rel.attrs.Target ?? "",
        external: rel.attrs.TargetMode === "External",
      });
    }
    return out;
  }

  /** Resolve the part a relationship type points at, e.g. the footnotes part. */
  relatedPart(partPath: string, typeSuffix: string): string | undefined {
    for (const rel of this.relationships(partPath).values()) {
      if (rel.external || !rel.type.endsWith(typeSuffix)) continue;
      return resolvePartPath(partPath, rel.target);
    }
    return undefined;
  }
}

export const CONTENT_TYPES_PART = "[Content_Types].xml";

/** word/document.xml -> word/_rels/document.xml.rels */
export function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.slice(0, fromPart.lastIndexOf("/") + 1);
  const segments = (base + target).split("/");
  const out: string[] = [];
  for (const s of segments) {
    if (s === "..") out.pop();
    else if (s !== "." && s !== "") out.push(s);
  }
  return out.join("/");
}

export type PartEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";

export function decodePart(raw: Uint8Array): { text: string; encoding: PartEncoding } {
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(raw.subarray(2)), encoding: "utf-16le" };
  }
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(raw.subarray(2)), encoding: "utf-16be" };
  }
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(raw.subarray(3)), encoding: "utf-8-bom" };
  }
  return { text: new TextDecoder("utf-8").decode(raw), encoding: "utf-8" };
}

export function encodePart(text: string, encoding: PartEncoding): Buffer {
  switch (encoding) {
    case "utf-8":
      return Buffer.from(text, "utf8");
    case "utf-8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf-16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf-16be": {
      const le = Buffer.from(text, "utf16le");
      for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
      return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
    }
  }
}
