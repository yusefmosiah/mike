import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";
import { getMemoryCurrent, listMemoryVersions, wipeMemoryFile } from "../../lib/memory/files";
import { beginMemoryConversationTurn, scheduleMemoryConsolidation } from "../../lib/memory/schedule";
import { kernels } from "../../lib/codemode";
import type { Db } from "../../lib/db";
import type { DbJob } from "../../lib/dbq/types";

// The model side of the review is mocked: what is under test is the job
// around it (fences, cutoff, results, the reviewed cursor) on real Postgres.
const llm = vi.hoisted(() => ({
  points: vi.fn(),
  review: vi.fn(),
  mark: vi.fn(async () => undefined),
}));
vi.mock("../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm")>()),
  ownsConversationStore: () => true,
  memoryReviewPoints: llm.points,
  reviewMemory: llm.review,
  markMemoryReviewed: llm.mark,
}));

// No provider keys on the stack: the conversation's model counts as usable.
vi.mock("../../lib/modelSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/modelSelection")>()),
  resolveEffectiveChatModel: async () => ({ ok: true, model: "stack-model" }),
}));

// No workstation: a local python3 kernel stands in for it (beforeAll).
vi.mock("../../lib/workstation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workstation")>()),
  resolveWorkstation: async () => null,
}));

const { handleMemoryConsolidation } = await import("../../modules/memory/memory.service");

// Gated: runs only against a real Postgres + GoTrue (npm run test:stack).
const maybeDescribe = stackConfigured ? describe : describe.skip;

maybeDescribe("the background memory review against Postgres", () => {
  const db = stackDb() as unknown as Db;
  const admin = stackAuth();
  const users: string[] = [];
  const jobs: string[] = [];
  let owner = "";

  beforeAll(async () => {
    vi.stubEnv("CODE_MODE_LOCAL_KERNEL_DIR", mkdtempSync(path.join(tmpdir(), "mike-kernel-")));
    // The review looks its actor up in the stack's GoTrue.
    vi.stubEnv("AUTH_URL", process.env.AUTH_TEST_URL);
    vi.stubEnv("AUTH_SERVICE_KEY", process.env.AUTH_TEST_SERVICE_KEY);
    const created = await admin.admin.createUser({
      email: `memory-review-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "StackTest1!",
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error("no user");
    owner = created.data.user.id;
    users.push(owner);
    const { file } = await getMemoryCurrent(db, "user", owner);
    await wipeMemoryFile({ db, file, enabled: true, updatedBy: owner, deleteHistory: true });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await kernels.closeAll();
    // The handler runs outside a runner, so its jobs would stay claimable.
    if (jobs.length) await db.from("db_jobs").delete().in("id", jobs);
    for (const id of users) await admin.admin.deleteUser(id);
  });

  /** One run_python cell of the review, as the model would send it. */
  const cell = (id: string, code: string) => ({ id, name: "run_python", input: { code } });

  /** A private chat with one finished turn, its review job scheduled and its quiet window over. */
  async function quietChat(): Promise<{ chatId: string; answerId: string; job: DbJob }> {
    const { data: chat, error } = await db
      .from("chats")
      .insert({ user_id: owner, title: "Memory review" })
      .select("id")
      .single();
    if (error) throw error;
    const chatId = (chat as { id: string }).id;
    const turn = await beginMemoryConversationTurn({ db, surface: "chat", conversationId: chatId, actorUserId: owner });
    const { data: question } = await db
      .from("chat_messages")
      .insert({ chat_id: chatId, role: "user", content: "I prefer British spelling.", author_user_id: owner })
      .select("id")
      .single();
    const { data: answer } = await db
      .from("chat_messages")
      .insert({
        chat_id: chatId,
        role: "assistant",
        content: [{ type: "content", text: "Noted." }],
        author_user_id: owner,
        memory_input_message_id: (question as { id: string }).id,
      })
      .select("id")
      .single();
    const answerId = (answer as { id: string }).id;
    const scheduled = await scheduleMemoryConsolidation({
      db,
      surface: "chat",
      conversationId: chatId,
      actorUserId: owner,
      turnId: answerId,
      turn,
    });
    if (!scheduled) throw new Error("not scheduled");
    await db
      .from("memory_conversation_activity")
      .update({ quiet_until: new Date(Date.now() - 1_000).toISOString() })
      .eq("surface", "chat")
      .eq("conversation_id", chatId);
    const { data: job } = await db.from("db_jobs").select("*").eq("id", scheduled.job_id).single();
    jobs.push(scheduled.job_id);
    return { chatId, answerId, job: job as DbJob };
  }

  it("edits app memory as the curator on a fork at the chat's latest answer, then marks it reviewed", async () => {
    const { chatId, answerId, job } = await quietChat();
    llm.points.mockResolvedValueOnce({
      points: [{ conversation: 7, entry: 40, contextStart: 1 }],
      places: {},
    });
    llm.review.mockImplementationOnce(async (params) => {
      const [result] = await params.runTools([
        cell(
          "call-1",
          'print(await tools.edit_memory(scope="app", edits=[{"old_text": "", "new_text": "- Prefers British spelling."}], summary="Added the spelling preference."))',
        ),
      ]);
      expect(result.content).toMatch(/'changed': True/);
      return { status: "done", reply: "Added the spelling preference.", usage: { input: 10, output: 5, cost: 0 } };
    });

    const outcome = await handleMemoryConsolidation(db, job);

    expect(llm.points).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, reviewer: owner, atMessageId: answerId }),
    );
    expect(llm.review.mock.calls[0]![0]).toMatchObject({
      point: { conversation: 7, entry: 40 },
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "run_python" }) })],
    });
    expect(outcome).toMatchObject({ outcomes: { user: "updated" }, reviews: 1 });
    const { file, current } = await getMemoryCurrent(db, "user", owner);
    expect(current.content).toBe("- Prefers British spelling.");
    const [latest] = await listMemoryVersions(db, file);
    expect(latest).toMatchObject({ source: "curator", source_chat_id: chatId });
    expect(llm.mark).toHaveBeenCalledWith({ chatId, reviewer: owner, through: 40 });
  });

  it("refuses any tool but run_python and any function but edit_memory, and stops when the conversation resumes", async () => {
    const { chatId, job } = await quietChat();
    llm.points.mockResolvedValueOnce({
      points: [{ conversation: 8, entry: 50, contextStart: 1 }],
      places: {},
    });
    llm.review.mockImplementationOnce(async (params) => {
      const [refused] = await params.runTools([{ id: "c0", name: "edit_memory", input: {} }]);
      expect(refused.content).toContain("Only run_python");
      const [missing] = await params.runTools([cell("c1", "await tools.read_document(doc_id='doc-0')")]);
      expect(missing.content).toMatch(/error/i);
      await db
        .from("memory_conversation_activity")
        .update({ quiet_until: new Date(Date.now() + 60_000).toISOString() })
        .eq("surface", "chat")
        .eq("conversation_id", chatId);
      const [stopped] = await params.runTools([
        cell("c2", 'await tools.edit_memory(scope="app", edits=[{"old_text": "", "new_text": "- Late."}], summary="Late.")'),
      ]);
      expect(stopped.content).toContain("The conversation has resumed");
      expect(params.signal.aborted).toBe(true);
      return { status: "failed", reply: "", usage: { input: 0, output: 0, cost: 0 } };
    });
    llm.mark.mockClear();

    await expect(handleMemoryConsolidation(db, job)).rejects.toMatchObject({ name: "DbJobDeferredError" });
    expect((await getMemoryCurrent(db, "user", owner)).current.content).not.toContain("Late");
    expect(llm.mark).not.toHaveBeenCalled();
  });
});
