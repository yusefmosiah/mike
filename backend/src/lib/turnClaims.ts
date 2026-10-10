// One generating turn per thread, across every backend replica
// (goals/mission-5-firm-thread-handoff.md).
//
// lib/assistantTurnRuns.ts refuses a second turn inside one process; this is
// the same rule fenced in Postgres (public.claim_chat_turn), so two people
// sending into one thread through different replicas still get one run. A
// claim names the turn, whose send started it and the role they held. It is
// a lease: the process renews it while the turn runs and releases it when the
// turn ends; a process that dies stops renewing and the claim lapses, so a
// crash cannot leave the thread stuck. The same turn may claim again, which
// is how a restart resumes it.
import type { Db } from "./db";
import { safeError } from "./safeError";

export type TurnClaimSurface = "chat" | "tabular" | "word";

/** Seconds a claim lives without renewal. */
export const TURN_CLAIM_LEASE_SECONDS = 90;
/** How often a running turn renews its claim. */
export const TURN_CLAIM_RENEW_MS = 30_000;

export type TurnClaimHolder = {
    turnId: string;
    actorUserId: string | null;
    actorRole: string | null;
    claimedAt: string | null;
};

/** A held claim: renewed until released. */
export type TurnClaim = {
    readonly surface: TurnClaimSurface;
    readonly chatId: string;
    readonly turnId: string;
    /** Ends the claim and stops renewing it. Never throws. */
    release(): Promise<void>;
};

export type ClaimTurnResult =
    | { ok: true; claim: TurnClaim }
    | { ok: false; reason: "held"; holder: TurnClaimHolder }
    | { ok: false; reason: "error"; error: unknown };

type ClaimRow = {
    granted: boolean;
    holder_turn_id: string | null;
    holder_actor_user_id: string | null;
    holder_actor_role: string | null;
    holder_claimed_at: string | null;
};

export async function claimTurn(
    db: Db,
    args: {
        surface: TurnClaimSurface;
        chatId: string;
        turnId: string;
        actorUserId: string;
        actorRole: string | null;
    },
    deps: {
        renewMs?: number;
        setInterval?: typeof setInterval;
        clearInterval?: typeof clearInterval;
    } = {},
): Promise<ClaimTurnResult> {
    const { data, error } = await db.rpc("claim_chat_turn", {
        p_surface: args.surface,
        p_chat_id: args.chatId,
        p_turn_id: args.turnId,
        p_actor_user_id: args.actorUserId,
        p_actor_role: args.actorRole,
        p_lease_seconds: TURN_CLAIM_LEASE_SECONDS,
    });
    if (error) return { ok: false, reason: "error", error };
    const row = (Array.isArray(data) ? data[0] : data) as ClaimRow | undefined;
    if (!row) return { ok: false, reason: "error", error: new Error("claim_chat_turn returned no row") };
    if (!row.granted) {
        return {
            ok: false,
            reason: "held",
            holder: {
                turnId: row.holder_turn_id ?? "",
                actorUserId: row.holder_actor_user_id,
                actorRole: row.holder_actor_role,
                claimedAt: row.holder_claimed_at,
            },
        };
    }

    const every = deps.setInterval ?? setInterval;
    const stop = deps.clearInterval ?? clearInterval;
    const renewal = every(() => {
        void db
            .rpc("renew_chat_turn", {
                p_surface: args.surface,
                p_chat_id: args.chatId,
                p_turn_id: args.turnId,
                p_lease_seconds: TURN_CLAIM_LEASE_SECONDS,
            })
            .then(({ error: renewError }) => {
                if (renewError) console.error("[turn-claims] renew failed", safeError(renewError));
            });
    }, deps.renewMs ?? TURN_CLAIM_RENEW_MS);
    // A renewal timer must never keep a stopping process alive.
    (renewal as { unref?: () => void }).unref?.();

    let released = false;
    return {
        ok: true,
        claim: {
            surface: args.surface,
            chatId: args.chatId,
            turnId: args.turnId,
            async release() {
                if (released) return;
                released = true;
                stop(renewal);
                try {
                    const { error: releaseError } = await db.rpc("release_chat_turn", {
                        p_surface: args.surface,
                        p_chat_id: args.chatId,
                        p_turn_id: args.turnId,
                    });
                    if (releaseError) console.error("[turn-claims] release failed", safeError(releaseError));
                } catch (caught) {
                    // The lease lapses on its own.
                    console.error("[turn-claims] release failed", safeError(caught));
                }
            },
        },
    };
}

/** Who is generating in a thread now, if anyone (an unexpired claim). */
export async function currentTurnHolder(
    db: Db,
    surface: TurnClaimSurface,
    chatId: string,
): Promise<TurnClaimHolder | null> {
    const { data, error } = await db
        .from("chat_turn_claims")
        .select("turn_id, actor_user_id, actor_role, claimed_at, expires_at")
        .eq("surface", surface)
        .eq("chat_id", chatId)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (error || !data) return null;
    const row = data as { turn_id: string; actor_user_id: string | null; actor_role: string | null; claimed_at: string | null };
    return {
        turnId: row.turn_id,
        actorUserId: row.actor_user_id,
        actorRole: row.actor_role,
        claimedAt: row.claimed_at,
    };
}

export type TurnRefusal =
    | {
          ok: false;
          status: 409;
          code: "turn_in_progress";
          detail: string;
          generating: { user_id: string | null; since: string | null };
      }
    | { ok: false; internal: true; error: unknown };

/**
 * One turn's admission, for a prepare step: `admit` claims the thread once it
 * is known (and before anything is written to it), `claim` and `role` hand
 * the outcome to whoever drives the turn, and `abandon` releases the claim
 * when preparation fails after admitting.
 */
export function createTurnAdmission(
    db: Db,
    args: { surface: TurnClaimSurface; userId: string; turnId: string },
) {
    let claim: TurnClaim | null = null;
    let role: string | null = null;
    return {
        async admit(chatId: string, actorRole: string | null): Promise<TurnRefusal | null> {
            role = actorRole;
            const claimed = await claimTurn(db, {
                surface: args.surface,
                chatId,
                turnId: args.turnId,
                actorUserId: args.userId,
                actorRole,
            });
            if (claimed.ok) {
                claim = claimed.claim;
                return null;
            }
            if (claimed.reason === "error") return { ok: false, internal: true, error: claimed.error };
            return {
                ok: false,
                status: 409,
                code: "turn_in_progress",
                detail: "A response is already being generated for this chat.",
                generating: { user_id: claimed.holder.actorUserId, since: claimed.holder.claimedAt },
            };
        },
        claim: (): TurnClaim | null => claim,
        role: (): string | null => role,
        async abandon(): Promise<void> {
            await claim?.release();
            claim = null;
        },
    };
}
