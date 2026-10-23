import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import {
  getMemoryCurrent,
  getMemoryVersion,
  listMemoryVersions,
  wipeMemoryFile,
  writeMemoryFile,
  type MemoryFileRow,
} from "../../lib/memory/files";
import { restoreMemoryVersion } from "../../modules/memory/memory.service";
import type { Db } from "../../lib/db";

// Gated: runs only against a real Postgres + GoTrue (npm run test:stack,
// which starts both and sets DATABASE_TEST_URL, AUTH_TEST_URL and
// AUTH_TEST_SERVICE_KEY).
const maybeDescribe = stackConfigured ? describe : describe.skip;

maybeDescribe("memory file versions against Postgres", () => {
  const db = stackDb() as unknown as Db;
  const admin = stackAuth();
  let userId = "";

  beforeAll(async () => {
    const created = await admin.admin.createUser({
      email: `memory-versions-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "StackTest1!",
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error("no user");
    userId = created.data.user.id;
  });

  afterAll(async () => {
    if (userId) await admin.admin.deleteUser(userId);
  });

  /** The user's memory file, emptied and turned on, with no versions. */
  async function freshFile(): Promise<MemoryFileRow> {
    const { file } = await getMemoryCurrent(db, "user", userId);
    await wipeMemoryFile({ db, file, enabled: true, updatedBy: userId, deleteHistory: true });
    await db.from("memory_files").update({ enabled: true }).eq("id", file.id);
    return (await getMemoryCurrent(db, "user", userId)).file;
  }

  async function save(file: MemoryFileRow, content: string, source: "manual" | "restore" = "manual") {
    const { current } = await getMemoryCurrent(db, "user", userId);
    return writeMemoryFile({ db, file, content, expectedRevision: current.revision, source, updatedBy: userId });
  }

  it("keeps rapid editor saves as one version, and a write from elsewhere as its own", async () => {
    const file = await freshFile();
    await save(file, "- Prefers British spelling.");
    await save(file, "- Prefers British spelling.\n- Cites pinpoints.");
    let versions = await listMemoryVersions(db, file);
    expect(versions.map((version) => [version.version_number, version.source])).toEqual([[1, "manual"]]);
    expect((await getMemoryVersion(db, file, versions[0]!.id))?.content).toBe(
      "- Prefers British spelling.\n- Cites pinpoints.",
    );

    // A save after the editor version has gone quiet starts a new one.
    await db
      .from("memory_file_versions")
      .update({ updated_at: new Date(Date.now() - 11 * 60_000).toISOString() })
      .eq("id", versions[0]!.id);
    await save(file, "- Prefers British spelling.\n- Cites pinpoints.\n- Works on supply contracts.");
    versions = await listMemoryVersions(db, file);
    expect(versions.map((version) => version.version_number)).toEqual([2, 1]);
  });

  it("restores an earlier version as the newest, with a summary saying so", async () => {
    const file = await freshFile();
    await save(file, "First.");
    const [first] = await listMemoryVersions(db, file);
    await db
      .from("memory_file_versions")
      .update({ updated_at: new Date(Date.now() - 11 * 60_000).toISOString() })
      .eq("id", first!.id);
    await save(file, "Second.");
    const { current } = await getMemoryCurrent(db, "user", userId);
    const restored = await restoreMemoryVersion(db, {
      ctx: { scope: "user", ownerId: userId, file },
      versionId: first!.id,
      expectedRevision: current.revision,
      updatedBy: userId,
    });
    expect(restored?.content).toBe("First.");
    const versions = await listMemoryVersions(db, file);
    expect(versions[0]).toMatchObject({ version_number: 3, source: "restore", change_summary: "Restored version 1" });
    expect(restored?.source).toBe("manual");
  });

  it("keeps the history when memory is turned off, and deletes it when memory is deleted", async () => {
    const file = await freshFile();
    await save(file, "Kept.");
    await wipeMemoryFile({ db, file, enabled: false, updatedBy: userId, source: "settings" });
    const versions = await listMemoryVersions(db, file);
    expect(versions.map((version) => version.source)).toEqual(["settings", "manual"]);
    expect((await getMemoryVersion(db, file, versions[0]!.id))?.content).toBe("");

    const { data, error } = await db.rpc("delete_user_private_memories", { p_user_id: userId });
    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(await listMemoryVersions(db, file)).toEqual([]);
  });
});
