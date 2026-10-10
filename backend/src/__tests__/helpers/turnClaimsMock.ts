/**
 * The three turn-claim functions (migrations/20261010_01_firm_thread_handoff.sql)
 * as an in-memory table, for route tests whose db is a stub: a claim is
 * granted unless another unexpired turn holds the thread, and released claims
 * free it. `answerTurnClaimRpc` returns undefined for any other function, so
 * a stub can fall through to its own handling.
 */
type Claim = { turnId: string; actor: string | null; role: string | null; expiresAt: number };

const claims = new Map<string, Claim>();

export function resetTurnClaims(): void {
    claims.clear();
}

/** Who holds a thread in the stub, for assertions. */
export function heldTurnClaim(chatId: string, surface = "chat"): Claim | undefined {
    return claims.get(`${surface}:${chatId}`);
}

export function answerTurnClaimRpc(
    name: string,
    args: unknown,
): Promise<{ data: unknown; error: null }> | undefined {
    const a = (args ?? {}) as Record<string, unknown>;
    const key = `${a.p_surface}:${a.p_chat_id}`;
    if (name === "claim_chat_turn") {
        const held = claims.get(key);
        const now = Date.now();
        if (!held || held.expiresAt <= now || held.turnId === a.p_turn_id) {
            const claim = {
                turnId: String(a.p_turn_id),
                actor: (a.p_actor_user_id as string) ?? null,
                role: (a.p_actor_role as string) ?? null,
                expiresAt: now + Number(a.p_lease_seconds ?? 90) * 1000,
            };
            claims.set(key, claim);
            return Promise.resolve({ data: [row(true, claim)], error: null });
        }
        return Promise.resolve({ data: [row(false, held)], error: null });
    }
    if (name === "renew_chat_turn") {
        const held = claims.get(key);
        const ok = held?.turnId === a.p_turn_id;
        if (ok && held) held.expiresAt = Date.now() + Number(a.p_lease_seconds ?? 90) * 1000;
        return Promise.resolve({ data: ok, error: null });
    }
    if (name === "release_chat_turn") {
        if (claims.get(key)?.turnId === a.p_turn_id) claims.delete(key);
        return Promise.resolve({ data: null, error: null });
    }
    return undefined;
}

function row(granted: boolean, claim: Claim) {
    return {
        granted,
        holder_turn_id: claim.turnId,
        holder_actor_user_id: claim.actor,
        holder_actor_role: claim.role,
        holder_claimed_at: new Date().toISOString(),
    };
}
