import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { corpusFiles, readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { DocxPackage } from "../package";
import { type XmlElement, type XmlSource } from "../xmlSource";

// Whole-document oracle checks on real contracts (one 12,600-paragraph
// schedule among them) take up to ~8 s a test alone and timed out under the
// full parallel run's CPU contention at the 20 s default. Speed is guarded
// separately (blockIds.test.ts "aligns ... quickly"); here only correctness is.
vi.setConfig({ testTimeout: 60_000 });

function checkRanges(doc: XmlSource, el: XmlElement): number {
  let count = 0;
  for (const child of el.children) {
    if (child.kind !== "element") continue;
    count++;
    const src = doc.source;
    expect(src.startsWith(`<${child.name}`, child.start)).toBe(true);
    expect(src[child.end - 1]).toBe(">");
    if (child.contentStart !== child.end) {
      expect(src.slice(child.contentEnd, child.end)).toMatch(new RegExp(`^</${child.name}\\s*>$`));
    } else {
      expect(src.slice(child.end - 2, child.end)).toBe("/>");
    }
    count += checkRanges(doc, child);
  }
  return count;
}

describe("DocxPackage on the Word-authored corpus", () => {
  const files = corpusFiles();

  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it.each(files)("%s: scans every XML part with exact element ranges", async (file) => {
    const pkg = await DocxPackage.load(readCorpusFile(file));
    let elements = 0;
    for (const part of pkg.partNames()) {
      if (!/\.(xml|rels)$/i.test(part)) continue;
      const doc = pkg.xml(part)!;
      elements += checkRanges(doc, doc.root);
    }
    expect(elements).toBeGreaterThan(0);
  });

  it.each(files)("%s: save with no edits returns the original bytes", async (file) => {
    const bytes = readCorpusFile(file);
    const pkg = await DocxPackage.load(bytes);
    expect((await pkg.save()).equals(bytes)).toBe(true);
  });

  it("re-saving after an identity setText keeps every entry's content", async () => {
    const file = "public-legal/uk-msc-core-terms-v2.2a.docx";
    const bytes = readCorpusFile(file);
    const pkg = await DocxPackage.load(bytes);
    // Force a write of a modified part, then check every other entry is unchanged.
    const doc = pkg.text("word/document.xml")!;
    pkg.setText("word/document.xml", doc + " ");
    const out = await JSZip.loadAsync(await pkg.save());
    const orig = await JSZip.loadAsync(bytes);
    expect(Object.keys(out.files).sort()).toEqual(Object.keys(orig.files).sort());
    for (const name of Object.keys(orig.files)) {
      if (orig.files[name].dir || name === "word/document.xml") continue;
      const a = await orig.file(name)!.async("uint8array");
      const b = await out.file(name)!.async("uint8array");
      expect(Buffer.from(b).equals(Buffer.from(a)), name).toBe(true);
    }
    expect(await out.file("word/document.xml")!.async("string")).toBe(doc + " ");
  });
});
