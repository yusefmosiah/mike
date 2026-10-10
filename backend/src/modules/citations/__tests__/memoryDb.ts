// An in-memory stand-in for the query builder, enough for the citation
// verifier: rows live in `tables`, outside any module, so a test can drop the
// modules (a process restart) and keep the data (the database).
import { randomUUID } from "node:crypto";
import type { Db } from "../../../lib/db";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type MemoryDb = { db: Db; tables: Record<string, Row[]> };

export function memoryDb(seed: Record<string, Row[]> = {}): MemoryDb {
    const tables: Record<string, Row[]> = {};
    for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
    const table = (name: string) => (tables[name] ??= []);

    function query(name: string) {
        const filters: Filter[] = [];
        let orderBy: Array<{ column: string; ascending: boolean }> = [];
        let limit: number | null = null;
        let mode: "select" | "update" | "delete" = "select";
        let patch: Row = {};
        let inserted: Row[] | null = null;

        const matching = () => table(name).filter((row) => filters.every((f) => f(row)));
        const run = (): { data: unknown; error: unknown } => {
            if (inserted) return { data: inserted, error: null };
            if (mode === "update") {
                const rows = matching();
                for (const row of rows) Object.assign(row, patch);
                return { data: rows, error: null };
            }
            if (mode === "delete") {
                const keep = table(name).filter((row) => !filters.every((f) => f(row)));
                tables[name] = keep;
                return { data: null, error: null };
            }
            let rows = matching().map((row) => ({ ...row }));
            for (const { column, ascending } of [...orderBy].reverse()) {
                rows = rows.sort((a, b) => {
                    const x = a[column] as string | number;
                    const y = b[column] as string | number;
                    return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
                });
            }
            if (limit !== null) rows = rows.slice(0, limit);
            return { data: rows, error: null };
        };

        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
            is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
            gt: (column: string, value: string) => (filters.push((row) => String(row[column]) > value), builder),
            in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
            order: (column: string, opts?: { ascending?: boolean }) => (
                orderBy.push({ column, ascending: opts?.ascending ?? true }), builder
            ),
            limit: (n: number) => ((limit = n), builder),
            update: (values: Row) => ((mode = "update"), (patch = values), builder),
            delete: () => ((mode = "delete"), builder),
            insert: (values: Row | Row[]) => {
                const rows = (Array.isArray(values) ? values : [values]).map((value) => ({
                    id: randomUUID(),
                    created_at: new Date().toISOString(),
                    ...value,
                }));
                table(name).push(...rows);
                inserted = rows.map((row) => ({ ...row }));
                return builder;
            },
            upsert: (value: Row, opts?: { onConflict?: string }) => {
                const keys = (opts?.onConflict ?? "id").split(",");
                const existing = table(name).find((row) => keys.every((key) => row[key] === value[key]));
                if (existing) {
                    Object.assign(existing, value);
                    inserted = [{ ...existing }];
                } else {
                    const row = { id: randomUUID(), ...value };
                    table(name).push(row);
                    inserted = [{ ...row }];
                }
                return builder;
            },
            maybeSingle: () => {
                const { data } = run();
                const rows = data as Row[] | null;
                return Promise.resolve({ data: rows?.[0] ?? null, error: null });
            },
            single: () => {
                const { data } = run();
                const rows = data as Row[] | null;
                return Promise.resolve(
                    rows?.[0] ? { data: rows[0], error: null } : { data: null, error: { message: "no row" } },
                );
            },
            then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve(run()).then(resolve, reject),
        };
        return builder;
    }

    const db = {
        from: (name: string) => query(name),
        rpc: () => Promise.resolve({ data: null, error: null }),
    } as unknown as Db;
    return { db, tables };
}
