/**
 * Which workstation VM, if any, a user's turns may run commands in.
 *
 * Phase 2 of Mission 13 configures one development workstation from the
 * environment and names the users allowed to use it; there is deliberately no
 * default that hands every user the same VM. Per-employee VMs come with host
 * provisioning (phase 3), which replaces this lookup.
 */
import type { WorkstationTarget } from "./exec";

type Env = Record<string, string | undefined>;

export function workstationFor(userId: string, env: Env = process.env): WorkstationTarget | null {
  const users = (env.WORKSTATION_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!users.includes(userId)) return null;
  const snapshotSocket = env.WORKSTATION_SNAPSHOT_SOCKET?.trim();
  const vm = env.WORKSTATION_NAME?.trim();
  const identityFile = env.WORKSTATION_SSH_IDENTITY_FILE?.trim();
  const proxyCommand = env.WORKSTATION_SSH_PROXY_COMMAND?.trim() || undefined;
  const host = env.WORKSTATION_SSH_HOST?.trim() || (proxyCommand ? "workstation" : "");
  if (!identityFile || !host) return null;
  const port = Number(env.WORKSTATION_SSH_PORT);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : undefined,
    user: env.WORKSTATION_SSH_USER?.trim() || "agent",
    identityFile,
    proxyCommand,
    knownHostsFile: env.WORKSTATION_SSH_KNOWN_HOSTS?.trim() || undefined,
    snapshot: snapshotSocket && vm ? { socketPath: snapshotSocket, vm } : undefined,
  };
}
