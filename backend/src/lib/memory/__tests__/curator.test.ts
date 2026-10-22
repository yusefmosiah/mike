import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import {
  cutoffAllowsReview,
  matchesLatestConversationActivity,
  memoryReviewPrompt,
  memoryScopeFailure,
  memoryScopeFailureCause,
} from "../../../modules/memory/memory.curator";

const store = vi.hoisted(() => ({ owner: true }));
vi.mock("../../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../llm")>()),
  ownsConversationStore: () => store.owner,
}));

describe("memory review cutoff", () => {
  // A file wiped or turned on mid-conversation may learn only once nothing
  // from before that moment is still in the context verbatim.
  const neighbours = { before: "m-before", after: "m-after" };

  it("reviews a conversation with nothing from before the cutoff", () => {
    expect(cutoffAllowsReview({ contextStart: 1 }, null, {})).toBe(true);
  });

  it("waits until a compaction has moved the context past the cutoff", () => {
    const places = { "m-before": 20, "m-after": 22 };
    expect(cutoffAllowsReview({ contextStart: 3 }, neighbours, places)).toBe(false);
    expect(cutoffAllowsReview({ contextStart: 20 }, neighbours, places)).toBe(false);
    expect(cutoffAllowsReview({ contextStart: 21 }, neighbours, places)).toBe(true);
  });

  it("falls back to the first message after the cutoff when the one before has no place", () => {
    expect(
      cutoffAllowsReview({ contextStart: 22 }, neighbours, { "m-before": null, "m-after": 22 }),
    ).toBe(true);
    expect(
      cutoffAllowsReview({ contextStart: 21 }, neighbours, { "m-before": null, "m-after": 22 }),
    ).toBe(false);
  });

  it("skips when neither side of the cutoff has a place", () => {
    expect(
      cutoffAllowsReview({ contextStart: 99 }, neighbours, { "m-before": null, "m-after": null }),
    ).toBe(false);
    expect(
      cutoffAllowsReview({ contextStart: 99 }, { before: "m-before", after: null }, {}),
    ).toBe(false);
  });
});

describe("memory review prompt", () => {
  it("names only the files it may change, fences their text, and keeps profile facts out of app memory", () => {
    const prompt = memoryReviewPrompt({
      files: [{ scope: "app", content: "- Prefers British spelling." }],
      personalisation: '{"organisation":"Acme"}',
      beforeCompaction: false,
    });
    expect(prompt).toMatch(/^\[Memory review\] This message comes from the application/);
    expect(prompt).toContain('Only "app" memory may be changed now.');
    expect(prompt).toContain('Scope "app" is the person\'s private memory');
    expect(prompt).not.toContain('Scope "project"');
    expect(prompt).toMatch(/<app-memory-[0-9a-f-]+>\n- Prefers British spelling\.\n<\/app-memory-/);
    expect(prompt).toMatch(/<saved-profile-[0-9a-f-]+>\n\{"organisation":"Acme"\}/);
    expect(prompt).toContain("call no other tool");
  });

  it("says when it is looking at the context a compaction replaced", () => {
    const prompt = memoryReviewPrompt({
      files: [
        { scope: "app", content: "" },
        { scope: "project", content: "- Governing law: England." },
      ],
      personalisation: null,
      beforeCompaction: true,
    });
    expect(prompt).toContain("has since been summarized");
    expect(prompt).toContain('Only "app" and "project" memory may be changed now.');
    expect(prompt).toMatch(/<app-memory-[0-9a-f-]+>\n\(empty\)/);
    expect(prompt).not.toContain("saved-profile");
  });
});

describe("memory review failures", () => {
  it("keeps the failure's classification, never its text, so Sentry can say why", () => {
    // MIKE-BACKEND-F: the fixed message hid every cause. A rejected provider
    // key must show up as provider_error / dependency_status on the event,
    // while the secret-bearing message stays out of the error, its cause and
    // anything console.error would render.
    const failure = memoryScopeFailure(
      Object.assign(new Error("SECRET transcript and provider credential"), {
        name: "AI_APICallError",
        statusCode: 401,
      }),
    );
    expect(failure.message).toBe("Memory curator scope failed");
    expect(failure.cause).toEqual({ name: "AI_APICallError", statusCode: 401 });
    expect(diagnosticErrorTags(failure)).toMatchObject({
      provider_error: "api_call",
      dependency_status: 401,
    });
    expect(inspect(failure, { depth: 6 })).not.toContain("SECRET");
  });
});

describe("memoryScopeFailureCause", () => {
  it("copies only allowlist-shaped name, code and HTTP status", () => {
    expect(
      memoryScopeFailureCause(
        Object.assign(new Error("raw postgrest text with a table name"), {
          code: "PGRST202",
          details: "private",
          hint: "private",
        }),
      ),
    ).toEqual({ code: "PGRST202" });
    expect(
      memoryScopeFailureCause({ name: "bad name with spaces", code: "x", status: 503 }),
    ).toEqual({ statusCode: 503 });
  });

  it("reuses the classification of an already-wrapped scope failure", () => {
    // The job-level throw wraps whichever scope failed first; that scope
    // already reduced its provider error to a classification, and the plain
    // Error around it carries nothing of its own.
    const inner = memoryScopeFailure(
      Object.assign(new Error("secret"), { name: "InvalidApiKeyError" }),
    );
    expect(memoryScopeFailureCause(inner)).toEqual({ name: "InvalidApiKeyError" });
    expect(diagnosticErrorTags(memoryScopeFailure(inner))).toMatchObject({
      provider_error: "invalid_api_key",
    });
  });

  it("carries no cause when there is nothing safe to say", () => {
    expect(memoryScopeFailureCause(undefined)).toBeUndefined();
    expect(memoryScopeFailureCause("string error")).toBeUndefined();
    expect(memoryScopeFailureCause(new Error("plain"))).toBeUndefined();
    expect(memoryScopeFailure(new Error("plain")).cause).toBeUndefined();
  });
});

describe("shared project inactivity debounce", () => {
  it("rejects an earlier actor's project token after another actor speaks", () => {
    expect(
      matchesLatestConversationActivity({
        scheduledGeneration: 8,
        latestGeneration: 9,
      }),
    ).toBe(false);
  });

  it("admits the conversation-global latest terminal turn", () => {
    expect(
      matchesLatestConversationActivity({
        scheduledGeneration: 9,
        latestGeneration: 9,
      }),
    ).toBe(true);
  });
});

describe("memory.consolidate deferral cost", () => {
  // An active conversation defers its curator job once a quiet window for as
  // long as it stays active. Claiming the job first meant every one of those
  // deferrals paid for a status write and two file-status refreshes, then
  // undid all of it. The gate has to run first: three reads, no writes.
  function deferringDb() {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const tables: string[] = [];
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const rows: Record<string, unknown> = {
      memory_consolidation_states: {
        id: "state-1",
        surface: "chat",
        conversation_id: "conv-1",
        actor_user_id: "u1",
        project_id: null,
        generation: 2,
        processed_generation: 1,
        latest_turn_id: "turn-1",
      },
      memory_conversation_activity: {
        generation: 5,
        quiet_until: future,
        deleted_at: null,
      },
      memory_conversation_turn_leases: { expires_at: future },
    };
    function from(table: string) {
      tables.push(table);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "lt", "order", "limit", "update", "in"])
        q[m] = vi.fn(() => q);
      q.maybeSingle = vi.fn(async () => ({
        data: rows[table] ?? null,
        error: null,
      }));
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    }
    return { db: { from: vi.fn(from), rpc }, rpc, tables };
  }

  const job = {
    id: "job-1",
    kind: "memory.consolidate",
    payload: {
      stateId: "state-1",
      generation: 2,
      conversationGeneration: 5,
      appEpoch: 1,
      actorUserId: "u1",
    },
  };

  it("defers without claiming the job or rewriting any file status", async () => {
    store.owner = true;
    const { db, rpc, tables } = deferringDb();
    const { handleMemoryConsolidation } = await import("../../../modules/memory/memory.curator.js");
    const { DbJobDeferredError } = await import("../../dbq/types.js");

    const deferred = handleMemoryConsolidation(db as never, job as never);
    await expect(deferred).rejects.toBeInstanceOf(DbJobDeferredError);
    await expect(deferred).rejects.toMatchObject({ message: "memory_quiet_period" });

    // No set_memory_consolidation_status claim, and no memory_files writes.
    expect(rpc).not.toHaveBeenCalled();
    expect(tables).not.toContain("memory_files");
  });

  it("leaves the job to the process that owns the conversation store", async () => {
    // A review forks a conversation, which only the API process may do.
    store.owner = false;
    const { db, rpc, tables } = deferringDb();
    const { handleMemoryConsolidation } = await import("../../../modules/memory/memory.curator.js");
    const { DbJobDeferredError } = await import("../../dbq/types.js");

    const deferred = handleMemoryConsolidation(db as never, job as never);
    await expect(deferred).rejects.toBeInstanceOf(DbJobDeferredError);
    await expect(deferred).rejects.toMatchObject({ message: "memory_store_owner" });
    expect(rpc).not.toHaveBeenCalled();
    expect(tables).not.toContain("memory_conversation_activity");
    store.owner = true;
  });
});
