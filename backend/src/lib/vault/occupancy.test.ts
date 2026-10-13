import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({ enabled: vi.fn(() => true), fence: vi.fn(), unfence: vi.fn(), revoke: vi.fn() }));
vi.mock("./client", () => ({
  vaultEnabled: vault.enabled,
  fenceVaultVm: vault.fence,
  unfenceVaultVm: vault.unfence,
  revokeVaultLeases: vault.revoke,
}));

import { UserFacingError } from "../userFacingError";
import { endOwnerTurn, startGuestTurn, WorkstationFenceError } from "./occupancy";

beforeEach(() => {
  vi.clearAllMocks();
  vault.enabled.mockReturnValue(true);
  vault.fence.mockResolvedValue(undefined);
  vault.unfence.mockResolvedValue(undefined);
  vault.revoke.mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("vault occupancy", () => {
  it("fences the VM, marked, for a guest's turn, and ends the fence once", async () => {
    const end = await startGuestTurn("ws-01");
    expect(vault.fence).toHaveBeenCalledWith("ws-01", true);
    await end();
    await end();
    expect(vault.unfence).toHaveBeenCalledTimes(1);
    expect(vault.unfence).toHaveBeenCalledWith("ws-01");
  });

  it("refuses the guest's turn, with a message for people, when the vault cannot fence", async () => {
    vault.fence.mockRejectedValueOnce(new Error("down"));
    const error = await startGuestTurn("ws-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkstationFenceError);
    expect(error).toBeInstanceOf(UserFacingError);
  });

  it("keeps the fence when ending it fails, and does nothing without a vault", async () => {
    vault.unfence.mockRejectedValueOnce(new Error("down"));
    await expect((await startGuestTurn("ws-01"))()).resolves.toBeUndefined();
    vault.enabled.mockReturnValue(false);
    await (await startGuestTurn("ws-02"))();
    expect(vault.fence).toHaveBeenCalledTimes(1);
  });

  it("ends a turn's leases by chat, or by user and VM without one", async () => {
    await endOwnerTurn({ userId: "u1", vm: "ws-01", chatId: "c1" });
    expect(vault.revoke).toHaveBeenLastCalledWith({ userId: "u1", chatId: "c1" });
    await endOwnerTurn({ userId: "u1", vm: "ws-01", chatId: null });
    expect(vault.revoke).toHaveBeenLastCalledWith({ userId: "u1", vm: "ws-01" });
    vault.revoke.mockRejectedValueOnce(new Error("down"));
    await expect(endOwnerTurn({ userId: "u1", vm: "ws-01", chatId: "c1" })).resolves.toBeUndefined();
    vault.enabled.mockReturnValue(false);
    vault.revoke.mockClear();
    await endOwnerTurn({ userId: "u1", vm: "ws-01", chatId: "c1" });
    expect(vault.revoke).not.toHaveBeenCalled();
  });
});
