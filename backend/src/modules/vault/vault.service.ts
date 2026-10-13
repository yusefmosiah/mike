// The vault module: the signed-in user's own secrets, through the vault's
// control API (lib/vault). Every call is scoped to the caller's user id,
// which comes from the session, never from the request.
import type { Db } from "../../lib/db";
import { resolveWorkstation } from "../../lib/workstation";
import {
  clearVaultVmMark,
  createVaultSecret,
  deleteVaultSecret,
  listVaultSecrets,
  updateVaultSecret,
  vaultAudit,
  vaultEnabled,
  VaultRequestError,
  vaultSealKey,
  vaultVmState,
  VaultUnavailableError,
  type SealedValue,
  type VaultAuditEvent,
  type VaultInjection,
  type VaultSecret,
} from "../../lib/vault/client";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export { vaultEnabled };

const UNAVAILABLE = "The vault is not available right now.";

async function guarded<T>(run: () => Promise<T>): Promise<ServiceResult<T>> {
  if (!vaultEnabled()) return failure("unavailable", "The vault is not set up on this server.", "vault_disabled");
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof VaultRequestError) {
      // The vault's 4xx messages are validation text written for the user.
      if (error.status === 404) return failure("not_found", "No such secret.");
      if (error.status === 409) return failure("conflict", error.message);
      return failure("validation", error.message);
    }
    if (error instanceof VaultUnavailableError) return failure("unavailable", UNAVAILABLE, "vault_unavailable");
    return internalFailure(error);
  }
}

function asSealed(value: unknown): SealedValue | null {
  if (!value || typeof value !== "object") return null;
  const sealed = value as Record<string, unknown>;
  for (const field of ["kid", "epk", "iv", "ct"]) {
    if (typeof sealed[field] !== "string" || (sealed[field] as string).length > 40_000) return null;
  }
  return { kid: sealed.kid as string, epk: sealed.epk as string, iv: sealed.iv as string, ct: sealed.ct as string };
}

function asInjection(value: unknown): VaultInjection | null {
  if (!value || typeof value !== "object") return null;
  const injection = value as Record<string, unknown>;
  if (injection.type === "bearer") return { type: "bearer" };
  if (injection.type === "basic" && typeof injection.username === "string") return { type: "basic", username: injection.username };
  if (injection.type === "header" && typeof injection.name === "string") return { type: "header", name: injection.name };
  return null;
}

/** Whether credentials are paused for the user's own workstation, because someone else worked in it. */
export type WorkstationVaultState = { paused_since: string | null; guest_working: boolean };

export async function workstationVaultState(db: Db, userId: string): Promise<ServiceResult<WorkstationVaultState | null>> {
  return guarded(async () => {
    const vm = (await resolveWorkstation(db, userId))?.vm;
    if (!vm) return null;
    const state = await vaultVmState(vm);
    return { paused_since: state.guested_since, guest_working: state.guests > 0 };
  });
}

/** The owner allows credentials in their workstation again after a guest worked in it. */
export async function allowWorkstationVault(db: Db, userId: string): Promise<ServiceResult<WorkstationVaultState>> {
  if (!vaultEnabled()) return failure("unavailable", "The vault is not set up on this server.", "vault_disabled");
  const vm = (await resolveWorkstation(db, userId))?.vm;
  if (!vm) return failure("not_found", "You have no workstation.");
  return guarded(async () => {
    const state = await clearVaultVmMark(vm, userId);
    return { paused_since: state.guested_since, guest_working: state.guests > 0 };
  });
}

export function getSealKey(): Promise<ServiceResult<{ kid: string; public_key: string; sha256: string; epoch: string; alg: string }>> {
  return guarded(vaultSealKey);
}

export function listSecrets(userId: string): Promise<ServiceResult<VaultSecret[]>> {
  return guarded(() => listVaultSecrets(userId));
}

export async function createSecret(userId: string, body: Record<string, unknown>): Promise<ServiceResult<VaultSecret>> {
  const sealed = asSealed(body.sealed);
  if (!sealed) return failure("validation", "The secret must be sealed in the browser before it is sent.");
  const injection = asInjection(body.injection);
  if (!injection) return failure("validation", "Choose how the secret is sent.");
  if (!Array.isArray(body.hosts) || !body.hosts.every((h) => typeof h === "string")) {
    return failure("validation", "List the hosts the secret may be sent to.");
  }
  if (typeof body.name !== "string") return failure("validation", "Give the secret a name.");
  return guarded(() =>
    createVaultSecret(userId, {
      name: body.name as string,
      description: typeof body.description === "string" ? body.description : undefined,
      hosts: body.hosts as string[],
      injection,
      writes: body.writes === "allow" ? "allow" : "ask",
      sealed,
    }),
  );
}

export function updateSecret(userId: string, secretId: string, body: Record<string, unknown>): Promise<ServiceResult<VaultSecret>> {
  return guarded(() =>
    updateVaultSecret(userId, secretId, {
      description: typeof body.description === "string" ? body.description : undefined,
      writes: body.writes === "allow" ? "allow" : body.writes === "ask" ? "ask" : undefined,
    }),
  );
}

export function deleteSecret(userId: string, secretId: string): Promise<ServiceResult<void>> {
  return guarded(() => deleteVaultSecret(userId, secretId));
}

export function secretActivity(userId: string, limit: number): Promise<ServiceResult<VaultAuditEvent[]>> {
  return guarded(() => vaultAudit(userId, Math.min(200, Math.max(1, limit))));
}
