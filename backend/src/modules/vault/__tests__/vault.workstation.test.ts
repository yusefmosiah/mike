import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  state: vi.fn(),
  clear: vi.fn(),
  vm: vi.fn<() => string | null>(() => "ws-01"),
}));

vi.mock("../../../lib/vault/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/vault/client")>()),
  vaultEnabled: mocks.enabled,
  vaultVmState: mocks.state,
  clearVaultVmMark: mocks.clear,
}));
vi.mock("../../../lib/workstation", () => ({
  resolveWorkstation: async () => (mocks.vm() ? { vm: mocks.vm() } : null),
}));

import { VaultRequestError } from "../../../lib/vault/client";
import { allowWorkstationVault, workstationVaultState } from "../vault.service";

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.vm.mockReturnValue("ws-01");
});

describe("the user's workstation in the vault", () => {
  it("reports whether credentials are paused for the user's own VM", async () => {
    mocks.state.mockResolvedValue({ guests: 1, guested_since: "2026-10-13T00:00:00Z" });
    expect(await workstationVaultState(db, "u1")).toEqual({
      ok: true,
      data: { paused_since: "2026-10-13T00:00:00Z", guest_working: true },
    });
    expect(mocks.state).toHaveBeenCalledWith("ws-01");
    mocks.vm.mockReturnValue(null);
    expect(await workstationVaultState(db, "u1")).toEqual({ ok: true, data: null });
  });

  it("lets the owner allow credentials again, only in their own VM", async () => {
    mocks.clear.mockResolvedValue({ guests: 0, guested_since: null });
    expect(await allowWorkstationVault(db, "u1")).toEqual({ ok: true, data: { paused_since: null, guest_working: false } });
    expect(mocks.clear).toHaveBeenCalledWith("ws-01", "u1");

    mocks.clear.mockRejectedValueOnce(new VaultRequestError(409, "someone is working in this workstation right now"));
    expect(await allowWorkstationVault(db, "u1")).toMatchObject({ ok: false, kind: "conflict" });

    mocks.vm.mockReturnValue(null);
    expect(await allowWorkstationVault(db, "u1")).toMatchObject({ ok: false, kind: "not_found" });
    mocks.enabled.mockReturnValue(false);
    expect(await allowWorkstationVault(db, "u1")).toMatchObject({ ok: false, kind: "unavailable" });
  });
});
