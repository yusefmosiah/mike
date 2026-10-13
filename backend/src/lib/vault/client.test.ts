import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createVaultSecret,
  issueVaultLease,
  leaseInstructions,
  listVaultSecrets,
  clearVaultVmMark,
  fenceVaultVm,
  purgeVaultUser,
  unfenceVaultVm,
  vaultVmState,
  revokeVaultLeases,
  VaultRequestError,
  VaultUnavailableError,
} from "./client";

const socket = path.join(mkdtempSync(path.join(tmpdir(), "vault-client-")), "control.sock");
const seen: { method?: string; url?: string; body: string }[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/users/u%2F1/secrets" && req.method === "GET") {
        res.end(JSON.stringify({ secrets: [{ id: "sec_1", name: "blog" }] }));
      } else if (req.url === "/v1/users/u1/secrets" && req.method === "POST") {
        res.writeHead(409).end(JSON.stringify({ error: "a secret named blog already exists" }));
      } else if (req.url?.startsWith("/v1/vms/ws-01")) {
        res.end(JSON.stringify({ guests: 0, guested_since: null, revoked: 1 }));
      } else if (req.url === "/v1/leases" && req.method === "DELETE") {
        res.end(JSON.stringify({ revoked: 2 }));
      } else if (req.url === "/v1/users/u1" && req.method === "DELETE") {
        res.end(JSON.stringify({ purged: true, revoked: 0 }));
      } else if (req.url === "/v1/leases") {
        res.writeHead(201).end(JSON.stringify({ lease: "mvl_x", secret: "blog", hosts: ["gitlab.com"], access: "read", expires_at: "t" }));
      } else {
        res.writeHead(500).end(JSON.stringify({ error: "internal" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  process.env.VAULT_CONTROL_SOCKET = socket;
});

afterAll(() => {
  server.close();
  delete process.env.VAULT_CONTROL_SOCKET;
});

describe("vault client", () => {
  it("scopes calls by user id, encoded", async () => {
    expect(await listVaultSecrets("u/1")).toEqual([{ id: "sec_1", name: "blog" }]);
  });

  it("passes the vault's validation messages on as request errors", async () => {
    const error = await createVaultSecret("u1", {
      name: "blog",
      hosts: ["gitlab.com"],
      injection: { type: "bearer" },
      sealed: { kid: "k", epk: "e", iv: "i", ct: "c" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultRequestError);
    expect((error as VaultRequestError).status).toBe(409);
    expect(JSON.parse(seen.at(-1)!.body).sealed).toEqual({ kid: "k", epk: "e", iv: "i", ct: "c" });
  });

  it("treats a 5xx or a missing socket as unavailable", async () => {
    await expect(listVaultSecrets("other")).rejects.toBeInstanceOf(VaultUnavailableError);
    process.env.VAULT_CONTROL_SOCKET = path.join(tmpdir(), "no-such-vault.sock");
    await expect(listVaultSecrets("u1")).rejects.toBeInstanceOf(VaultUnavailableError);
    process.env.VAULT_CONTROL_SOCKET = socket;
  });

  it("issues leases and explains them without the secret", async () => {
    const lease = await issueVaultLease({ userId: "u1", vm: "ws-01", secret: "blog", access: "read", chatId: "c1" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ user: "u1", vm: "ws-01", secret: "blog", access: "read", chat: "c1" });
    const text = leaseInstructions(lease);
    expect(text).toContain("$MIKE_VAULT_URL/mvl_x/gitlab.com/");
    expect(text).toContain("GET, HEAD and OPTIONS only");
    expect(text).toContain("end of this turn");
    expect(text).not.toContain("remote set-url");
  });

  it("revokes leases by chat, by user and VM, or by VM, and purges a user", async () => {
    expect(await revokeVaultLeases({ userId: "u1", chatId: "c1" })).toBe(2);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ user: "u1", chat: "c1" });
    await revokeVaultLeases({ userId: "u1", chatId: null, vm: "ws-01" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ user: "u1", vm: "ws-01" });
    await revokeVaultLeases({ vm: "ws-01" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ vm: "ws-01" });
    await fenceVaultVm("ws-01", true);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/v1/vms/ws-01/fence" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ mark: true });
    await unfenceVaultVm("ws-01");
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/v1/vms/ws-01/unfence" });
    expect(await vaultVmState("ws-01")).toMatchObject({ guests: 0, guested_since: null });
    await clearVaultVmMark("ws-01", "u1");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/v1/vms/ws-01/mark" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ user: "u1" });
    await purgeVaultUser("u1");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/v1/users/u1" });
  });
});
