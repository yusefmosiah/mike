import { beforeEach, describe, expect, it, vi } from "vitest";

const texts = new Map<string, string>();
const started: Array<{ versionId: string | null | undefined }> = [];
const cancelled: string[] = [];

vi.mock("../../documents/documents.service", () => ({
  getDocument: vi.fn(async (id: string) => (id === "doc" ? { ok: true, doc: { id } } : { ok: false })),
}));
vi.mock("../../../lib/documentVersions", () => ({
  loadActiveVersion: vi.fn(async () => ({ id: current })),
}));
vi.mock("../citations.tasks", () => ({
  readVersionText: vi.fn(async (_db: unknown, _doc: string, versionId: string) =>
    texts.has(versionId) ? { content: texts.get(versionId), blockOffsets: null } : "gone"),
  startCitationCheck: vi.fn(async (_db: unknown, args: { versionId?: string | null }) => {
    started.push({ versionId: args.versionId });
    return { ok: true, data: { id: `task-${args.versionId}`, document_version_id: args.versionId, status: "queued" } };
  }),
  cancelCitationCheck: vi.fn(async (_db: unknown, args: { taskId: string }) => {
    cancelled.push(args.taskId);
    return { ok: true, data: { cancelled: true } };
  }),
}));

import { autoCheckCitations, citationFingerprint, citingParagraphs } from "../citations.auto";

// Fingerprints are cached per version id, so each test uses its own ids.
let prefix = 0;
const v = (name: string) => `${prefix}-${name}`;
let current = "";
let latestTask: Record<string, unknown> | null = null;
const db = {
  from: () => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({ data: latestTask ? [latestTask] : [] }),
    };
    return query;
  },
};
const run = () => autoCheckCitations(db as never, { userId: "u", documentId: "doc" });

const memo = [
  "MEMORANDUM",
  "The court held in Brown v. Board of Education, 347 U.S. 483 (1954), that separate facilities are inherently unequal.",
  "Fair use is governed by 17 U.S.C. § 107.",
  "We recommend proceeding with the motion.",
].join("\n");

beforeEach(() => {
  texts.clear();
  started.length = 0;
  cancelled.length = 0;
  latestTask = null;
  prefix += 1;
  current = v("v1");
});

describe("citation fingerprint", () => {
  it("keeps only paragraphs that cite something", () => {
    expect(citingParagraphs(memo, null)).toHaveLength(2);
    expect(citingParagraphs("See https://example.com/page for details.\nNothing here.", null)).toHaveLength(1);
    expect(citingParagraphs('R v Brown [1994] 1 AC 212 decided it.\nId. at 214.\nShe said "this is a quotation that is long enough to be quoting a source".', null)).toHaveLength(3);
    expect(citingParagraphs("Plain prose with no authorities.\nAnother line.", null)).toEqual([]);
  });

  it("ignores edits away from citations and spacing, and notices edits to them", () => {
    const before = citationFingerprint(memo, null);
    expect(citationFingerprint(memo.replace("We recommend proceeding", "We advise proceeding"), null)).toEqual(before);
    expect(citationFingerprint(memo.replace("Fair use is", "Fair  use   is"), null)).toEqual(before);
    expect(citationFingerprint(memo.replace("inherently unequal", "inherently equal"), null)).not.toEqual(before);
    expect(citationFingerprint(`${memo}\nSee also Miranda v. Arizona, 384 U.S. 436.`, null)).not.toEqual(before);
  });
});

describe("automatic citation check", () => {
  it("checks a first version that cites something, and not one that cites nothing", async () => {
    texts.set(v("v1"), memo);
    expect((await run()).ok && started).toEqual([{ versionId: v("v1") }]);
    texts.set(v("v1b"), "No authorities at all.");
    current = v("v1b");
    started.length = 0;
    const result = await run();
    expect(result.ok && result.data.reason).toBe("no_citations");
    expect(started).toEqual([]);
  });

  it("leaves a checked version alone, and a version whose citations did not change", async () => {
    texts.set(v("v1"), memo);
    latestTask = { id: "t1", document_version_id: v("v1"), status: "completed" };
    expect((await run()).ok).toBe(true);
    current = v("v2");
    texts.set(v("v2"), memo.replace("We recommend", "We advise"));
    const result = await run();
    expect(result.ok && result.data.reason).toBe("unchanged");
    expect(started).toEqual([]);
  });

  it("re-checks when a citation changed, superseding a check still running", async () => {
    texts.set(v("v1"), memo);
    texts.set(v("v2"), memo.replace("inherently unequal", "inherently equal"));
    latestTask = { id: "t1", document_version_id: v("v1"), status: "running" };
    current = v("v2");
    const result = await run();
    expect(result.ok && result.data.reason).toBe("started");
    expect(cancelled).toEqual(["t1"]);
    expect(started).toEqual([{ versionId: v("v2") }]);
  });

  it("refuses a document the person cannot read", async () => {
    const result = await autoCheckCitations(db as never, { userId: "u", documentId: "other" });
    expect(result.ok).toBe(false);
  });
});
