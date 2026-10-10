import { beforeEach, describe, expect, it } from "vitest";

import { clearAssignmentCache, resolveWorkstation } from "../assignments";
import { targetForVm, workstationPool } from "../config";

// A stand-in for workstation_assignments: the few query shapes the
// assignment code uses, with the table's two unique keys enforced.
function fakeDb(rows: { vm: string; user_id: string }[] = []) {
  const db = {
    rows,
    from(table: string) {
      expect(table).toBe("workstation_assignments");
      let filter: (row: { vm: string; user_id: string }) => boolean = () => true;
      let insert: { vm: string; user_id: string } | null = null;
      const query = {
        select: () => query,
        eq: (column: "user_id", value: string) => ((filter = (row) => row[column] === value), query),
        in: (column: "vm", values: string[]) => ((filter = (row) => values.includes(row[column])), query),
        upsert: (value: { vm: string; user_id: string }) => ((insert = value), query),
        maybeSingle: async () => ({ data: rows.find(filter) ?? null, error: null }),
        then: (resolve: (value: unknown) => void) => {
          if (!insert) return resolve({ data: rows.filter(filter), error: null });
          if (rows.some((row) => row.user_id === insert!.user_id)) return resolve({ data: null, error: { code: "23505" } });
          if (rows.some((row) => row.vm === insert!.vm)) return resolve({ data: [], error: null });
          rows.push(insert);
          return resolve({ data: [{ vm: insert.vm }], error: null });
        },
      };
      return query;
    },
  };
  return db;
}

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
    expect(db.rows).toEqual([
      { vm: "ws-01", user_id: "alice" },
      { vm: "ws-02", user_id: "bob" },
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
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "x" } }) }) }) }) };
    expect(await resolveWorkstation(broken as never, "alice", env)).toBeNull();
  });
});
