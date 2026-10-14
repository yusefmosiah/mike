import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// The async export surface: POST /user/exports (schedule) + GET
// /user/exports/:id (poll). Two invariants are baselined here.
//
// 1. NO RATE LIMIT. Exports are not request-limited: scheduling several and
//    polling every couple of seconds while one builds must never answer 429.
//
// 2. NO-RUNNER TOPOLOGIES. With DB_JOBS_ENABLED=false nothing drains db_jobs.
//    A 202 there is a lie that also wedges the dedupe key forever, so the
//    route must refuse instead.
//
// ---------------------------------------------------------------------------
const { insertedJobs, dbJobsEnabled } = vi.hoisted(() => {
    return { insertedJobs: [] as unknown[], dbJobsEnabled: vi.fn(() => true) };
});

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of [
        "select",
        "update",
        "delete",
        "eq",
        "in",
        "is",
        "lt",
        "limit",
        "order",
    ])
        q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        if (table === "db_jobs") insertedJobs.push(payload);
        return q;
    });
    const result =
        table === "db_jobs"
            ? { data: { id: "job-1" }, error: null }
            : { data: null, error: null };
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
    return q;
}

vi.mock("../../lib/db", () => ({
    createDb: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
        auth: {
            getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
            admin: { deleteUser: vi.fn(async () => ({ error: null })) },
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        res.locals.token = "test-token";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/dbq/runner", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, dbJobsEnabled: () => dbJobsEnabled() };
});

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("async exports", () => {
    beforeEach(() => {
        insertedJobs.length = 0;
        dbJobsEnabled.mockReturnValue(true);
    });

    it("refuses to schedule when no runner will drain the queue", async () => {
        dbJobsEnabled.mockReturnValue(false);

        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "documents-zip", params: { document_ids: ["d1"] } });

        // A 202 here would be a receipt for work that cannot happen, and the
        // pending row would hold the dedupe key forever — locking the user out
        // of that export permanently, even after the runner comes back.
        expect(res.status).toBe(503);
        expect(insertedJobs).toHaveLength(0);
    });

    it("never refuses an export or its poll with 429", async () => {
        for (let i = 0; i < 12; i++) {
            const scheduled = await request(app)
                .post("/user/exports")
                .set(...AUTH)
                .send({ type: "account" });
            expect(scheduled.status).toBe(202);
        }
        for (let i = 0; i < 5; i++) {
            const poll = await request(app)
                .get("/user/exports/job-1")
                .set(...AUTH);
            expect(poll.status).not.toBe(429);
        }
    });
});
