import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { AuditLog } from "../src/audit.ts";
import { controlHandler } from "../src/control.ts";
import { generateSealingKey, open, randomKey, seal, sealValue, secretAad, unsealValue } from "../src/crypto.ts";
import { dataHandler } from "../src/data.ts";
import { isPublicIPv4, resolvePublic } from "../src/forward.ts";
import { Leases } from "../src/leases.ts";
import { hostAllowed, injectedHeader, normalizeHost, normalizeHosts, normalizeInjection, scrubPatterns } from "../src/policy.ts";
import { REDACTED, Scrubber } from "../src/scrub.ts";
import { SecretStore } from "../src/store.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "vault-test-"));
const TOKEN = "glpat-abcdefghijklmnop1234";

describe("crypto", () => {
  it("opens what a browser sealed, and nothing tampered with", async () => {
    const { key } = await generateSealingKey();
    const sealed = await sealValue(key.publicKey, key.kid, TOKEN);
    assert.equal((await unsealValue(key, sealed)).toString(), TOKEN);
    await assert.rejects(unsealValue(key, { ...sealed, kid: "0000000000000000" }));
    const ct = Buffer.from(sealed.ct, "base64url");
    ct[0] ^= 1;
    await assert.rejects(unsealValue(key, { ...sealed, ct: ct.toString("base64url") }));
    const other = (await generateSealingKey()).key;
    await assert.rejects(unsealValue(other, { ...sealed, kid: other.kid }));
  });

  it("binds a stored value to its user and secret id", () => {
    const key = randomKey();
    const box = seal(key, Buffer.from(TOKEN), secretAad("user-a", "sec_1"));
    assert.equal(open(key, box, secretAad("user-a", "sec_1")).toString(), TOKEN);
    assert.throws(() => open(key, box, secretAad("user-b", "sec_1")));
    assert.throws(() => open(key, box, secretAad("user-a", "sec_2")));
  });
});

describe("policy", () => {
  it("accepts host names and wildcards, not addresses or junk", () => {
    assert.equal(normalizeHost(" GitLab.com. "), "gitlab.com");
    assert.equal(normalizeHost("*.example.org"), "*.example.org");
    for (const bad of ["127.0.0.1", "localhost", "gitlab.com:443", "https://gitlab.com", "a..b", "-a.com", ""]) {
      assert.throws(() => normalizeHost(bad), bad);
    }
    assert.throws(() => normalizeHosts([]));
  });

  it("matches wildcards against subdomains only", () => {
    assert.ok(hostAllowed(["*.example.org"], "api.example.org"));
    assert.ok(!hostAllowed(["*.example.org"], "example.org"));
    assert.ok(!hostAllowed(["*.example.org"], "evilexample.org"));
    assert.ok(hostAllowed(["gitlab.com"], "GITLAB.COM"));
    assert.ok(!hostAllowed(["gitlab.com"], "gitlab.com.evil.net"));
  });

  it("builds the header and every echoed form of the secret", () => {
    const basic = normalizeInjection({ type: "basic", username: "oauth2" });
    const [name, value] = injectedHeader(basic, TOKEN);
    assert.equal(name, "authorization");
    assert.equal(Buffer.from(value.slice(6), "base64").toString(), `oauth2:${TOKEN}`);
    assert.ok(scrubPatterns(basic, TOKEN).includes(value.slice(6)));
    assert.deepEqual(injectedHeader(normalizeInjection({ type: "header", name: "PRIVATE-TOKEN" }), TOKEN), ["private-token", TOKEN]);
    assert.throws(() => normalizeInjection({ type: "header", name: "Host" }));
    assert.throws(() => normalizeInjection({ type: "basic", username: "a:b" }));
  });
});

describe("scrubbing", () => {
  it("removes a secret split across chunks", async () => {
    const chunks = ["prefix glpat-abc", "defghijklmnop", "1234 suffix ", TOKEN.slice(0, 3), TOKEN.slice(3)];
    let out = "";
    await new Promise<void>((resolve) => {
      const scrub = new Scrubber([TOKEN]);
      scrub.on("data", (chunk: Buffer) => (out += chunk.toString()));
      scrub.on("end", resolve);
      Readable.from(chunks.map((c) => Buffer.from(c))).pipe(scrub);
    });
    assert.equal(out, `prefix ${REDACTED} suffix ${REDACTED}`);
  });
});

describe("addresses", () => {
  it("refuses private, loopback, link-local and CGNAT addresses", async () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      assert.ok(!isPublicIPv4(address), address);
    }
    assert.ok(isPublicIPv4("140.82.112.3"));
    await assert.rejects(resolvePublic("localhost"), /private or reserved|cannot resolve/);
  });
});

describe("leases", () => {
  it("work only from their VM and until they expire", () => {
    let now = 1_000_000;
    const leases = new Leases(() => now);
    const lease = leases.issue({ userId: "u", vm: "ws-01", secretId: "s", access: "read", ttlSeconds: 60 });
    assert.ok(leases.check(lease.token, "ws-01"));
    assert.equal(leases.check(lease.token, "ws-02"), null);
    now += 61_000;
    assert.equal(leases.check(lease.token, "ws-01"), null);
  });
});

describe("store", () => {
  it("persists ciphertext only and keeps hosts fixed", async () => {
    const dir = tmp();
    const store = new SecretStore(dir, randomKey());
    const meta = await store.create("user-a", { name: "blog", hosts: ["gitlab.com"], injection: { type: "bearer" } }, TOKEN);
    assert.equal(meta.hint, "1234");
    assert.ok(!readFileSync(path.join(dir, "secrets.json"), "utf8").includes(TOKEN));
    await assert.rejects(store.create("user-a", { name: "blog", hosts: ["x.com"], injection: { type: "bearer" } }, TOKEN));
    const updated = await store.update("user-a", meta.id, { writes: "allow", hosts: ["evil.example"] } as never);
    assert.deepEqual(updated.hosts, ["gitlab.com"]);
    assert.equal(updated.writes, "allow");
    assert.equal(store.list("user-b").length, 0);
    assert.throws(() => store.reveal("user-b", meta.id));
    await assert.rejects(store.create("user-a", { name: "short", hosts: ["x.com"], injection: { type: "bearer" } }, "abc"));
  });

  it("reloads from disk, and a row moved to another user does not decrypt", async () => {
    const dir = tmp();
    const master = randomKey();
    const store = new SecretStore(dir, master);
    const a = await store.create("user-a", { name: "one", hosts: ["a.com"], injection: { type: "bearer" } }, TOKEN);
    await store.create("user-b", { name: "two", hosts: ["b.com"], injection: { type: "bearer" } }, "other-secret-value");
    const reloaded = new SecretStore(dir, master);
    await reloaded.load();
    assert.equal(reloaded.reveal("user-a", a.id), TOKEN);

    const file = path.join(dir, "secrets.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.users["user-b"].secrets[a.id] = data.users["user-a"].secrets[a.id];
    writeFileSync(file, JSON.stringify(data));
    const tampered = new SecretStore(dir, master);
    await tampered.load();
    assert.throws(() => tampered.reveal("user-b", a.id));
  });
});

// ---------------------------------------------------------------------------
// End to end: control and VM sockets, and an HTTPS upstream with its own CA.

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function unixRequest(socketPath: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest({ socketPath, method, path: url, headers: { ...headers, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("vault end to end", () => {
  const dir = tmp();
  const control = path.join(dir, "control.sock");
  const vmA = path.join(dir, "ws-a.sock");
  const vmB = path.join(dir, "ws-b.sock");
  const servers: Server[] = [];
  let seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let sealKey: { kid: string; public_key: string };

  before(async () => {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=api.example.com", "-addext", "subjectAltName=DNS:api.example.com,DNS:other.example.com",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    const cert = readFileSync(path.join(dir, "cert.pem"));
    const upstream = createHttpsServer({ key: readFileSync(path.join(dir, "key.pem")), cert }, (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "https://other.example.com/next?x=1" }).end();
          return;
        }
        // Echo the credential back, as a careless API might.
        res.writeHead(200, { "content-type": "text/plain", "x-echo": String(req.headers.authorization ?? "") });
        res.end(`you sent ${req.headers.authorization} to ${req.url}`);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    servers.push(upstream as unknown as Server);
    const port = (upstream.address() as { port: number }).port;

    const { key: sealing } = await generateSealingKey();
    const store = new SecretStore(dir, randomKey());
    const leases = new Leases();
    const audit = new AuditLog(dir);
    const forward = { resolve: async () => "127.0.0.1", ca: cert, port };
    const listen = async (socketPath: string, handler: (req: never, res: never) => Promise<void>) => {
      const server = createHttpServer((req, res) => void handler(req as never, res as never));
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      servers.push(server);
    };
    await listen(control, controlHandler({ store, leases, audit, sealing, vms: new Set(["ws-a", "ws-b"]) }));
    await listen(vmA, dataHandler("ws-a", { store, leases, audit, forward }));
    await listen(vmB, dataHandler("ws-b", { store, leases, audit, forward }));
    sealKey = JSON.parse((await unixRequest(control, "GET", "/v1/seal-key")).body);
  });

  after(() => {
    for (const server of servers) server.close();
  });

  const createSecret = async (user: string, name: string, extra: Record<string, unknown> = {}) => {
    const sealed = await sealValue(sealKey.public_key, sealKey.kid, TOKEN);
    return unixRequest(control, "POST", `/v1/users/${user}/secrets`, {
      name, hosts: ["api.example.com"], injection: { type: "basic", username: "oauth2" }, sealed, ...extra,
    });
  };
  const lease = async (user: string, vm: string, secret: string, access = "read") =>
    JSON.parse((await unixRequest(control, "POST", "/v1/leases", { user, vm, secret, access, chat: "chat-1" })).body) as { lease: string };

  it("creates a secret from a sealed value and never returns it", async () => {
    const created = await createSecret("user-a", "api");
    assert.equal(created.status, 201);
    assert.ok(!created.body.includes(TOKEN));
    const listed = await unixRequest(control, "GET", "/v1/users/user-a/secrets");
    assert.ok(!listed.body.includes(TOKEN));
    assert.equal(JSON.parse(listed.body).secrets[0].name, "api");
    const plain = await unixRequest(control, "POST", "/v1/users/user-a/secrets", {
      name: "plain", hosts: ["api.example.com"], injection: { type: "bearer" }, value: TOKEN,
    });
    assert.equal(plain.status, 400);
  });

  it("attaches the secret upstream and removes it from what comes back", async () => {
    seen = [];
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const reply = await unixRequest(vmA, "GET", `/${token}/api.example.com/v4/projects?per_page=5`, undefined, { authorization: "Bearer agent-made-this-up" });
    assert.equal(reply.status, 200);
    assert.equal(seen[0].url, "/v4/projects?per_page=5");
    assert.equal(seen[0].headers.host, "api.example.com");
    assert.equal(Buffer.from(String(seen[0].headers.authorization).slice(6), "base64").toString(), `oauth2:${TOKEN}`);
    assert.ok(!reply.body.includes(TOKEN) && !reply.body.includes(String(seen[0].headers.authorization).slice(6)));
    assert.ok(reply.body.includes(REDACTED));
    assert.ok(!String(reply.headers["x-echo"]).includes(String(seen[0].headers.authorization).slice(6)));
  });

  it("refuses a lease from another VM, another host, or a write on a read lease", async () => {
    const { lease: token } = await lease("user-a", "ws-a", "api");
    assert.equal((await unixRequest(vmB, "GET", `/${token}/api.example.com/x`)).status, 401);
    assert.equal((await unixRequest(vmA, "GET", `/${token}/other.example.com/x`)).status, 403);
    assert.equal((await unixRequest(vmA, "POST", `/${token}/api.example.com/x`, "{}")).status, 403);
    assert.equal((await unixRequest(vmA, "GET", `/mvl_madeup/api.example.com/x`)).status, 401);
  });

  it("lets a write lease change things, and keeps redirects inside the vault only for allowed hosts", async () => {
    seen = [];
    const { lease: token } = await lease("user-a", "ws-a", "api", "write");
    const posted = await unixRequest(vmA, "POST", `/${token}/api.example.com/git-receive-pack`, "PACK", { "content-type": "application/x-git-receive-pack-request" });
    assert.equal(posted.status, 200);
    assert.equal(seen[0].body, "PACK");
    const moved = await unixRequest(vmA, "GET", `/${token}/api.example.com/redirect`);
    assert.equal(moved.headers.location, "https://other.example.com/next?x=1");
  });

  it("keeps users apart", async () => {
    await createSecret("user-b", "api");
    const leaseFor = await unixRequest(control, "POST", "/v1/leases", { user: "user-b", vm: "ws-b", secret: "missing" });
    assert.equal(leaseFor.status, 404);
    const a = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-a/secrets")).body).secrets[0].id;
    // user-b cannot lease user-a's secret by its id.
    assert.equal((await unixRequest(control, "POST", "/v1/leases", { user: "user-b", vm: "ws-b", secret: a })).status, 404);
  });

  it("revokes leases when the secret is deleted, and audits without values", async () => {
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const id = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-a/secrets")).body).secrets[0].id;
    assert.equal((await unixRequest(control, "DELETE", `/v1/users/user-a/secrets/${id}`)).status, 200);
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x`)).status, 401);
    const audit = await unixRequest(control, "GET", "/v1/users/user-a/audit?limit=50");
    const events = JSON.parse(audit.body).events as { event: string; user: string }[];
    assert.ok(events.some((e) => e.event === "request"));
    assert.ok(events.some((e) => e.event === "denied"));
    assert.ok(events.every((e) => e.user === "user-a"));
    assert.ok(!audit.body.includes(TOKEN));
    assert.ok(!readFileSync(path.join(dir, "audit.jsonl"), "utf8").includes(TOKEN));
  });
});
