// A throttle on guessing link names. A link's token is the only secret of an
// "anyone with the link" publication, so a client that keeps asking for names
// that do not exist is refused for a while, without a database lookup.
//
// Only misses count (a request that names no live publication: malformed,
// unknown, revoked or expired, all alike). Opening real links is never
// counted. Once an address has used up its misses, EVERY request from it on
// the content server gets 429 until the window ends, valid links included:
// telling the two apart would let a guesser learn which names exist.
//
// State is in memory, per process, like the other limiters here (the content
// server is one process). A restart forgets it; that costs a guesser nothing
// worth having at this rate (30 guesses per 10 minutes per address).

import { ipKeyGenerator } from "express-rate-limit";

export const MISS_LIMIT = 30;
export const MISS_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 50_000;

/** What the throttle reads of a request; structural so this file needs no express. */
export type ThrottleRequest = { ip?: string; socket: { remoteAddress?: string } };

type Entry = { misses: number; resetAt: number };

const entries = new Map<string, Entry>();

function clientKey(req: ThrottleRequest): string {
    return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function live(key: string, now: number): Entry | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.resetAt <= now) {
        entries.delete(key);
        return undefined;
    }
    return entry;
}

export function isThrottled(req: ThrottleRequest, now = Date.now()): boolean {
    return (live(clientKey(req), now)?.misses ?? 0) >= MISS_LIMIT;
}

export function recordMiss(req: ThrottleRequest, now = Date.now()): void {
    const key = clientKey(req);
    const entry = live(key, now);
    if (entry) {
        entry.misses += 1;
        return;
    }
    if (entries.size >= MAX_TRACKED) {
        // Drop expired entries; if the table is still full, drop the oldest.
        for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
        if (entries.size >= MAX_TRACKED) {
            const oldest = entries.keys().next().value;
            if (oldest !== undefined) entries.delete(oldest);
        }
    }
    entries.set(key, { misses: 1, resetAt: now + MISS_WINDOW_MS });
}

/** Refuses a throttled address before anything else runs. */
export function missThrottle<Res>(refuse: (res: Res) => void) {
    return (req: ThrottleRequest, res: Res, next: () => void): void => {
        if (isThrottled(req)) return void refuse(res);
        next();
    };
}

/** For tests. */
export function resetMissThrottle(): void {
    entries.clear();
}
