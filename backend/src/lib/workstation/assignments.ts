/**
 * Gives each account its own VM from the deployment's pool (WORKSTATION_POOL)
 * the first time it needs one, and remembers the choice in
 * workstation_assignments. An account keeps its VM; a VM is never handed to a
 * second account, because its disk holds the first one's files.
 */
import type { Db } from "../db";
import { safeError } from "../safeError";
import { staticWorkstationVm, targetForVm, workstationPool } from "./config";
import type { WorkstationTarget } from "./exec";

type Env = Record<string, string | undefined>;

/** Assignments never change while the process runs, so each is read once. */
const assigned = new Map<string, string>();

export function clearAssignmentCache(): void {
  assigned.clear();
}

async function assignedVm(db: Db, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("workstation_assignments")
    .select("vm")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("workstation assignment lookup failed");
  return (data as { vm?: string } | null)?.vm ?? null;
}

/** The pool VM this account has, given now if it has none; null when the pool is empty or used up. */
export async function poolVmFor(db: Db, userId: string, pool: string[]): Promise<string | null> {
  const cached = assigned.get(userId);
  if (cached) return cached;
  const existing = await assignedVm(db, userId);
  if (existing) {
    assigned.set(userId, existing);
    return existing;
  }
  const { data: taken, error } = await db.from("workstation_assignments").select("vm").in("vm", pool);
  if (error) throw new Error("workstation pool lookup failed");
  const used = new Set(((taken ?? []) as { vm: string }[]).map((row) => row.vm));
  for (const vm of pool.filter((name) => !used.has(name))) {
    const { data: inserted, error: insertError } = await db
      .from("workstation_assignments")
      .upsert({ vm, user_id: userId }, { onConflict: "vm", ignoreDuplicates: true })
      .select("vm");
    if (insertError) {
      // Another request for this account won the race (user_id is unique).
      const raced = await assignedVm(db, userId);
      if (raced) {
        assigned.set(userId, raced);
        return raced;
      }
      throw new Error("workstation assignment failed");
    }
    if (Array.isArray(inserted) && inserted.length > 0) {
      assigned.set(userId, vm);
      console.info("[workstation] assigned a pool VM", { vm });
      return vm;
    }
    // Someone else took this VM in the meantime; try the next one.
  }
  console.warn("[workstation] pool is used up", { size: pool.length });
  return null;
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
    const vm = await poolVmFor(db, userId, pool);
    return vm ? targetForVm(vm, env) : null;
  } catch (error) {
    console.error("[workstation] could not resolve a VM", safeError(error));
    return null;
  }
}
