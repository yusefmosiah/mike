import { describe, expect, it } from "vitest";
import {
    createTurnReconnectPolicy,
    TURN_RECONNECT_DEFAULTS,
    waitForReconnect,
} from "./turnReconnect";

describe("createTurnReconnectPolicy", () => {
    it("backs off from 400 ms to the ceiling while the server is down", () => {
        const policy = createTurnReconnectPolicy();
        const delays = [
            policy.next({ kind: "stream" }, 0),
            policy.next({ kind: "unreachable" }, 1_000),
            policy.next({ kind: "status", status: 503 }, 2_000),
            policy.next({ kind: "status", status: 502 }, 5_000),
            policy.next({ kind: "unreachable" }, 9_000),
            policy.next({ kind: "unreachable" }, 14_000),
        ];
        expect(delays).toEqual([400, 800, 1_600, 3_200, 5_000, 5_000]);
    });

    it("waits out a restart for the whole outage budget, then gives up", () => {
        const policy = createTurnReconnectPolicy();
        expect(policy.next({ kind: "stream" }, 0)).not.toBeNull();
        expect(
            policy.next({ kind: "unreachable" }, TURN_RECONNECT_DEFAULTS.outageBudgetMs),
        ).not.toBeNull();
        expect(
            policy.next({ kind: "unreachable" }, TURN_RECONNECT_DEFAULTS.outageBudgetMs + 1),
        ).toBeNull();
    });

    it("retries a 404 only briefly, while a restarted server re-registers its turns", () => {
        const policy = createTurnReconnectPolicy();
        policy.next({ kind: "unreachable" }, 0);
        expect(policy.next({ kind: "status", status: 404 }, 10_000)).not.toBeNull();
        expect(
            policy.next(
                { kind: "status", status: 404 },
                10_000 + TURN_RECONNECT_DEFAULTS.notFoundGraceMs,
            ),
        ).not.toBeNull();
        expect(
            policy.next(
                { kind: "status", status: 404 },
                10_001 + TURN_RECONNECT_DEFAULTS.notFoundGraceMs,
            ),
        ).toBeNull();
    });

    it("gives up at once on a refusal or a server error", () => {
        for (const status of [400, 401, 403, 409, 500]) {
            expect(
                createTurnReconnectPolicy().next({ kind: "status", status }, 0),
            ).toBeNull();
        }
    });

    it("starts over after the turn delivers frames again", () => {
        const policy = createTurnReconnectPolicy();
        policy.next({ kind: "stream" }, 0);
        policy.next({ kind: "unreachable" }, 1_000);
        policy.recovered();
        expect(policy.next({ kind: "stream" }, 10 * 60_000)).toBe(400);
    });
});

describe("waitForReconnect", () => {
    it("resolves after the delay", async () => {
        await expect(waitForReconnect(1)).resolves.toBeUndefined();
    });

    it("rejects as soon as the reader is stopped", async () => {
        const controller = new AbortController();
        const waiting = waitForReconnect(60_000, controller.signal);
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    });
});
