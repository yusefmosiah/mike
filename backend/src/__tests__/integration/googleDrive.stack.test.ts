import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, stackAuth, stackConfigured, stackDb } from "./stackDb";

// Gated: npm run test:stack starts Postgres + GoTrue and sets
// DATABASE_TEST_URL, AUTH_TEST_URL and AUTH_TEST_SERVICE_KEY.
const suite = stackConfigured ? describe : describe.skip;

suite("Google Drive: real database atomic lifecycle and authorization", () => {
    const admin = stackDb()!;
    const auth = stackAuth();
    let userId = "";
    const patch = {
        encrypted_access_token: "encrypted-access",
        access_token_iv: "iv",
        access_token_tag: "tag",
        encrypted_refresh_token: "encrypted-refresh",
        refresh_token_iv: "iv",
        refresh_token_tag: "tag",
        scope: "https://www.googleapis.com/auth/drive.readonly",
        expires_at: "2099-01-01T00:00:00Z",
    };
    beforeAll(async () => {
        const email = `drive-${randomUUID()}@test.local`;
        const password = `Test-${randomUUID()}!`;
        const created = await auth.admin.createUser({
            email,
            password,
            email_confirm: true,
        });
        if (created.error || !created.data.user)
            throw created.error ?? new Error("No test user");
        userId = created.data.user.id;
    });
    beforeEach(async () => {
        const result = await admin.rpc("disconnect_google_drive", {
            p_user_id: userId,
        });
        expect(result.error).toBeNull();
    });
    afterAll(async () => {
        if (userId) await auth.admin.deleteUser(userId);
    });
    // Drive's pending sign-ins share the Gmail/Calendar state table.
    const STATES = "google_workspace_oauth_states";
    async function state(
        expires = "2099-01-01T00:00:00Z",
        provider = "google-drive",
    ) {
        const hash = randomUUID();
        const result = await admin.from(STATES).insert({
            user_id: userId,
            provider,
            state_hash: hash,
            encrypted_state_config: "encrypted",
            state_config_iv: "iv",
            state_config_tag: "tag",
            expires_at: expires,
        });
        expect(result.error).toBeNull();
        return hash;
    }
    const complete = (hash: string, value = patch) =>
        admin.rpc("complete_google_drive_oauth", {
            p_state_hash: hash,
            p_tokens: value,
        });
    async function rows(table: string) {
        const result = await admin
            .from(table)
            .select("user_id")
            .eq("user_id", userId);
        expect(result.error).toBeNull();
        return result.data;
    }
    it("consumes a state only once, including concurrent callbacks", async () => {
        const hash = await state();
        const results = await Promise.all([complete(hash), complete(hash)]);
        expect(results.map((r) => r.error)).toEqual([null, null]);
        expect(results.map((r) => r.data).sort()).toEqual([false, true]);
        expect(await rows(STATES)).toHaveLength(0);
        expect(await rows("user_google_drive_tokens")).toHaveLength(1);
        expect((await complete(hash)).data).toBe(false);
    });
    it("rolls back state consumption if the token write fails", async () => {
        const hash = await state();
        const failed = await complete(hash, {
            ...patch,
            expires_at: "not-a-timestamp",
        });
        expect(failed.error).not.toBeNull();
        expect(await rows(STATES)).toHaveLength(1);
        expect(await rows("user_google_drive_tokens")).toHaveLength(0);
        expect((await complete(hash)).data).toBe(true);
    });
    it("rejects expired/cancelled states", async () => {
        expect((await complete(await state("2000-01-01T00:00:00Z"))).data).toBe(
            false,
        );
        const hash = await state();
        await admin
            .from(STATES)
            .delete()
            .eq("state_hash", hash)
            .eq("user_id", userId);
        expect((await complete(hash)).data).toBe(false);
        expect(await rows("user_google_drive_tokens")).toHaveLength(0);
    });
    it("never consumes or clears another Google provider's state", async () => {
        const gmail = await state(undefined, "gmail");
        expect((await complete(gmail)).data).toBe(false);
        expect(await rows("user_google_drive_tokens")).toHaveLength(0);
        await admin.rpc("disconnect_google_drive", { p_user_id: userId });
        expect(await rows(STATES)).toHaveLength(1);
        await admin.from(STATES).delete().eq("state_hash", gmail);
    });
    it("disconnect wins against an in-flight completion without resurrection", async () => {
        for (let i = 0; i < 5; i++) {
            const hash = await state();
            const results = await Promise.all([
                complete(hash),
                admin.rpc("disconnect_google_drive", { p_user_id: userId }),
            ]);
            expect(results.map((r) => r.error)).toEqual([null, null]);
            expect(await rows("user_google_drive_tokens")).toHaveLength(0);
            expect(await rows(STATES)).toHaveLength(0);
        }
    });
    it("denies token/state reads and lifecycle RPCs to anon and the signed-in owner", async () => {
        const hash = await state();
        expect((await complete(hash)).data).toBe(true);
        await state();
        for (const [role, caller] of [["anon", null], ["authenticated", userId]] as const) {
            for (const table of [
                "user_google_drive_tokens",
                STATES,
            ]) {
                const result = await asRole(role, caller, `select * from public.${table}`);
                expect(result.code).toBeDefined();
                expect(result.rows).toEqual([]);
            }
            expect(
                (
                    await asRole(role, caller, "select public.disconnect_google_drive($1)", [userId])
                ).code,
            ).toBeDefined();
            expect(
                (
                    await asRole(
                        role,
                        caller,
                        "select public.complete_google_drive_oauth($1, $2::jsonb)",
                        [hash, JSON.stringify(patch)],
                    )
                ).code,
            ).toBeDefined();
        }
        expect(await rows("user_google_drive_tokens")).toHaveLength(1);
    });
    it("does not recreate a connection when a refresh updates after disconnect", async () => {
        expect((await complete(await state())).data).toBe(true);
        await admin.rpc("disconnect_google_drive", { p_user_id: userId });
        const refreshed = await admin
            .from("user_google_drive_tokens")
            .update({ encrypted_access_token: "new-access" })
            .eq("user_id", userId)
            .eq("encrypted_access_token", patch.encrypted_access_token)
            .select("user_id");
        expect(refreshed.error).toBeNull();
        expect(refreshed.data).toEqual([]);
    });
});
