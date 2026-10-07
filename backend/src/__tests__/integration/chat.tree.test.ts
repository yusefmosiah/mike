import { describe, expect, it } from "vitest";
import {
    activePathIds,
    buildSiblingsIndex,
    latestMessageId,
    walkPathFromRows,
    type TreeRow,
} from "../../modules/chat/chat.tree";

// The tree helpers are pure over `id`, `parent_message_id` and `created_at`;
// the remaining columns only need to be present.
function row(
    id: string,
    role: string,
    parentMessageId: string | null,
    createdAt: string,
): TreeRow {
    return {
        id,
        role,
        content: null,
        files: null,
        workflow: null,
        parent_message_id: parentMessageId,
        created_at: createdAt,
    };
}

describe("walkPathFromRows", () => {
    it("returns the leaf's ancestry root-first", () => {
        const rows = [
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
            row("u2", "user", "a1", "2026-01-01T00:00:03Z"),
            row("a2", "assistant", "u2", "2026-01-01T00:00:04Z"),
        ];
        expect(walkPathFromRows(rows, "a2").map((r) => r.id)).toEqual([
            "u1",
            "a1",
            "u2",
            "a2",
        ]);
        expect(walkPathFromRows(rows, "a1").map((r) => r.id)).toEqual([
            "u1",
            "a1",
        ]);
    });

    it("keeps the first message as a null-parent root", () => {
        const rows = [
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
        ];
        const path = walkPathFromRows(rows, "a1");
        expect(path[0].id).toBe("u1");
        expect(path[0].parent_message_id).toBeNull();
    });

    it("never includes an abandoned sibling branch", () => {
        // u1 → a1 → { u2 → a2, u2b → a2b }; only the leaf's own chain is active.
        const rows = [
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
            row("u2", "user", "a1", "2026-01-01T00:00:03Z"),
            row("a2", "assistant", "u2", "2026-01-01T00:00:04Z"),
            row("u2b", "user", "a1", "2026-01-01T00:00:05Z"),
            row("a2b", "assistant", "u2b", "2026-01-01T00:00:06Z"),
        ];

        const path = walkPathFromRows(rows, "a2");
        expect(path.map((r) => r.id)).toEqual(["u1", "a1", "u2", "a2"]);
        const ids = activePathIds(path);
        expect(ids.has("a2")).toBe(true);
        expect(ids.has("u2b")).toBe(false);
        expect(ids.has("a2b")).toBe(false);

        const other = walkPathFromRows(rows, "a2b");
        expect(other.map((r) => r.id)).toEqual(["u1", "a1", "u2b", "a2b"]);
    });

    it("returns [] for a null or unknown leaf", () => {
        const rows = [row("u1", "user", null, "2026-01-01T00:00:01Z")];
        expect(walkPathFromRows(rows, null)).toEqual([]);
        expect(walkPathFromRows(rows, "missing")).toEqual([]);
    });

    it("terminates on a cyclic parent chain", () => {
        const rows = [
            row("x", "user", "y", "2026-01-01T00:00:01Z"),
            row("y", "assistant", "x", "2026-01-01T00:00:02Z"),
        ];
        expect(walkPathFromRows(rows, "x").map((r) => r.id)).toEqual([
            "y",
            "x",
        ]);
        const selfCycle = [row("z", "user", "z", "2026-01-01T00:00:01Z")];
        expect(walkPathFromRows(selfCycle, "z").map((r) => r.id)).toEqual([
            "z",
        ]);
    });

    it("caps the walk at 500 ancestors", () => {
        const rows: TreeRow[] = [];
        for (let i = 0; i < 600; i += 1) {
            rows.push(
                row(
                    `m${i}`,
                    i % 2 === 0 ? "user" : "assistant",
                    i === 0 ? null : `m${i - 1}`,
                    "2026-01-01T00:00:00Z",
                ),
            );
        }
        const path = walkPathFromRows(rows, "m599");
        expect(path).toHaveLength(500);
        // The cap keeps the 500 ancestors closest to the leaf.
        expect(path[0].id).toBe("m100");
        expect(path[499].id).toBe("m599");
    });
});

describe("latestMessageId", () => {
    it("picks the newest message, id breaking created_at ties", () => {
        const rows = [
            row("a", "user", null, "2026-01-01T00:00:02Z"),
            row("b", "assistant", "a", "2026-01-01T00:00:01Z"),
        ];
        expect(latestMessageId(rows)).toBe("a");

        const tied = [
            row("a", "user", null, "2026-01-01T00:00:01Z"),
            row("b", "assistant", "a", "2026-01-01T00:00:01Z"),
        ];
        expect(latestMessageId(tied)).toBe("b");
        expect(latestMessageId([])).toBeNull();
    });
});

describe("buildSiblingsIndex", () => {
    it("indexes each message's position and total among its siblings", () => {
        const rows = [
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
            row("u2", "user", "a1", "2026-01-01T00:00:03Z"),
            row("u2b", "user", "a1", "2026-01-01T00:00:04Z"),
        ];
        const index = buildSiblingsIndex(rows);
        expect(index.u2).toEqual({ index: 1, total: 2 });
        expect(index.u2b).toEqual({ index: 2, total: 2 });
        expect(index.u1).toEqual({ index: 1, total: 1 });
        expect(index.a1).toEqual({ index: 1, total: 1 });
    });

    it("restricts the index to requested ids but still counts every sibling", () => {
        const rows = [
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
            row("u2", "user", "a1", "2026-01-01T00:00:03Z"),
            row("u2b", "user", "a1", "2026-01-01T00:00:04Z"),
        ];
        const index = buildSiblingsIndex(rows, ["u2"]);
        expect(Object.keys(index)).toEqual(["u2"]);
        expect(index.u2).toEqual({ index: 1, total: 2 });
    });
});

// The migration's chronological backfill
// (20261007_01_chat_message_tree_branching.sql) links every pre-tree
// user/assistant message to the most recent earlier message of the OPPOSITE
// role: assistant → user, user → assistant. In an alternating transcript that
// is the preceding row; the first message keeps a null parent, already-linked
// rows and other roles are left alone. This reference implementation pins
// those semantics so the SQL's window functions have an executable
// description to be checked against.
function backfillParentLinks(rows: TreeRow[]): TreeRow[] {
    const ordered = [...rows].sort((a, b) =>
        a.created_at === b.created_at
            ? a.id.localeCompare(b.id)
            : a.created_at.localeCompare(b.created_at),
    );
    const linked: TreeRow[] = [];
    for (const current of ordered) {
        let parentMessageId = current.parent_message_id;
        if (parentMessageId === null && current.role === "assistant") {
            parentMessageId =
                [...linked].reverse().find((r) => r.role === "user")?.id ?? null;
        } else if (parentMessageId === null && current.role === "user") {
            parentMessageId =
                [...linked].reverse().find((r) => r.role === "assistant")?.id ??
                null;
        }
        linked.push({ ...current, parent_message_id: parentMessageId });
    }
    return linked;
}

describe("chronological backfill semantics", () => {
    it("links a legacy linear transcript into one chain", () => {
        const linked = backfillParentLinks([
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", null, "2026-01-01T00:00:02Z"),
            row("u2", "user", null, "2026-01-01T00:00:03Z"),
            row("a2", "assistant", null, "2026-01-01T00:00:04Z"),
        ]);
        expect(linked.map((r) => [r.id, r.parent_message_id])).toEqual([
            ["u1", null],
            ["a1", "u1"],
            ["u2", "a1"],
            ["a2", "u2"],
        ]);
    });

    it("links to the preceding opposite-role message when roles repeat", () => {
        const linked = backfillParentLinks([
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", null, "2026-01-01T00:00:02Z"),
            row("u2", "user", null, "2026-01-01T00:00:03Z"),
            row("u2b", "user", null, "2026-01-01T00:00:04Z"),
            row("a2", "assistant", null, "2026-01-01T00:00:05Z"),
        ]);
        // u2b's preceding assistant is a1 (not u2), and a2 hangs off u2b —
        // u2 and u2b become siblings, which is exactly the branch shape.
        expect(linked.map((r) => [r.id, r.parent_message_id])).toEqual([
            ["u1", null],
            ["a1", "u1"],
            ["u2", "a1"],
            ["u2b", "a1"],
            ["a2", "u2b"],
        ]);
    });

    it("leaves rows that already have a parent untouched", () => {
        const linked = backfillParentLinks([
            row("u1", "user", null, "2026-01-01T00:00:01Z"),
            row("a1", "assistant", "u1", "2026-01-01T00:00:02Z"),
        ]);
        expect(linked[1].parent_message_id).toBe("u1");
    });
});
