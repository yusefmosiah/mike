/**
 * When a reader of an assistant turn reconnects after its stream breaks.
 *
 * Shared by the web chat, the tabular review chat and the Word pane, which
 * each read turns with their own frame handling. A dropped connection is
 * retried quickly. A server that is down (a deploy or restart) is waited out:
 * on startup the server resumes the turns it was generating
 * (backend/src/turnResumers.ts), so a reader that keeps asking re-attaches to
 * the same answer instead of failing until the page is reloaded.
 */

/** Why the last attempt to read or resume the turn failed. */
export type TurnReconnectFailure =
    /** The open stream ended or broke before the turn's last frame. */
    | { kind: "stream" }
    /** The resume request never reached a server (the fetch itself threw). */
    | { kind: "unreachable" }
    /** The resume request was answered with a non-2xx status. */
    | { kind: "status"; status: number };

export type TurnReconnectOptions = {
    /** Longest the reader waits out an outage before giving up. */
    outageBudgetMs?: number;
    /**
     * How long a 404 is retried. A restarted server answers before it has
     * re-registered the turns it resumes, so a short run of 404s is expected;
     * a turn that was not resumed stays 404 and the failure surfaces.
     */
    notFoundGraceMs?: number;
    /** Ceiling of the backoff between attempts. */
    maxDelayMs?: number;
};

export const TURN_RECONNECT_DEFAULTS = {
    outageBudgetMs: 3 * 60_000,
    notFoundGraceMs: 15_000,
    maxDelayMs: 5_000,
} as const;

/** Gateway answers that mean the backend is down or restarting. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

export type TurnReconnectPolicy = {
    /**
     * The delay before the next resume attempt after `failure`, or null when
     * the reader should give up and surface the failure.
     */
    next: (failure: TurnReconnectFailure, now?: number) => number | null;
    /** The turn delivered frames again: any outage is over. */
    recovered: () => void;
};

export function createTurnReconnectPolicy(
    options: TurnReconnectOptions = {},
): TurnReconnectPolicy {
    const outageBudgetMs =
        options.outageBudgetMs ?? TURN_RECONNECT_DEFAULTS.outageBudgetMs;
    const notFoundGraceMs =
        options.notFoundGraceMs ?? TURN_RECONNECT_DEFAULTS.notFoundGraceMs;
    const maxDelayMs = options.maxDelayMs ?? TURN_RECONNECT_DEFAULTS.maxDelayMs;

    let attempt = 0;
    let outageSince: number | null = null;
    let notFoundSince: number | null = null;

    return {
        next(failure, now = Date.now()) {
            if (failure.kind === "status") {
                if (failure.status === 404) {
                    notFoundSince ??= now;
                    if (now - notFoundSince > notFoundGraceMs) return null;
                } else if (!UNAVAILABLE_STATUSES.has(failure.status)) {
                    // Refused (401, 403) or failed (500): asking again will
                    // not change the answer.
                    return null;
                }
            }
            outageSince ??= now;
            if (now - outageSince > outageBudgetMs) return null;
            // 400 ms, 800 ms, 1.6 s, 3.2 s, then every maxDelayMs.
            const delay = Math.min(maxDelayMs, 400 * 2 ** attempt);
            attempt += 1;
            return delay;
        },
        recovered() {
            attempt = 0;
            outageSince = null;
            notFoundSince = null;
        },
    };
}

/** Resolve after `ms`, or reject with the signal's reason once it aborts. */
export function waitForReconnect(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abortError = () =>
            signal?.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
