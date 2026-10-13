import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalItem } from "@mike/contracts";

const vault = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  list: vi.fn(),
  lease: vi.fn(),
  workstationVm: vi.fn<() => string | null>(() => "ws-01"),
}));

vi.mock("../../../../../lib/workstation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/workstation")>()),
  resolveWorkstation: async () => {
    const vm = vault.workstationVm();
    return vm ? { host: "workstation", user: "agent", identityFile: "/key", vm } : null;
  },
}));

vi.mock("../../../../../lib/vault/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/vault/client")>();
  return {
    ...actual,
    vaultEnabled: vault.enabled,
    listVaultSecrets: vault.list,
    issueVaultLease: vault.lease,
  };
});

import { executeApprovedVaultLease, runVaultTool } from "../vaultTools";
import { VaultRequestError } from "../../../../../lib/vault/client";

const db = {} as never;

const workstation = { host: "workstation", user: "agent", identityFile: "/key", vm: "ws-01" };
const secret = (overrides: Record<string, unknown> = {}) => ({
  id: "sec_1",
  name: "blog",
  description: "",
  hosts: ["gitlab.com"],
  injection: { type: "basic", username: "oauth2" },
  writes: "ask",
  hint: "abcd",
  created_at: "",
  updated_at: "",
  last_used_at: null,
  ...overrides,
});
const run = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  runVaultTool({
    name,
    args,
    db: {} as never,
    userId: "user-1",
    workstation,
    workspaceOwned: true,
    chatId: "chat-1",
    canAsk: true,
    ...extra,
  } as Parameters<typeof runVaultTool>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vault.enabled.mockReturnValue(true);
  vault.workstationVm.mockReturnValue("ws-01");
  vault.list.mockResolvedValue([secret()]);
  vault.lease.mockResolvedValue({
    lease: "mvl_token",
    secret: "blog",
    hosts: ["gitlab.com"],
    access: "read",
    expires_at: "2026-10-13T00:15:00Z",
  });
});

describe("vault tools", () => {
  it("are refused outside the user's own workstation", async () => {
    const guest = await run("vault_lease", { secret: "blog", access: "read" }, { workspaceOwned: false });
    expect(JSON.parse(guest.content).error).toMatch(/own workstation/);
    expect(vault.lease).not.toHaveBeenCalled();
    const noVm = await run("vault_secrets", {}, { workstation: { ...workstation, vm: undefined } });
    expect(JSON.parse(noVm.content).ok).toBe(false);
  });

  it("list secrets by description, never by value or hint", async () => {
    const out = await run("vault_secrets", {});
    const body = JSON.parse(out.content);
    expect(body.secrets).toEqual([
      {
        name: "blog",
        hosts: ["gitlab.com"],
        auth: "basic (username oauth2) (as stored; a lease can attach it another way)",
        changes: "need the user's approval",
      },
    ]);
    expect(out.content).not.toContain("abcd");
    expect(out.event).toMatchObject({ connector_name: "Vault", status: "ok" });
  });

  it("issue a read lease for this user's VM and chat", async () => {
    const out = await run("vault_lease", { secret: "Blog", access: "read" });
    expect(vault.lease).toHaveBeenCalledWith({ userId: "user-1", vm: "ws-01", secret: "sec_1", access: "read", chatId: "chat-1", injection: null });
    expect(out.content).toContain("$MIKE_VAULT_URL/mvl_token/gitlab.com/");
    expect(out.item).toBeUndefined();
  });

  it("attach the secret the way the lease asks, for reads and approved writes", async () => {
    await run("vault_lease", { secret: "blog", access: "read", auth: "header", header: "PRIVATE-TOKEN" });
    expect(vault.lease).toHaveBeenLastCalledWith(expect.objectContaining({ injection: { type: "header", name: "PRIVATE-TOKEN" } }));
    const write = await run("vault_lease", { secret: "blog", access: "write", auth: "basic", username: "oauth2" });
    expect((write.item as ConnectorApprovalItem).binding).toMatchObject({ injection: { type: "basic", username: "oauth2" } });
    const bad = await run("vault_lease", { secret: "blog", access: "read", auth: "header" });
    expect(JSON.parse(bad.content).error).toMatch(/header name/);
    for (const header of ["User-Agent", "Referer", "x-amz-meta-token"]) {
      const logged = await run("vault_lease", { secret: "blog", access: "read", auth: "header", header });
      expect(JSON.parse(logged.content).error, header).toMatch(/named for a credential/);
    }
    expect((write.item as ConnectorApprovalItem).arguments).toMatchObject({ attached: "basic (username oauth2)" });
  });

  it("turn a write lease into an approval unless changes are allowed", async () => {
    const out = await run("vault_lease", { secret: "blog", access: "write", reason: "push the post" });
    expect(vault.lease).not.toHaveBeenCalled();
    const item = out.item as ConnectorApprovalItem;
    expect(item).toMatchObject({
      kind: "approval",
      connector_name: "Vault",
      tool_name: "vault_lease",
      arguments: { credential: "blog", hosts: "gitlab.com", reason: "push the post" },
      binding: { type: "vault", secret_id: "sec_1", vm: "ws-01", chat_id: "chat-1" },
    });
    expect(JSON.parse(out.content).status).toBe("awaiting_approval");

    vault.list.mockResolvedValue([secret({ writes: "allow" })]);
    await run("vault_lease", { secret: "blog", access: "write" });
    expect(vault.lease).toHaveBeenCalledWith(expect.objectContaining({ access: "write" }));
  });

  it("refuse what needs the user when the turn cannot pause", async () => {
    const write = await run("vault_lease", { secret: "blog", access: "write" }, { canAsk: false });
    expect(write.item).toBeUndefined();
    expect(JSON.parse(write.content).ok).toBe(false);
    const ask = await run("vault_request_secret", { name: "x-key", purpose: "p", hosts: ["a.com"], auth: "bearer" }, { canAsk: false });
    expect(ask.item).toBeUndefined();
  });

  it("name what is stored when the secret is unknown", async () => {
    const out = await run("vault_lease", { secret: "missing", access: "read" });
    expect(JSON.parse(out.content).error).toContain("Stored: blog");
  });

  it("ask the user to store a secret through the form, normalising hosts", async () => {
    const out = await run("vault_request_secret", {
      name: "API-Key",
      purpose: "Read the status API",
      hosts: ["https://API.example.com/v1", "api.example.com"],
      auth: "header",
      header: "X-API-Key",
    });
    expect(out.item).toMatchObject({
      kind: "secret",
      name: "api-key",
      hosts: ["api.example.com"],
      injection: { type: "header", name: "X-API-Key" },
    });
    // A stored name asks the user to replace that credential.
    const replace = await run("vault_request_secret", { name: "blog", purpose: "", hosts: ["gitlab.com"] });
    expect(replace.item).toMatchObject({ kind: "secret", name: "blog", replaces: "sec_1", injection: { type: "bearer" } });
    expect(JSON.parse(replace.content).message).toMatch(/replace the stored blog/);
    const basic = await run("vault_request_secret", { name: "git", purpose: "", hosts: ["a.com"], auth: "basic" });
    expect(JSON.parse(basic.content).error).toMatch(/username/);
  });

  it("pass on the vault's refusal for a VM someone else works in, and lend nothing to a VM no longer theirs", async () => {
    vault.lease.mockRejectedValueOnce(new VaultRequestError(409, "Someone else is working in this workstation right now."));
    const busy = await run("vault_lease", { secret: "blog", access: "read" });
    expect(JSON.parse(busy.content).error).toContain("Someone else is working");
    vault.workstationVm.mockReturnValue("ws-02");
    const moved = await run("vault_lease", { secret: "blog", access: "read" });
    expect(JSON.parse(moved.content).error).toContain("no longer");
    expect(vault.lease).toHaveBeenCalledTimes(1);
  });

  it("refuse wildcard hosts in a credential request", async () => {
    const out = await run("vault_request_secret", { name: "pages", purpose: "x", hosts: ["*.github.io"], auth: "bearer" });
    expect(JSON.parse(out.content).ok).toBe(false);
    expect(out.item).toBeUndefined();
  });

  it("issue an approved lease only to the user's current workstation", async () => {
    const item = {
      id: "a1",
      kind: "approval",
      connector_name: "Vault",
      tool_name: "vault_lease",
      title: "",
      arguments: {},
      binding: { type: "vault", secret_id: "sec_1", vm: "ws-01", chat_id: "chat-1" },
    } as ConnectorApprovalItem;
    vault.workstationVm.mockReturnValue("ws-02");
    expect((await executeApprovedVaultLease(db, "user-1", item)).event.status).toBe("error");
    vault.workstationVm.mockReturnValue(null);
    expect((await executeApprovedVaultLease(db, "user-1", item)).event.status).toBe("error");
    expect(vault.lease).not.toHaveBeenCalled();
  });

  it("issue the approved write lease from the persisted binding", async () => {
    const item = {
      id: "a1",
      kind: "approval",
      connector_name: "Vault",
      tool_name: "vault_lease",
      title: "",
      arguments: {},
      binding: { type: "vault", secret_id: "sec_1", vm: "ws-01", chat_id: "chat-1" },
    } as ConnectorApprovalItem;
    vault.lease.mockResolvedValue({ lease: "mvl_w", secret: "blog", hosts: ["gitlab.com"], access: "write", expires_at: "t" });
    const out = await executeApprovedVaultLease(db, "user-1", item);
    expect(vault.lease).toHaveBeenCalledWith({ userId: "user-1", vm: "ws-01", secret: "sec_1", access: "write", chatId: "chat-1", injection: null });
    expect(out.content).toContain("mvl_w");
    expect(out.event.status).toBe("ok");
  });
});
