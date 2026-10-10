/**
 * Gives each account its own VM from the deployment's pool (WORKSTATION_POOL)
 * the first time it needs one, and remembers the choice in
 * workstation_assignments. A real account keeps its VM; a VM is never handed
 * to a second account while its disk holds the first one's files.
 *
 * Test accounts (config.ts, isTemporaryEmail) get temporary VMs instead:
 *  - at most `limit` at once, so real accounts always find one;
 *  - each turn records `last_used_at`;
 *  - once unused for `idleMs`, the sweep (releaseIdleTemporaryWorkstations,
 *    run by the worker runtime) asks the host to wipe the VM's disk and
 *    snapshots, then deletes the row, which returns the VM to the pool;
 *  - when the pool is short, a temporary VM unused for `reclaimMs` is wiped
 *    and handed over early.
 * A row is marked `wiping` while its wipe runs, so nobody is given the VM
 * half-wiped. A failed wipe clears the mark and leaves the row with its
 * account, and the next sweep tries again.
 */
import type { Db } from "../db";
import { safeError } from "../safeError";
import { isTemporaryEmail, staticWorkstationVm, targetForVm, temporaryPolicy, workstationPool } from "./config";
import type { WorkstationTarget } from "./exec";
import { requestWipe, type SnapshotResult } from "./snapshot";

type Env = Record<string, string | undefined>;
type Row = { vm: string; user_id: string; temporary: boolean; last_used_at: string; wiping: boolean };
export type WipeVm = (vm: string) => Promise<SnapshotResult>;

/** A real account's assignment never changes while the process runs, so each is read once. */
const permanent = new Map<string, string>();

export function clearAssignmentCache(): void {
  permanent.clear();
}

/** The account's VM, recording this turn on a temporary one; null when it has none. */
async function touchAssignment(db: Db, userId: string): Promise<Pick<Row, "vm" | "temporary" | "wiping"> | null> {
  const { data, error } = await db
    .from("workstation_assignments")
    .update({ last_used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .select("vm, temporary, wiping");
  if (error) throw new Error("workstation assignment lookup failed");
  return ((data ?? []) as Row[])[0] ?? null;
}

async function accountEmail(db: Db, userId: string): Promise<string | null> {
  const { data, error } = await db.from("user_profiles").select("email").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("account lookup failed");
  return (data as { email?: string | null } | null)?.email ?? null;
}

/** The host's wipe, or null when this deployment has no control socket (then nothing is wiped). */
export function hostWipe(env: Env = process.env): WipeVm | null {
  const socket = env.WORKSTATION_SNAPSHOT_SOCKET?.trim();
  return socket ? (vm) => requestWipe(socket, vm) : null;
}

/**
 * Wipe one temporary VM unused since `cutoff` and return it to the pool.
 * True when it was released; false when someone used it meanwhile, another
 * process is already wiping it, or the wipe failed.
 */
export async function releaseTemporaryVm(db: Db, vm: string, cutoff: Date, wipe: WipeVm): Promise<boolean> {
  const { data: claimed, error } = await db
    .from("workstation_assignments")
    .update({ wiping: true })
    .eq("vm", vm)
    .eq("temporary", true)
    .eq("wiping", false)
    .lt("last_used_at", cutoff.toISOString())
    .select("vm, user_id");
  if (error) throw new Error("workstation release failed");
  const row = ((claimed ?? []) as Row[])[0];
  if (!row) return false;
  const result = await wipe(vm);
  if (!result.ok) {
    console.error("[workstation] wiping a temporary VM failed; it stays with its account", { vm, error: result.error });
    await db.from("workstation_assignments").update({ wiping: false }).eq("vm", vm).eq("user_id", row.user_id);
    return false;
  }
  const { error: deleteError } = await db
    .from("workstation_assignments")
    .delete()
    .eq("vm", vm)
    .eq("user_id", row.user_id);
  if (deleteError) throw new Error("workstation release failed");
  console.info("[workstation] wiped and returned a temporary VM", { vm });
  return true;
}

/** Take back the least recently used temporary VM idle for `idleMs`, if any. */
async function reclaimOne(db: Db, pool: string[], idleMs: number, wipe: WipeVm | null): Promise<boolean> {
  if (!wipe) return false;
  const cutoff = new Date(Date.now() - idleMs);
  const { data, error } = await db
    .from("workstation_assignments")
    .select("vm")
    .in("vm", pool)
    .eq("temporary", true)
    .eq("wiping", false)
    .lt("last_used_at", cutoff.toISOString())
    .order("last_used_at", { ascending: true })
    .limit(3);
  if (error) throw new Error("workstation pool lookup failed");
  for (const { vm } of (data ?? []) as Row[]) {
    if (await releaseTemporaryVm(db, vm, cutoff, wipe)) return true;
  }
  return false;
}

async function takeFreeVm(db: Db, userId: string, pool: string[], temporary: boolean): Promise<string | null> {
  const { data: taken, error } = await db.from("workstation_assignments").select("vm").in("vm", pool);
  if (error) throw new Error("workstation pool lookup failed");
  const used = new Set(((taken ?? []) as Row[]).map((row) => row.vm));
  for (const vm of pool.filter((name) => !used.has(name))) {
    const { data: inserted, error: insertError } = await db
      .from("workstation_assignments")
      .upsert({ vm, user_id: userId, temporary }, { onConflict: "vm", ignoreDuplicates: true })
      .select("vm");
    if (insertError) {
      // Another request for this account won the race (user_id is unique).
      const raced = await touchAssignment(db, userId);
      if (raced) return raced.wiping ? null : raced.vm;
      throw new Error("workstation assignment failed");
    }
    if (Array.isArray(inserted) && inserted.length > 0) {
      console.info("[workstation] assigned a pool VM", { vm, temporary });
      return vm;
    }
    // Someone else took this VM in the meantime; try the next one.
  }
  return null;
}

/** The pool VM this account has, given now if it has none; null when there is none to give. */
export async function poolVmFor(
  db: Db,
  userId: string,
  pool: string[],
  env: Env = process.env,
  wipe: WipeVm | null = hostWipe(env),
): Promise<string | null> {
  const cached = permanent.get(userId);
  if (cached) return cached;
  const existing = await touchAssignment(db, userId);
  if (existing) {
    // A VM being wiped is gone; the account gets a fresh one once it is back.
    if (existing.wiping) return null;
    if (!existing.temporary) permanent.set(userId, existing.vm);
    return existing.vm;
  }

  const temporary = isTemporaryEmail(await accountEmail(db, userId), env);
  const policy = temporaryPolicy(pool.length, env);
  if (temporary) {
    const { data, error } = await db
      .from("workstation_assignments")
      .select("vm")
      .in("vm", pool)
      .eq("temporary", true);
    if (error) throw new Error("workstation pool lookup failed");
    if ((data ?? []).length >= policy.limit && !(await reclaimOne(db, pool, policy.reclaimMs, wipe))) {
      console.warn("[workstation] test accounts already hold their share of the pool", { limit: policy.limit });
      return null;
    }
  }

  let vm = await takeFreeVm(db, userId, pool, temporary);
  if (!vm && (await reclaimOne(db, pool, policy.reclaimMs, wipe))) {
    vm = await takeFreeVm(db, userId, pool, temporary);
  }
  if (!vm) {
    console.warn("[workstation] pool is used up", { size: pool.length });
    return null;
  }
  if (!temporary) permanent.set(userId, vm);
  return vm;
}

/**
 * Wipe and return every temporary VM unused for the idle period. Run on an
 * interval by the worker runtime; does nothing without a pool or a host
 * control socket. Returns how many VMs went back.
 */
export async function releaseIdleTemporaryWorkstations(
  db: Db,
  env: Env = process.env,
  wipe: WipeVm | null = hostWipe(env),
): Promise<number> {
  const pool = workstationPool(env);
  if (pool.length === 0 || !wipe) return 0;
  const cutoff = new Date(Date.now() - temporaryPolicy(pool.length, env).idleMs);
  const { data, error } = await db
    .from("workstation_assignments")
    .select("vm")
    .in("vm", pool)
    .eq("temporary", true)
    .eq("wiping", false)
    .lt("last_used_at", cutoff.toISOString());
  if (error) throw new Error("workstation pool lookup failed");
  let released = 0;
  for (const { vm } of (data ?? []) as Row[]) {
    if (await releaseTemporaryVm(db, vm, cutoff, wipe)) released += 1;
  }
  return released;
}

/**
 * The account's workstation: its static VM, else its pool VM. Null when it
 * has neither, or when the lookup fails (the turn then runs without one).
 */
export async function resolveWorkstation(
  db: Db,
  userId: string,
  env: Env = process.env,
): Promise<WorkstationTarget | null> {
  const staticVm = staticWorkstationVm(userId, env);
  if (staticVm !== null) return targetForVm(staticVm, env);
  const pool = workstationPool(env);
  if (pool.length === 0) return null;
  try {
    const vm = await poolVmFor(db, userId, pool, env);
    return vm ? targetForVm(vm, env) : null;
  } catch (error) {
    console.error("[workstation] could not resolve a VM", safeError(error));
    return null;
  }
}
