import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAssignmentCache,
  poolVmFor,
  releaseIdleTemporaryWorkstations,
  resolveWorkstation,
} from "../assignments";
import { isTemporaryEmail, targetForVm, workstationPool } from "../config";

type Row = { vm: string; user_id: string; temporary?: boolean; last_used_at?: string; wiping?: boolean };

// A stand-in for workstation_assignments and user_profiles: the query shapes
// the assignment code uses, with the assignment table's two unique keys
// enforced and its column defaults filled in.
function fakeDb(seed: Row[] = [], emails: Record<string, string> = {}) {
  const rows = seed.map((row) => ({ temporary: false, last_used_at: new Date().toISOString(), wiping: false, ...row }));
  const db = {
    rows,
    from(table: string) {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      let write: { kind: "insert"; value: Row } | { kind: "update"; values: Partial<Row> } | { kind: "delete" } | null = null;
      let limit = Infinity;
      let order: string | null = null;
      const source = (): Record<string, unknown>[] =>
        table === "user_profiles"
          ? Object.entries(emails).map(([user_id, email]) => ({ user_id, email }))
          : (rows as Record<string, unknown>[]);
      const run = () => {
        if (write?.kind === "insert") {
          const value = { temporary: false, last_used_at: new Date().toISOString(), wiping: false, ...write.value };
          if (rows.some((row) => row.user_id === value.user_id)) return { data: null, error: { code: "23505" } };
          if (rows.some((row) => row.vm === value.vm)) return { data: [], error: null };
          rows.push(value);
          return { data: [{ vm: value.vm }], error: null };
        }
        let matched = source().filter((row) => filters.every((keep) => keep(row)));
        if (order) matched.sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
        matched = matched.slice(0, limit);
        if (write?.kind === "update") for (const row of matched) Object.assign(row, write.values);
        if (write?.kind === "delete") for (const row of matched) rows.splice(rows.indexOf(row as never), 1);
        return { data: matched.map((row) => ({ ...row })), error: null };
      };
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), query),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), query),
        lt: (column: string, value: string) => (filters.push((row) => String(row[column]) < value), query),
        order: (column: string) => ((order = column), query),
        limit: (count: number) => ((limit = count), query),
        upsert: (value: Row) => ((write = { kind: "insert", value }), query),
        update: (values: Partial<Row>) => ((write = { kind: "update", values }), query),
        delete: () => ((write = { kind: "delete" }), query),
        maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve(run()),
      };
      return query;
    },
  };
  return db;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const env = {
  WORKSTATION_POOL: "ws-01, ws-02, Bad Name",
  WORKSTATION_SSH_IDENTITY_FILE: "/run/key",
  WORKSTATION_SSH_PROXY_COMMAND: "node vsockProxy.js /run/mike-workstations/{vm}.sock 22",
  WORKSTATION_SNAPSHOT_SOCKET: "/run/mike-workstations/control.sock",
};

beforeEach(() => clearAssignmentCache());

describe("workstation config", () => {
  it("reads the pool and fills the VM name into the connection", () => {
    expect(workstationPool(env)).toEqual(["ws-01", "ws-02"]);
    expect(targetForVm("ws-02", env)).toMatchObject({
      host: "workstation",
      proxyCommand: "node vsockProxy.js /run/mike-workstations/ws-02.sock 22",
      snapshot: { socketPath: "/run/mike-workstations/control.sock", vm: "ws-02" },
    });
  });
});

describe("resolveWorkstation", () => {
  it("gives each account its own pool VM and keeps it", async () => {
    const db = fakeDb();
    expect((await resolveWorkstation(db as never, "alice", env))?.snapshot?.vm).toBe("ws-01");
    expect((await resolveWorkstation(db as never, "bob", env))?.snapshot?.vm).toBe("ws-02");
    clearAssignmentCache();
    expect((await resolveWorkstation(db as never, "alice", env))?.snapshot?.vm).toBe("ws-01");
    expect(db.rows.map(({ vm, user_id, temporary }) => ({ vm, user_id, temporary }))).toEqual([
      { vm: "ws-01", user_id: "alice", temporary: false },
      { vm: "ws-02", user_id: "bob", temporary: false },
    ]);
  });

  it("gives nothing once the pool is used up, and never reuses a VM", async () => {
    const db = fakeDb([
      { vm: "ws-01", user_id: "gone" },
      { vm: "ws-02", user_id: "bob" },
    ]);
    expect(await resolveWorkstation(db as never, "carol", env)).toBeNull();
    expect(db.rows).toHaveLength(2);
  });

  it("prefers the static VM of a listed account and needs no database for it", async () => {
    const target = await resolveWorkstation({} as never, "owner", { ...env, WORKSTATION_USER_IDS: "owner", WORKSTATION_NAME: "ws-owner" });
    expect(target?.proxyCommand).toBe("node vsockProxy.js /run/mike-workstations/ws-owner.sock 22");
  });

  it("gives nothing without a pool", async () => {
    expect(await resolveWorkstation({} as never, "alice", { ...env, WORKSTATION_POOL: "" })).toBeNull();
  });

  it("runs the turn without a VM when the lookup fails", async () => {
    const broken = { from: () => ({ update: () => ({ eq: () => ({ select: async () => ({ data: null, error: { code: "x" } }) }) }) }) };
    expect(await resolveWorkstation(broken as never, "alice", env)).toBeNull();
  });
});

describe("temporary VMs for test accounts", () => {
  const wipeOk = () => vi.fn(async (vm: string) => ({ ok: true as const, snapshot: vm }));

  it("knows test accounts by email", () => {
    expect(isTemporaryEmail("me+test@gmail.com", {})).toBe(true);
    expect(isTemporaryEmail("qa@example.com", {})).toBe(true);
    expect(isTemporaryEmail("e2e@mike.local", {})).toBe(true);
    expect(isTemporaryEmail("someone@gmail.com", {})).toBe(false);
    expect(isTemporaryEmail("someone@latest.com", {})).toBe(false);
    expect(isTemporaryEmail("me+test@gmail.com", { WORKSTATION_TEMPORARY_EMAILS: "off" })).toBe(false);
    expect(isTemporaryEmail("a@firm.com", { WORKSTATION_TEMPORARY_EMAILS: "@firm\\.com$" })).toBe(true);
  });

  it("marks a test account's VM temporary and records each turn", async () => {
    const db = fakeDb([], { tester: "qa@example.com" });
    expect(await poolVmFor(db as never, "tester", ["ws-01", "ws-02"], env, wipeOk())).toBe("ws-01");
    expect(db.rows[0]).toMatchObject({ vm: "ws-01", temporary: true });
    db.rows[0].last_used_at = ago(60);
    expect(await poolVmFor(db as never, "tester", ["ws-01", "ws-02"], env, wipeOk())).toBe("ws-01");
    expect(db.rows[0].last_used_at > ago(1)).toBe(true);
  });

  it("keeps a VM free for real accounts", async () => {
    const db = fakeDb([], { t1: "a@example.com", t2: "b@example.com", real: "partner@gmail.com" });
    const pool = ["ws-01", "ws-02"];
    expect(await poolVmFor(db as never, "t1", pool, env, wipeOk())).toBe("ws-01");
    // The limit is all but one of the pool, and t1's VM was used just now.
    expect(await poolVmFor(db as never, "t2", pool, env, wipeOk())).toBeNull();
    expect(await poolVmFor(db as never, "real", pool, env, wipeOk())).toBe("ws-02");
  });

  it("takes back an idle temporary VM, wiped, when the pool is short", async () => {
    const db = fakeDb([{ vm: "ws-01", user_id: "t1", temporary: true, last_used_at: ago(30) }], { t2: "b@example.com" });
    const wipe = wipeOk();
    expect(await poolVmFor(db as never, "t2", ["ws-01", "ws-02"], env, wipe)).toBe("ws-01");
    expect(wipe).toHaveBeenCalledWith("ws-01");
    expect(db.rows).toEqual([expect.objectContaining({ vm: "ws-01", user_id: "t2", temporary: true, wiping: false })]);
  });

  it("never takes back a real account's VM or a temporary one in use", async () => {
    const db = fakeDb([
      { vm: "ws-01", user_id: "real" },
      { vm: "ws-02", user_id: "t1", temporary: true, last_used_at: ago(5) },
    ], { newcomer: "new@gmail.com" });
    const wipe = wipeOk();
    expect(await poolVmFor(db as never, "newcomer", ["ws-01", "ws-02"], env, wipe)).toBeNull();
    expect(wipe).not.toHaveBeenCalled();
  });

  it("sweeps idle temporary VMs back into the pool", async () => {
    const db = fakeDb([
      { vm: "ws-01", user_id: "real", last_used_at: ago(600) },
      { vm: "ws-02", user_id: "t1", temporary: true, last_used_at: ago(180) },
      { vm: "Bad Name", user_id: "t2", temporary: true, last_used_at: ago(180) },
    ]);
    const wipe = wipeOk();
    expect(await releaseIdleTemporaryWorkstations(db as never, env, wipe)).toBe(1);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(db.rows.map((row) => row.vm)).toEqual(["ws-01", "Bad Name"]);
    expect(await releaseIdleTemporaryWorkstations(db as never, env, null)).toBe(0);
  });

  it("leaves the VM with its account when the wipe fails, and gives nothing mid-wipe", async () => {
    const db = fakeDb([{ vm: "ws-02", user_id: "t1", temporary: true, last_used_at: ago(180) }]);
    const failing = vi.fn(async () => ({ ok: false as const, error: "wipe failed" }));
    expect(await releaseIdleTemporaryWorkstations(db as never, env, failing)).toBe(0);
    expect(db.rows[0]).toMatchObject({ user_id: "t1", wiping: false });
    db.rows[0].wiping = true;
    expect(await poolVmFor(db as never, "t1", ["ws-01", "ws-02"], env, failing)).toBeNull();
  });
});
