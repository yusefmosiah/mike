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
