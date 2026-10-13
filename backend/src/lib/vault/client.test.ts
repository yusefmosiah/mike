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
  });
});
