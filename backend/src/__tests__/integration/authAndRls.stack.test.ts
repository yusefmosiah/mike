import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GoTrueClient } from "@supabase/auth-js";
import { asRole, stackAuth, stackConfigured, stackDb, stackUserAuth } from "./stackDb";

// Stack-level integration test: exercises a REAL GoTrue and Postgres rather
// than mocks. It is what you re-run on every GoTrue or Postgres bump to prove
// the auth↔API contract still holds, and it anchors the security model's
// central claim: Mike reaches data only over its own connection, and every
// table denies the `anon` and `authenticated` roles. Mike never uses those
// roles; a hosted Supabase exposes them through its data API, so the deny-all
// firewall must hold for a deployment that keeps its database there.
//
// Gated: npm run test:stack starts Postgres + GoTrue and sets
// DATABASE_TEST_URL, AUTH_TEST_URL and AUTH_TEST_SERVICE_KEY.
const maybeDescribe = stackConfigured ? describe : describe.skip;

// Every public table the app owns (backend/schema.sql + migrations). The
// anon/user path must never return rows from any of these (deny-all); a
// regression that ships a table without RLS — or with a permissive policy —
// trips the leak sweep below. A query the role may not run at all returns an
// error (no rows), which never counts as a leak.
const PUBLIC_TABLES = [
  "chat_messages",
  "chats",
  "courtlistener_citation_index",
  "courtlistener_opinion_cluster_index",
  "document_edits",
  "document_versions",
  "documents",
  "hidden_workflows",
  "library_folders",
  "default_workflow_installations",
  "quick_actions",
  "mike_workflows",
  "mike_workflow_assets",
  "project_subfolders",
  "projects",
  "tabular_cells",
  "tabular_review_chat_messages",
  "tabular_review_chats",
  "tabular_reviews",
  "user_api_keys",
  "user_google_drive_tokens",
  "user_google_workspace_tokens",
  "google_workspace_oauth_states",
  "google_workspace_actions",
  "user_mcp_connector_tools",
  "user_mcp_connectors",
  "user_mcp_oauth_states",
  "user_mcp_oauth_tokens",
  "user_mcp_tool_audit_logs",
  "user_profiles",
  "user_router_models",
  "word_chat_messages",
  "word_chats",
  "word_documents",
  "workflow_open_source_submissions",
  "workflow_shares",
  "workflows",
];

maybeDescribe("auth contract + RLS deny-all firewall", () => {
  const password = "StackTest1!";
  const emailA = `stack-a-${Date.now()}@test.local`;
  const emailB = `stack-b-${Date.now()}@test.local`;
  const admin = stackDb()!; // Mike's own connection: the app's data path

  let auth: GoTrueClient; // service role: token checks, user admin
  let userA = "";
  let userB = "";
  let tokenA = "";
  let projectId = "";

  beforeAll(async () => {
    auth = stackAuth();

    const a = await auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Google Stack User" },
    });
    const b = await auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (a.error || !a.data.user) throw a.error ?? new Error("no user A");
    if (b.error || !b.data.user) throw b.error ?? new Error("no user B");
    userA = a.data.user.id;
    userB = b.data.user.id;

    // Sign in as A to get a real access token (the token the API middleware
    // validates via getUser).
    const signIn = await stackUserAuth().signInWithPassword({ email: emailA, password });
    if (signIn.error || !signIn.data.session) {
      throw signIn.error ?? new Error("no session for A");
    }
    tokenA = signIn.data.session.access_token;

    // Seed one row owned by A (the app's real write path).
    const proj = await admin
      .from("projects")
      .insert({ user_id: userA, name: "Stack Test Project" })
      .select("id")
      .single();
    if (proj.error || !proj.data) throw proj.error ?? new Error("no project");
    projectId = proj.data.id;
  });

  afterAll(async () => {
    if (projectId) await admin.from("projects").delete().eq("id", projectId);
    if (userA) await auth.admin.deleteUser(userA);
    if (userB) await auth.admin.deleteUser(userB);
  });

  it("auth contract: the access token resolves to its user (middleware path)", async () => {
    const { data, error } = await auth.getUser(tokenA);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(userA);
    expect(data.user?.email).toBe(emailA);
  });

  it("signup profile uses the OAuth-style full_name metadata", async () => {
    const { data, error } = await admin
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", userA)
      .single();
    expect(error).toBeNull();
    expect(data?.display_name).toBe("Google Stack User");
  });

  it("RLS: the app sees seeded rows the owner cannot see via the user path", async () => {
    const svc = await admin.from("projects").select("id").eq("id", projectId);
    expect(svc.error).toBeNull();
    expect(svc.data ?? []).toHaveLength(1);

    // …but the owner, going through the user path, sees zero rows.
    const owner = await asRole("authenticated", userA, "select id from public.projects where id = $1", [projectId]);
    expect(owner.rows).toHaveLength(0);

    const prof = await asRole("authenticated", userA, "select user_id from public.user_profiles where user_id = $1", [userA]);
    expect(prof.rows).toHaveLength(0);
  });

  it("tenant isolation: user B cannot read user A's project via the user path", async () => {
    const cross = await asRole("authenticated", userB, "select id from public.projects where id = $1", [projectId]);
    expect(cross.rows).toHaveLength(0);
  });

  it("allows multiple independent upload sessions for one user", async () => {
    const sessionIds = [randomUUID(), randomUUID(), randomUUID()];

    for (const sessionId of sessionIds) {
      const fileId = randomUUID();
      const { error } = await admin.rpc("create_upload_session", {
        target_session_id: sessionId,
        target_user_id: userA,
        target_purpose: "document_create",
        target_destination: { scope: "standalone" },
        target_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
        target_hourly_session_limit: 50,
        target_files: [
          {
            id: fileId,
            resource_id: randomUUID(),
            client_id: fileId,
            filename: "concurrent-upload.pdf",
            target_folder_id: null,
            file_type: "pdf",
            content_type: "application/pdf",
            expected_size_bytes: 1,
            staging_storage_path: `stack-test/${fileId}/staging`,
            sealed_storage_path: `stack-test/${fileId}/sealed`,
          },
        ],
      });
      expect(error).toBeNull();
    }

    const { data, error } = await admin
      .from("upload_sessions")
      .select("id, status, user_email")
      .in("id", sessionIds);
    expect(error).toBeNull();
    expect(data).toHaveLength(3);
    expect(data?.every((session) => session.status === "pending_upload")).toBe(
      true,
    );
    expect(data?.every((session) => session.user_email === emailA)).toBe(true);

    await admin.from("upload_sessions").delete().in("id", sessionIds);
  });

  it("caps active upload-processing jobs per user while serving other users", async () => {
    const sessionIds: string[] = [];
    const createQueuedFiles = async (userId: string, fileCount: number) => {
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      const files = Array.from({ length: fileCount }, () => {
        const fileId = randomUUID();
        return {
          id: fileId,
          resource_id: randomUUID(),
          client_id: fileId,
          filename: `${fileId}.pdf`,
          target_folder_id: null,
          file_type: "pdf",
          content_type: "application/pdf",
          expected_size_bytes: 1,
          staging_storage_path: `stack-test/${fileId}/staging`,
          sealed_storage_path: `stack-test/${fileId}/sealed`,
        };
      });
      const created = await admin.rpc("create_upload_session", {
        target_session_id: sessionId,
        target_user_id: userId,
        target_purpose: "document_create",
        target_destination: { scope: "standalone" },
        target_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
        target_hourly_session_limit: 50,
        target_files: files,
      });
      expect(created.error).toBeNull();
      const uploaded = await admin
        .from("upload_session_files")
        .update({ status: "uploaded", observed_size_bytes: 1 })
        .eq("session_id", sessionId);
      expect(uploaded.error).toBeNull();
      for (const file of files) {
        const queued = await admin.rpc("queue_upload_session_file_processing", {
          target_session_id: sessionId,
          target_user_id: userId,
          target_file_id: file.id,
        });
        expect(queued.error).toBeNull();
      }
    };

    try {
      await createQueuedFiles(userA, 3);
      await createQueuedFiles(userB, 1);

      const claimedIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const claimed = await admin.rpc("claim_upload_processing_job", {
          target_worker_id: `stack-worker-${index}`,
          target_lease_seconds: 600,
          target_max_running_per_user: 2,
        });
        expect(claimed.error).toBeNull();
        if (claimed.data) claimedIds.push(claimed.data as string);
      }

      expect(claimedIds).toHaveLength(3);
      const jobs = await admin
        .from("upload_processing_jobs")
        .select("user_id, status")
        .in("id", claimedIds);
      expect(jobs.error).toBeNull();
      expect(jobs.data?.filter((job) => job.user_id === userA)).toHaveLength(2);
      expect(jobs.data?.filter((job) => job.user_id === userB)).toHaveLength(1);
    } finally {
      await admin.from("upload_sessions").delete().in("id", sessionIds);
    }
  });

  it("deleting a default workflow removes its Quick Action but preserves its installation marker", async () => {
    const defaultKey = `delete-verification-${Date.now()}`;
    const workflowResult = await admin
      .from("workflows")
      .insert({
        user_id: userA,
        title: "Deletable default verification",
        type: "assistant",
      })
      .select("id")
      .single();
    expect(workflowResult.error).toBeNull();
    const workflowId = workflowResult.data!.id;

    const installationResult = await admin
      .from("default_workflow_installations")
      .insert({
        user_id: userA,
        default_key: defaultKey,
        workflow_id: workflowId,
      });
    expect(installationResult.error).toBeNull();
    const actionResult = await admin.from("quick_actions").insert({
      user_id: userA,
      workflow_id: workflowId,
      name: "Verify cascade",
      prompt: "Verify cascade",
    });
    expect(actionResult.error).toBeNull();

    const deletionResult = await admin
      .from("workflows")
      .delete()
      .eq("id", workflowId);
    expect(deletionResult.error).toBeNull();

    const installation = await admin
      .from("default_workflow_installations")
      .select("workflow_id")
      .eq("user_id", userA)
      .eq("default_key", defaultKey)
      .single();
    expect(installation.error).toBeNull();
    expect(installation.data?.workflow_id).toBeNull();

    const actions = await admin
      .from("quick_actions")
      .select("id")
      .eq("workflow_id", workflowId);
    expect(actions.error).toBeNull();
    expect(actions.data).toEqual([]);

    await admin
      .from("default_workflow_installations")
      .delete()
      .eq("user_id", userA)
      .eq("default_key", defaultKey);
  });

  it.each(["default_workflow_installations", "quick_actions"] as const)(
    "%s: populated rows are accessible only through the service role",
    async (table) => {
      const workflowId = randomUUID();
      const rowId = randomUUID();
      const workflow = await admin.from("workflows").insert({
        id: workflowId,
        user_id: userA,
        title: "Workflow metadata access verification",
        type: "assistant",
      });
      expect(workflow.error).toBeNull();

      const row: {
        id: string;
        user_id: string;
        workflow_id: string;
        name?: string;
        prompt?: string;
        default_key?: string;
      } = {
        id: rowId,
        user_id: userA,
        workflow_id: workflowId,
        ...(table === "quick_actions"
          ? { name: "Private quick action", prompt: "Private prompt" }
          : { default_key: `access-verification-${rowId}` }),
      };
      const patch =
        table === "quick_actions"
          ? { name: "Updated by backend" }
          : { default_key: `updated-${rowId}` };

      try {
        const inserted = await admin.from(table).insert(row);
        expect(inserted.error).toBeNull();
        const updated = await admin.from(table).update(patch).eq("id", rowId);
        expect(updated.error).toBeNull();
        const stored = await admin
          .from(table)
          .select("*")
          .eq("id", rowId)
          .single();
        expect(stored.error).toBeNull();
        expect(stored.data).toMatchObject({ ...row, ...patch });

        const callers = [
          ["anon", null],
          ["authenticated", userA],
          ["authenticated", userB],
        ] as const;
        for (const [role, caller] of callers) {
          const read = await asRole(role, caller, `select * from public.${table} where id = $1`, [rowId]);
          expect(read.code).toBe("42501");
          const insert = await asRole(
            role,
            caller,
            `insert into public.${table} select * from json_populate_record(null::public.${table}, $1)`,
            [JSON.stringify({ ...row, id: randomUUID() })],
          );
          expect(insert.code).toBe("42501");
          const update = await asRole(role, caller, `update public.${table} set user_id = $1 where id = $2`, [userB, rowId]);
          expect(update.code).toBe("42501");
          const deletion = await asRole(role, caller, `delete from public.${table} where id = $1`, [rowId]);
          expect(deletion.code).toBe("42501");
        }

        const unchanged = await admin
          .from(table)
          .select("*")
          .eq("id", rowId)
          .single();
        expect(unchanged.error).toBeNull();
        expect(unchanged.data).toEqual(stored.data);
        const deleted = await admin
          .from(table)
          .delete()
          .eq("id", rowId)
          .select("id");
        expect(deleted.error).toBeNull();
        expect(deleted.data).toEqual([{ id: rowId }]);
      } finally {
        await admin.from(table).delete().eq("id", rowId);
        await admin.from("workflows").delete().eq("id", workflowId);
      }
    },
  );

  it("leak sweep: no public table returns rows to the authenticated user path", async () => {
    const leaks: string[] = [];
    for (const table of PUBLIC_TABLES) {
      const { rows } = await asRole("authenticated", userA, `select * from public.${table} limit 1`);
      if (rows.length > 0) leaks.push(table);
    }
    // Any table returning rows to a normal user means RLS is missing or a
    // policy is permissive — the exact regression this guards against.
    expect(leaks).toEqual([]);
  });
});
