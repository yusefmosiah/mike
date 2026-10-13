// Who is working in a workstation, as far as the vault is concerned.
//
// A guest in a shared thread runs commands in the host's VM, and can read its
// files and processes, and leave something running. Before a guest's turn
// starts there, the vault fences the VM (infra/vault/src/vms.ts): everything
// lent to it is revoked, nothing is lent while the turn runs, and leases stay
// paused afterwards until the owner allows them again in Settings → Vault.
// The vault keeps this state, so it holds across backend processes, and the
// fence and the lease check cannot interleave.
import { safeError } from "../safeError";
import { UserFacingError } from "../userFacingError";
import { fenceVaultVm, revokeVaultLeases, unfenceVaultVm, vaultEnabled } from "./client";

/** The vault could not fence the VM; the guest's turn must not run in it. */
export class WorkstationFenceError extends UserFacingError {
  constructor() {
    super("The host's workstation is not available right now. Try again in a moment.");
    this.name = "WorkstationFenceError";
  }
}

/**
 * Fences `vm` for a guest's turn and returns what ends the fence. Throws
 * WorkstationFenceError when the vault cannot confirm it: failing closed.
 */
export async function startGuestTurn(vm: string): Promise<() => Promise<void>> {
  if (!vaultEnabled()) return async () => undefined;
  try {
    await fenceVaultVm(vm, true);
  } catch (error) {
    console.error("[vault] fencing a workstation for a guest failed", safeError(error));
    throw new WorkstationFenceError();
  }
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    try {
      await unfenceVaultVm(vm);
    } catch (error) {
      // The VM stays fenced (nothing lent) until the vault restarts: safe.
      console.error("[vault] ending a guest's fence failed", safeError(error));
    }
  };
}

/** Revokes what a user's turn was lent; a turn's leases end with it. */
export async function endOwnerTurn(input: { userId: string; vm: string; chatId: string | null }): Promise<void> {
  if (!vaultEnabled()) return;
  try {
    await revokeVaultLeases(
      input.chatId ? { userId: input.userId, chatId: input.chatId } : { userId: input.userId, vm: input.vm },
    );
  } catch (error) {
    console.error("[vault] revoking a turn's leases failed", safeError(error));
  }
}
