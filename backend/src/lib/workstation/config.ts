/**
 * Which workstation VM, if any, a user's turns run in.
 *
 * Two ways in, both from the environment:
 *  - WORKSTATION_USER_IDS names accounts that use the VM WORKSTATION_NAME
 *    (the owner's VM on staging).
 *  - WORKSTATION_POOL lists VMs given out one per account, recorded in
 *    workstation_assignments (./assignments.ts), so every account gets its
 *    own VM while the pool lasts.
 * There is deliberately no default that hands every user the same VM.
 *
 * Test accounts (email matching WORKSTATION_TEMPORARY_EMAILS) get pool VMs
 * marked temporary: wiped and returned once idle, see ./assignments.ts.
 *
 * The connection settings are shared; `{vm}` in WORKSTATION_SSH_PROXY_COMMAND
 * or WORKSTATION_SSH_HOST stands for the VM's name.
 */
import type { WorkstationTarget } from "./exec";

type Env = Record<string, string | undefined>;

const VM_NAME = /^[a-z0-9-]{1,32}$/;

const list = (value: string | undefined) =>
  (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * The VM named in WORKSTATION_NAME for an account in WORKSTATION_USER_IDS:
 * null for other accounts, "" when the name is not set (a development VM,
 * which has no host snapshot service).
 */
export function staticWorkstationVm(userId: string, env: Env = process.env): string | null {
  if (!list(env.WORKSTATION_USER_IDS).includes(userId)) return null;
  return env.WORKSTATION_NAME?.trim() ?? "";
}

/** The pool's VM names, in the order they are given out. */
export function workstationPool(env: Env = process.env): string[] {
  return list(env.WORKSTATION_POOL).filter((vm) => VM_NAME.test(vm));
}

/**
 * Emails of test accounts, whose pool VMs are temporary: `+test` in the
 * local part, or a reserved domain (example.com/.org/.net, .test, .local,
 * .invalid, .localhost). WORKSTATION_TEMPORARY_EMAILS replaces this with a
 * case-insensitive regular expression; "off" turns it off.
 */
export const DEFAULT_TEMPORARY_EMAILS =
  "^[^@]*\\+test[^@]*@|@(example\\.(com|org|net)|([^@]+\\.)?(test|local|invalid|localhost))$";

export function isTemporaryEmail(email: string | null | undefined, env: Env = process.env): boolean {
  if (!email) return false;
  const raw = env.WORKSTATION_TEMPORARY_EMAILS?.trim();
  if (raw === "off") return false;
  try {
    return new RegExp(raw || DEFAULT_TEMPORARY_EMAILS, "i").test(email.trim());
  } catch {
    console.warn("[workstation] WORKSTATION_TEMPORARY_EMAILS is not a valid pattern");
    return false;
  }
}

const minutes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 60_000;
};

/** How temporary VMs are handed out and taken back. */
export function temporaryPolicy(poolSize: number, env: Env = process.env) {
  const limit = Number(env.WORKSTATION_TEMPORARY_LIMIT);
  return {
    // Unused this long, a temporary VM is wiped and returned (default 2 h).
    idleMs: minutes(env.WORKSTATION_TEMPORARY_IDLE_MINUTES, 120),
    // When the pool is short, a temporary VM unused this long is taken back
    // early for whoever needs one (default 15 min).
    reclaimMs: minutes(env.WORKSTATION_TEMPORARY_RECLAIM_MINUTES, 15),
    // Test accounts hold at most this many VMs at once, so real accounts
    // always find one (default: all but one of the pool).
    limit: Number.isInteger(limit) && limit >= 0 ? limit : Math.max(poolSize - 1, 0),
  };
}

/** How to reach one VM, or null when the connection settings are incomplete. */
export function targetForVm(vm: string, env: Env = process.env): WorkstationTarget | null {
  const fill = (value: string | undefined) => value?.trim().replaceAll("{vm}", vm) || undefined;
  const identityFile = env.WORKSTATION_SSH_IDENTITY_FILE?.trim();
  const proxyCommand = fill(env.WORKSTATION_SSH_PROXY_COMMAND);
  const host = fill(env.WORKSTATION_SSH_HOST) || (proxyCommand ? "workstation" : "");
  if (!identityFile || !host) return null;
  const port = Number(env.WORKSTATION_SSH_PORT);
  const snapshotSocket = env.WORKSTATION_SNAPSHOT_SOCKET?.trim();
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : undefined,
    user: env.WORKSTATION_SSH_USER?.trim() || "agent",
    identityFile,
    proxyCommand,
    knownHostsFile: env.WORKSTATION_SSH_KNOWN_HOSTS?.trim() || undefined,
    snapshot: snapshotSocket && VM_NAME.test(vm) ? { socketPath: snapshotSocket, vm } : undefined,
  };
}

/** The statically configured workstation of an account, without the pool. */
export function workstationFor(userId: string, env: Env = process.env): WorkstationTarget | null {
  const vm = staticWorkstationVm(userId, env);
  return vm === null ? null : targetForVm(vm, env);
}
