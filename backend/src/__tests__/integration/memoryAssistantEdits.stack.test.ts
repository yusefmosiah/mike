import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import { getMemoryCurrent, listMemoryVersions, wipeMemoryFile } from "../../lib/memory/files";
import { editMemoryFromConversation } from "../../modules/memory/memory.service";
import type { Db } from "../../lib/db";

// Gated: runs only against a real Postgres + GoTrue (npm run test:stack).
const maybeDescribe = stackConfigured ? describe : describe.skip;

maybeDescribe("the assistant's memory edits against Postgres", () => {
  const db = stackDb() as unknown as Db;
  const admin = stackAuth();
  const users: string[] = [];

  async function createUser(): Promise<string> {
    const created = await admin.admin.createUser({
      email: `memory-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "StackTest1!",
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error("no user");
    users.push(created.data.user.id);
    return created.data.user.id;
  }

  async function chat(userId: string, projectId: string | null = null): Promise<string> {
    const { data, error } = await db
      .from("chats")
      .insert({ user_id: userId, project_id: projectId, title: "Memory" })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  async function project(userId: string): Promise<string> {
    const { data, error } = await db
      .from("projects")
      .insert({ user_id: userId, name: "Matter" })
      .select("id")
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  let owner = "";
  let other = "";

  beforeAll(async () => {
    owner = await createUser();
    other = await createUser();
    const { file } = await getMemoryCurrent(db, "user", owner);
    await wipeMemoryFile({ db, file, enabled: true, updatedBy: owner, deleteHistory: true });
  });

  afterAll(async () => {
    for (const id of users) await admin.admin.deleteUser(id);
  });

  it("writes app memory from the person's private chat as an assistant version", async () => {
    const chatId = await chat(owner);
    const outcome = await editMemoryFromConversation(
      db,
      { userId: owner, appWritable: true, projectId: null, surface: "chat", conversationId: chatId },
      { scope: "app", edits: [{ old_text: "", new_text: "- Prefers British spelling." }], summary: "Added the spelling preference." },
    );
    expect(outcome).toMatchObject({ ok: true, changed: true, scope: "app", versionNumber: expect.any(Number) });
    const { file, current } = await getMemoryCurrent(db, "user", owner);
    expect(current.content).toBe("- Prefers British spelling.");
    expect(current.source).toBe("assistant");
    const [latest] = await listMemoryVersions(db, file);
    expect(latest).toMatchObject({
      source: "assistant",
      change_summary: "Added the spelling preference.",
      source_chat_id: chatId,
      updated_by: owner,
    });
    expect(outcome.ok && outcome.versionId).toBe(latest!.id);
  });

  it("refuses app memory from a chat someone else owns, even if the caller claims it is private", async () => {
    const chatId = await chat(other);
    const outcome = await editMemoryFromConversation(
      db,
      { userId: owner, appWritable: true, projectId: null, surface: "chat", conversationId: chatId },
      { scope: "app", edits: [{ old_text: "", new_text: "- Planted." }], summary: "Planted." },
    );
    expect(outcome).toEqual({ ok: false, error: "This conversation may not change that memory." });
    expect((await getMemoryCurrent(db, "user", owner)).current.content).not.toContain("Planted");
  });

  it("writes project memory only from a chat in that project", async () => {
    const matter = await project(owner);
    const elsewhere = await project(owner);
    const outcome = await editMemoryFromConversation(
      db,
      { userId: owner, appWritable: false, projectId: matter, surface: "chat", conversationId: await chat(owner, matter) },
      { scope: "project", edits: [{ old_text: "", new_text: "- Governing law: England." }], summary: "Added the governing law." },
    );
    expect(outcome).toMatchObject({ ok: true, changed: true, projectId: matter });

    const refused = await editMemoryFromConversation(
      db,
      { userId: owner, appWritable: false, projectId: matter, surface: "chat", conversationId: await chat(owner, elsewhere) },
      { scope: "project", edits: [{ old_text: "", new_text: "- Planted." }], summary: "Planted." },
    );
    expect(refused).toEqual({ ok: false, error: "This conversation may not change that memory." });
    expect((await getMemoryCurrent(db, "project", matter)).current.content).toBe("- Governing law: England.");
  });
});
