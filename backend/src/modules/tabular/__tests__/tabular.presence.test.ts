import { describe, expect, it } from "vitest";
import { withGenerating, type ReviewChatSummary } from "../tabular.chats";

const chat = (id: string): ReviewChatSummary => ({
    id,
    title: id,
    model: null,
    reasoning_level: null,
    created_at: "",
    updated_at: "",
    user_id: "partner",
});

// The two reads withGenerating makes: unexpired tabular claims, then profiles.
function fakeDb(claims: Array<{ chat_id: string; actor_user_id: string | null; claimed_at: string }>) {
    const seen: Array<{ table: string; filters: unknown[] }> = [];
    return {
        seen,
        from(table: string) {
            const filters: unknown[] = [];
            const query = {
                select: () => query,
                eq: (...args: unknown[]) => (filters.push(["eq", ...args]), query),
                in: (...args: unknown[]) => (filters.push(["in", ...args]), query),
                gt: (...args: unknown[]) => (filters.push(["gt", ...args]), query),
                then: (resolve: (value: unknown) => void) => {
                    seen.push({ table, filters });
                    resolve({
                        data: table === "chat_turn_claims"
                            ? claims
                            : [{ user_id: "associate", email: "associate@firm.example", display_name: "Alex Associate" }],
                        error: null,
                    });
                },
            };
            return query;
        },
    };
}

describe("review chat presence", () => {
    it("names whoever holds a chat's turn claim", async () => {
        const db = fakeDb([{ chat_id: "c2", actor_user_id: "associate", claimed_at: "2026-10-10T12:00:00Z" }]);
        const result = await withGenerating(db as never, [chat("c1"), chat("c2")]);
        expect(result.map((row) => row.generating)).toEqual([
            null,
            { id: "associate", name: "Alex Associate", email: "associate@firm.example", since: "2026-10-10T12:00:00Z" },
        ]);
        expect(db.seen[0].filters).toContainEqual(["eq", "surface", "tabular"]);
        expect(db.seen[0].filters.some((f) => Array.isArray(f) && f[0] === "gt" && f[1] === "expires_at")).toBe(true);
    });

    it("reads nothing for an empty list and leaves rows unchanged when the read fails", async () => {
        expect(await withGenerating({} as never, [])).toEqual([]);
        const broken = { from: () => { throw new Error("db down"); } };
        expect(await withGenerating(broken as never, [chat("c1")])).toEqual([chat("c1")]);
    });
});
