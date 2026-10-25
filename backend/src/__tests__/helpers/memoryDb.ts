/**
 * A small in-memory stand-in for the query builder, for suites that need
 * real filtering across several calls (insert a row, then find it by a
 * column) rather than a script of answers. It supports the subset the code
 * under test uses: select/insert/update/delete with eq, is, in, order, limit,
 * single and maybeSingle. Rows are plain objects; inserted rows get an `id`
 * when they have none and a `created_at` when the table's rows carry one.
 */
import type { Db } from "../../lib/db";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export function memoryDb(seed: Record<string, Row[]> = {}) {
    const tables = new Map<string, Row[]>(
        Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]),
    );
    const table = (name: string) => {
        if (!tables.has(name)) tables.set(name, []);
        return tables.get(name)!;
    };
    let clock = 0;

    const from = (name: string) => {
        let op: "select" | "insert" | "update" | "delete" = "select";
        let payload: Row | Row[] | null = null;
        const filters: Filter[] = [];
        let order: { column: string; ascending: boolean } | null = null;
        let limit: number | null = null;
        let returning = false;

        const run = (): { data: unknown; error: unknown } => {
            const rows = table(name);
            if (op === "insert") {
                const inserted = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({
                    id: crypto.randomUUID(),
                    created_at: new Date(Date.UTC(2026, 9, 24, 0, 0, clock++)).toISOString(),
                    ...r,
                }));
                rows.push(...inserted);
                return { data: Array.isArray(payload) ? inserted : inserted[0], error: null };
            }
            let matched = rows.filter((r) => filters.every((f) => f(r)));
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload);
                return { data: returning ? matched : null, error: null };
            }
            if (op === "delete") {
                tables.set(name, rows.filter((r) => !matched.includes(r)));
                return { data: null, error: null };
            }
            if (order) {
                const { column, ascending } = order;
                matched = [...matched].sort((a, b) =>
                    String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : String(a[column]) > String(b[column]) ? (ascending ? 1 : -1) : 0,
                );
            }
            if (limit !== null) matched = matched.slice(0, limit);
            return { data: matched.map((r) => ({ ...r })), error: null };
        };

        const one = (strict: boolean) => {
            const result = run();
            const list = Array.isArray(result.data) ? result.data : [result.data];
            const row = list[0] ?? null;
            if (strict && !row) return Promise.resolve({ data: null, error: { message: "no rows" } });
            return Promise.resolve({ data: row, error: null });
        };

        const builder: Record<string, unknown> = {
            select: () => {
                if (op !== "select") returning = true;
                return builder;
            },
            insert: (rows: Row | Row[]) => {
                op = "insert";
                payload = rows;
                return builder;
            },
            update: (patch: Row) => {
                op = "update";
                payload = patch;
                return builder;
            },
            delete: () => {
                op = "delete";
                return builder;
            },
            eq: (column: string, value: unknown) => {
                filters.push((r) => r[column] === value);
                return builder;
            },
            is: (column: string, value: unknown) => {
                filters.push((r) => (r[column] ?? null) === value);
                return builder;
            },
            in: (column: string, values: unknown[]) => {
                filters.push((r) => values.includes(r[column]));
                return builder;
            },
            order: (column: string, opts?: { ascending?: boolean }) => {
                order = { column, ascending: opts?.ascending ?? true };
                return builder;
            },
            limit: (n: number) => {
                limit = n;
                return builder;
            },
            single: () => one(true),
            maybeSingle: () => one(false),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(run()).then(resolve, reject),
        };
        return builder;
    };

    return {
        db: { from } as unknown as Db,
        rows: (name: string) => table(name),
    };
}
