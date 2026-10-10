import { describe, expect, it, vi } from "vitest";
import type { Db } from "./db";
import {
    TURN_CLAIM_LEASE_SECONDS,
    claimTurn,
    createTurnAdmission,
    currentTurnHolder,
} from "./turnClaims";

type RpcResult = { data: unknown; error: unknown };

function stubDb(answers: Record<string, RpcResult | ((args: Record<string, unknown>) => RpcResult)>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = {
        rpc: vi.fn((name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            const answer = answers[name] ?? { data: null, error: null };
            return Promise.resolve(typeof answer === "function" ? answer(args) : answer);
        }),
    } as unknown as Db;
    return { db, calls };
}

const granted = {
    granted: true,
    holder_turn_id: "turn-1",
    holder_actor_user_id: "partner",
    holder_actor_role: "owner",
    holder_claimed_at: "2026-10-10T07:00:00Z",
};

const timers = () => {
    let tick: (() => void) | null = null;
    return {
        setInterval: vi.fn((fn: () => void) => {
            tick = fn;
            return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: vi.fn() as unknown as typeof clearInterval,
        tick: () => tick?.(),
    };
};

describe("claimTurn", () => {
    it("claims with the actor, role and lease, renews while held, and releases once", async () => {
        const { db, calls } = stubDb({
            claim_chat_turn: { data: [granted], error: null },
            renew_chat_turn: { data: true, error: null },
            release_chat_turn: { data: null, error: null },
        });
        const t = timers();
        const result = await claimTurn(
            db,
            { surface: "chat", chatId: "chat-1", turnId: "turn-1", actorUserId: "partner", actorRole: "owner" },
            t,
        );
        expect(result.ok).toBe(true);
        expect(calls[0]).toEqual({
            name: "claim_chat_turn",
            args: {
                p_surface: "chat",
                p_chat_id: "chat-1",
                p_turn_id: "turn-1",
                p_actor_user_id: "partner",
                p_actor_role: "owner",
                p_lease_seconds: TURN_CLAIM_LEASE_SECONDS,
            },
        });
        t.tick();
        await Promise.resolve();
        expect(calls[1]).toMatchObject({ name: "renew_chat_turn", args: { p_turn_id: "turn-1" } });
        if (!result.ok) throw new Error("not claimed");
        await result.claim.release();
        await result.claim.release();
        expect(t.clearInterval).toHaveBeenCalledTimes(1);
        expect(calls.filter((call) => call.name === "release_chat_turn")).toHaveLength(1);
    });

    it("reports who holds the thread when it is taken", async () => {
        const { db } = stubDb({
            claim_chat_turn: { data: [{ ...granted, granted: false, holder_actor_user_id: "associate", holder_actor_role: "editor" }], error: null },
        });
        expect(
            await claimTurn(db, { surface: "chat", chatId: "c", turnId: "turn-2", actorUserId: "partner", actorRole: "owner" }),
        ).toEqual({
            ok: false,
            reason: "held",
            holder: { turnId: "turn-1", actorUserId: "associate", actorRole: "editor", claimedAt: "2026-10-10T07:00:00Z" },
        });
    });

    it("fills a holder with missing fields and accepts a single-row answer", async () => {
        const { db } = stubDb({
            claim_chat_turn: { data: { granted: false, holder_turn_id: null, holder_actor_user_id: null, holder_actor_role: null, holder_claimed_at: null }, error: null },
        });
        const result = await claimTurn(db, { surface: "chat", chatId: "c", turnId: "t", actorUserId: "u", actorRole: null });
        expect(result).toMatchObject({ ok: false, reason: "held", holder: { turnId: "" } });
    });

    it("fails on a database error or an empty answer", async () => {
        const failing = stubDb({ claim_chat_turn: { data: null, error: new Error("down") } });
        expect(await claimTurn(failing.db, { surface: "chat", chatId: "c", turnId: "t", actorUserId: "u", actorRole: null }))
            .toMatchObject({ ok: false, reason: "error" });
        const empty = stubDb({ claim_chat_turn: { data: [], error: null } });
        expect(await claimTurn(empty.db, { surface: "chat", chatId: "c", turnId: "t", actorUserId: "u", actorRole: null }))
            .toMatchObject({ ok: false, reason: "error" });
    });

    it("logs failed renewals and releases without throwing", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const { db } = stubDb({
            claim_chat_turn: { data: [granted], error: null },
            renew_chat_turn: { data: null, error: new Error("renew down") },
            release_chat_turn: { data: null, error: new Error("release down") },
        });
        const t = timers();
        const result = await claimTurn(db, { surface: "chat", chatId: "c", turnId: "turn-1", actorUserId: "u", actorRole: null }, t);
        if (!result.ok) throw new Error("not claimed");
        t.tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await result.claim.release();
        expect(log).toHaveBeenCalledWith("[turn-claims] renew failed", expect.anything());
        expect(log).toHaveBeenCalledWith("[turn-claims] release failed", expect.anything());

        const throwing = {
            rpc: vi.fn((name: string) =>
                name === "claim_chat_turn" ? Promise.resolve({ data: [granted], error: null }) : Promise.reject(new Error("socket")),
            ),
        } as unknown as Db;
        const again = await claimTurn(throwing, { surface: "chat", chatId: "c", turnId: "turn-1", actorUserId: "u", actorRole: null }, timers());
        if (!again.ok) throw new Error("not claimed");
        await expect(again.claim.release()).resolves.toBeUndefined();
        log.mockRestore();
    });

    it("uses the real timers by default and does not keep the process alive", async () => {
        const { db } = stubDb({ claim_chat_turn: { data: [granted], error: null } });
        const result = await claimTurn(db, { surface: "chat", chatId: "c", turnId: "turn-1", actorUserId: "u", actorRole: null });
        if (!result.ok) throw new Error("not claimed");
        await result.claim.release();
    });
});

describe("createTurnAdmission", () => {
    it("admits, hands over the claim and role, and abandons on request", async () => {
        const { db, calls } = stubDb({ claim_chat_turn: { data: [granted], error: null } });
        const admission = createTurnAdmission(db, { surface: "chat", userId: "partner", turnId: "turn-1" });
        expect(admission.claim()).toBeNull();
        expect(await admission.admit("chat-1", "owner")).toBeNull();
        expect(admission.role()).toBe("owner");
        expect(admission.claim()?.turnId).toBe("turn-1");
        await admission.abandon();
        expect(admission.claim()).toBeNull();
        expect(calls.some((call) => call.name === "release_chat_turn")).toBe(true);
        await admission.abandon();
    });

    it("turns a held thread into a 409 naming the holder, and an error into an internal failure", async () => {
        const held = stubDb({ claim_chat_turn: { data: [{ ...granted, granted: false }], error: null } });
        expect(await createTurnAdmission(held.db, { surface: "chat", userId: "associate", turnId: "turn-2" }).admit("chat-1", "editor"))
            .toEqual({
                ok: false,
                status: 409,
                code: "turn_in_progress",
                detail: "A response is already being generated for this chat.",
                generating: { user_id: "partner", since: "2026-10-10T07:00:00Z" },
            });
        const broken = stubDb({ claim_chat_turn: { data: null, error: new Error("down") } });
        expect(await createTurnAdmission(broken.db, { surface: "chat", userId: "u", turnId: "t" }).admit("chat-1", null))
            .toMatchObject({ ok: false, internal: true });
    });
});

describe("currentTurnHolder", () => {
    function tableDb(result: { data: unknown; error: unknown }) {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq", "gt"]) query[method] = vi.fn(() => query);
        query.maybeSingle = vi.fn(() => Promise.resolve(result));
        return { from: vi.fn(() => query) } as unknown as Db;
    }

    it("returns the live holder, or null when free or unreadable", async () => {
        const live = tableDb({
            data: { turn_id: "turn-1", actor_user_id: "partner", actor_role: "owner", claimed_at: "t0", expires_at: "t1" },
            error: null,
        });
        expect(await currentTurnHolder(live, "chat", "chat-1")).toEqual({
            turnId: "turn-1",
            actorUserId: "partner",
            actorRole: "owner",
            claimedAt: "t0",
        });
        expect(await currentTurnHolder(tableDb({ data: null, error: null }), "chat", "chat-1")).toBeNull();
        expect(await currentTurnHolder(tableDb({ data: null, error: new Error("x") }), "chat", "chat-1")).toBeNull();
    });
});
