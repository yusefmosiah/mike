import { describe, expect, it } from "vitest";
import { readCorpusFile } from "../../../__tests__/helpers/docxCorpus";
import { blockIds, carryBlockIds, idSlots } from "../blockIds";
import { applyEdits, type EditOp } from "../edit";
import { resolveRevisions } from "../revisions";
import { DocxDocument } from "../view";

const MSC = "public-legal/uk-msc-core-terms-v2.2a.docx";
const SCHEDULES = "public-legal/uk-msc-consolidated-schedules-v2.2a.docx";
const ACADEMY = "public-legal/uk-academy-commercial-transfer-agreement-2013.docx";

/** Load bytes with ids, as a stored version would be. */
async function withIds(bytes: Buffer, ids: string[]): Promise<DocxDocument> {
  const doc = await DocxDocument.load(bytes);
  expect(doc.relabel(ids)).toBe(true);
  return doc;
}

/** Text -> id for every paragraph whose text is unique in the document. */
function byText(doc: DocxDocument): Map<string, string> {
  const counts = new Map<string, number>();
  for (const b of idSlots(doc)) if (b.kind === "paragraph" && b.text.trim()) counts.set(b.text, (counts.get(b.text) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const b of idSlots(doc)) if (b.kind === "paragraph" && counts.get(b.text) === 1) out.set(b.text, b.id);
  return out;
}

describe("block ids across versions", () => {
  it("an unchanged document keeps its own ids", async () => {
    for (const file of [MSC, ACADEMY]) {
      const doc = await DocxDocument.load(readCorpusFile(file));
      const again = await DocxDocument.load(readCorpusFile(file));
      expect(carryBlockIds(doc, again)).toEqual(blockIds(doc));
    }
  });

  it("ordinal ids survive an insert, a delete, and then accept-all (a document without paraIds)", async () => {
    const original = readCorpusFile(ACADEMY);
    const v1 = await DocxDocument.load(original);
    const ops: EditOp[] = [
      { op: "insert", after: "p19", paragraphs: ["(1A) a new party"] },
      { op: "delete", block: "p21" },
      { op: "replace", block: "p28", find: "proposed name", replace: "agreed name" },
    ];
    const edited = await applyEdits(original, ops, { author: "T", ids: blockIds(v1) });
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    const v2 = await withIds(edited.bytes, edited.blockIds);
    expect(v2.byId.get("p19+1")?.kind === "paragraph" && (v2.byId.get("p19+1") as { text: string }).text).toBe("(1A) a new party");
    expect(v2.byId.has("p28")).toBe(true);

    // Accepting everything removes p21 and makes p19+1 an ordinary paragraph;
    // with default ids every later ordinal would shift. Carried, nothing moves.
    const acceptedBytes = (await resolveRevisions(edited.bytes, "accept")).bytes;
    const v3default = await DocxDocument.load(acceptedBytes);
    const v3 = await withIds(acceptedBytes, carryBlockIds(v2, v3default));
    expect(blockIds(v3default)).not.toEqual(blockIds(v3)); // the defaults did shift
    expect((v3.byId.get("p19+1") as { text: string }).text).toBe("(1A) a new party");
    expect(v3.byId.has("p21")).toBe(false);
    expect((v3.byId.get("p28") as { text: string }).text).toContain("agreed name");
    const was = byText(v1);
    let kept = 0;
    for (const [text, id] of byText(v3)) {
      if (was.has(text)) {
        expect(id, text).toBe(was.get(text));
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(200);
  });

  it("a deleted block's id is never given to another block", async () => {
    const original = readCorpusFile(ACADEMY);
    const v1 = await DocxDocument.load(original);
    const edited = await applyEdits(original, [{ op: "delete", block: "p21" }], { author: "T", ids: blockIds(v1) });
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    const accepted = (await resolveRevisions(edited.bytes, "accept")).bytes;
    const v2 = await withIds(edited.bytes, edited.blockIds);
    const v3 = await withIds(accepted, carryBlockIds(v2, await DocxDocument.load(accepted)));
    expect(blockIds(v3)).not.toContain("p21");
  });

  it("carries ids across a re-saved document with no tracked changes (as after editing in Word)", async () => {
    // Accept-all of an edited copy stands in for a file someone edited in Word and uploaded.
    const original = readCorpusFile(MSC);
    const v1 = await DocxDocument.load(original);
    const edited = await applyEdits(
      original,
      [
        { op: "insert", after: "0000011B", paragraphs: ["a new paragraph"] },
        { op: "replace", block: "00000125", find: "as soon as practicable", replace: "promptly" },
      ],
      { author: "T" },
    );
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    const uploaded = await DocxDocument.load((await resolveRevisions(edited.bytes, "accept")).bytes);
    const ids = carryBlockIds(v1, uploaded);
    const v2 = await withIds((await resolveRevisions(edited.bytes, "accept")).bytes, ids);
    expect((v2.byId.get("00000125") as { text: string }).text).toContain("notify the Supplier which requirement");
    expect((v2.byId.get("00000125") as { text: string }).text).toContain("promptly");
    const added = idSlots(v2).find((b) => b.kind === "paragraph" && b.text === "a new paragraph")!;
    expect(added.id).toBe("0000011B+1");
  });

  it("aligns the 12,600-paragraph schedules quickly", async () => {
    const bytes = readCorpusFile(SCHEDULES);
    const a = await DocxDocument.load(bytes);
    const edited = await applyEdits(bytes, [{ op: "insert", after: a.paragraphs[500].id, paragraphs: ["x"] }], { author: "T" });
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    const b = await DocxDocument.load(edited.bytes);
    const start = performance.now();
    const ids = carryBlockIds(a, b);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(ids.filter((id) => id.includes("+"))).toEqual([`${a.paragraphs[500].id}+1`]);
  });

  it("relabel refuses ids that do not fit", async () => {
    const doc = await DocxDocument.load(readCorpusFile(MSC));
    const ids = blockIds(doc);
    expect(doc.relabel(ids.slice(1))).toBe(false);
    expect(doc.relabel([ids[1], ...ids.slice(1)])).toBe(false);
    expect(doc.relabel(ids)).toBe(true);
  });
});
