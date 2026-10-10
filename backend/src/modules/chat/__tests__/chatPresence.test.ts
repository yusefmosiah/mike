import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/db";
import { threadPresence } from "../chat.presence";

// The chat read's attribution: each author's name and email, and who holds
// the thread's turn claim now.
function presenceDb(options: {
    claim?: Record<string, unknown> | null;
    profiles?: unknown;
    throwOn?: string;
}) {
    const queried: Array<{ table: string; ids?: unknown }> = [];
    const db = {
        from: vi.fn((table: string) => {
            if (table === options.throwOn) throw new Error("db down");
            const query: Record<string, unknown> = {};
            for (const method of ["select", "eq", "gt"]) query[method] = vi.fn(() => query);
            query.maybeSingle = vi.fn(() => Promise.resolve({ data: options.claim ?? null, error: null }));
            query.in = vi.fn((_column: string, ids: unknown) => {
                queried.push({ table, ids });
                return Promise.resolve({ data: options.profiles ?? [], error: null });
            });
            return query;
        }),
    } as unknown as Db;
    return { db, queried };
}

describe("threadPresence", () => {
    it("names every author on the transcript and the person generating now", async () => {
        const { db, queried } = presenceDb({
            claim: { turn_id: "t", actor_user_id: "third", actor_role: "editor", claimed_at: "2026-10-10T07:00:00Z" },
            profiles: [
                { user_id: "partner", email: "partner@firm.test", display_name: " Pat Partner " },
                { user_id: "associate", email: "assoc@firm.test", display_name: "" },
                { user_id: "third", email: null, display_name: null },
            ],
        });
        const presence = await threadPresence(db, "chat-1", [
            { id: "m1", author_user_id: "partner" },
            { id: "m2", author_user_id: null },
            { id: "m3", author_user_id: "associate" },
            { id: "m4", author_user_id: "partner" },
        ]);
        expect(queried[0].ids).toEqual(["partner", "associate", "third"]);
        expect(presence).toEqual({
            authors: {
                partner: { name: "Pat Partner", email: "partner@firm.test" },
                associate: { name: null, email: "assoc@firm.test" },
                third: { name: null, email: null },
            },
            generating: { user_id: "third", since: "2026-10-10T07:00:00Z" },
        });
    });

    it("skips the profile lookup when nobody is named, and reports a free thread", async () => {
        const { db, queried } = presenceDb({});
        expect(await threadPresence(db, "chat-1", [{ id: "m1" }])).toEqual({ authors: {}, generating: null });
        expect(queried).toEqual([]);
    });

    it("never fails the chat read", async () => {
        const unreadable = presenceDb({ profiles: { not: "rows" } });
        expect(await threadPresence(unreadable.db, "chat-1", [{ author_user_id: "partner" }])).toEqual({
            authors: {},
            generating: null,
        });
        const broken = presenceDb({ throwOn: "user_profiles" });
        expect(await threadPresence(broken.db, "chat-1", [{ author_user_id: "partner" }])).toEqual({
            authors: {},
            generating: null,
        });
    });
});
