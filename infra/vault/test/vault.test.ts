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
import { controlHandler, ReplayGuard, SEAL_MAX_AGE_MS } from "../src/control.ts";
import { generateSealingKey, open, randomKey, seal, sealValue, secretAad, unsealPayload, type SealedPayload } from "../src/crypto.ts";
import { dataHandler } from "../src/data.ts";
import { isPublicIPv4, resolvePublic } from "../src/forward.ts";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Leases, MAX_TTL_SECONDS } from "../src/leases.ts";
import { hintFor, hostAllowed, injectedHeader, normalizeHost, normalizeHosts, normalizeInjection, scrubPatterns, scrubSpec } from "../src/policy.ts";
import { VmGuard } from "../src/vms.ts";
import { REDACTED, Scrubber, scrubText } from "../src/scrub.ts";
import { SecretStore } from "../src/store.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "vault-test-"));
const TOKEN = "glpat-abcdefghijklmnop1234";

const payloadFor = (overrides: Partial<SealedPayload> = {}): SealedPayload => ({
  value: TOKEN,
  user: "user-a",
  name: "api",
  hosts: ["api.example.com"],
  injection: { type: "basic", username: "oauth2" },
  writes: "ask",
  nonce: randomBytes(16).toString("base64url"),
  epoch: "test-epoch",
  iat: Date.now(),
  ...overrides,
});

describe("crypto", () => {
  it("opens what a browser sealed, with its settings, and nothing tampered with", async () => {
    const { key } = await generateSealingKey();
    const payload = payloadFor();
    const sealed = await sealValue(key.publicKey, key.kid, payload);
    assert.deepEqual(await unsealPayload(key, sealed), payload);
    await assert.rejects(unsealPayload(key, { ...sealed, kid: "0000000000000000" }));
    const ct = Buffer.from(sealed.ct, "base64url");
    ct[0] ^= 1;
    await assert.rejects(unsealPayload(key, { ...sealed, ct: ct.toString("base64url") }));
    const other = (await generateSealingKey()).key;
    await assert.rejects(unsealPayload(other, { ...sealed, kid: other.kid }));
  });

  it("accepts each envelope once, and only while it is fresh", () => {
    let now = 10_000_000;
    const guard = new ReplayGuard(() => now);
    const epoch = guard.epoch;
    const payload = payloadFor({ iat: now, epoch });
    assert.ok(guard.accept(payload));
    assert.ok(!guard.accept(payload));
    assert.ok(!guard.accept(payloadFor({ iat: now - SEAL_MAX_AGE_MS - 1, epoch })));
    assert.ok(!guard.accept(payloadFor({ iat: now + 10 * 60_000, epoch })));
    assert.ok(!guard.accept(payloadFor({ iat: now, nonce: "short", epoch })));
    // Sealed for an earlier process, even with a clock running ahead: a
    // restart cannot make a used envelope new again.
    const restarted = new ReplayGuard(() => now);
    assert.notEqual(restarted.epoch, epoch);
    assert.ok(!restarted.accept(payloadFor({ iat: now + 60_000, epoch })));
    now += SEAL_MAX_AGE_MS * 2;
    // Forgotten once it could no longer be fresh anyway.
    assert.ok(!guard.accept(payload));
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
  it("accepts host names, not wildcards, addresses or junk", () => {
    assert.equal(normalizeHost(" GitLab.com. "), "gitlab.com");
    for (const bad of ["*.example.org", "*.github.io", "a.*.com", "127.0.0.1", "localhost", "gitlab.com:443", "https://gitlab.com", "a..b", "-a.com", ""]) {
      assert.throws(() => normalizeHost(bad), bad);
    }
    assert.throws(() => normalizeHosts([]));
  });

  it("matches exact hosts only", () => {
    assert.ok(hostAllowed(["gitlab.com"], "GITLAB.COM"));
    assert.ok(!hostAllowed(["gitlab.com"], "api.gitlab.com"));
    assert.ok(!hostAllowed(["gitlab.com"], "gitlab.com.evil.net"));
  });

  it("gives no part of a value as a hint", () => {
    assert.equal(hintFor("correct-horse-battery"), "");
    assert.equal(hintFor(`${"x".repeat(28)}abcd`), "");
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
  it("finds the secret in the encodings a response might use", () => {
    const check = (secret: string, embedded: string[]) => {
      const spec = scrubSpec({ type: "basic", username: "oauth2" }, secret);
      for (const raw of embedded) {
        const text = Buffer.from(raw, "utf8").toString("latin1");
        const clean = scrubText(text, spec);
        assert.ok(clean.includes(REDACTED), `not found in ${raw}`);
        for (const view of [clean, Buffer.from(clean, "latin1").toString("utf8"), Buffer.from(clean, "base64").toString("utf8")]) {
          assert.ok(!view.includes(secret), `left in ${raw}`);
        }
      }
    };
    const secret = "s3cr/t+tok\u00e9n-value&<x>";
    const bytes = Buffer.from(secret);
    const ascii = (text: string) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    check(secret, [
      secret,
      encodeURIComponent(secret).toLowerCase(),
      encodeURIComponent(encodeURIComponent(secret)).toLowerCase(),
      JSON.stringify({ token: secret }),
      JSON.stringify({ token: secret }).replace(/\//g, "\\/"),
      ascii(secret),
      ascii(secret).toUpperCase().replace(/\\U/g, "\\u"),
      secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      [...secret].map((c) => `&#${c.codePointAt(0)};`).join(""),
      [...secret].map((c) => `&#X${c.codePointAt(0)!.toString(16).toUpperCase()};`).join(""),
      // Mixed: some characters escaped, some not.
      `s3cr\\/t%2Btok\\u00E9n-value&amp;&lt;x>`,
      bytes.toString("hex"),
      bytes.toString("base64url"),
      ...[0, 1, 2].map((pad) => Buffer.from(`${"p".repeat(pad)}{"token":"${secret}","more":1}`).toString("base64")),
      ...[0, 1, 2].map((pad) => Buffer.from(`${"p".repeat(pad)}{"token":"${secret}"}`).toString("base64url")),
    ]);
    // Numeric references with or without semicolons.
    check("abcdefgh", ["&#97&#98&#99&#100&#101&#102&#103&#104", "&#x61&#x62&#x63&#x64&#x65&#x66&#x67&#x68"]);
    // Round-two reproductions.
    check("abc/def/123456", ["abc%252fdef%252f123456", "abc%252Fdef%252F123456"]);
    check("abcdefghijklmnop", [ascii("abcdefghijklmnop")]);
    check("Abcdefgh123", ["\\u0041bcdefgh123"]);
  });

  it("leaves nothing of a secret at the edges of a base64 text", () => {
    const leftovers = (secret: string, document: string) => {
      const clean = scrubText(Buffer.from(document).toString("base64"), scrubSpec({ type: "bearer" }, secret));
      assert.ok(clean.includes(REDACTED), document);
      // Whatever base64 is left on either side, decoded on its own.
      return clean.split(REDACTED).map((part) => Buffer.from(part, "base64").toString("latin1")).join("|");
    };
    for (const secret of ["pw-12345", "abcdefgh"]) {
      for (const document of [secret, `X${secret}ZZ`, `XY${secret}Z`, `{"a":"${secret}"}`, `p${secret}`, `pp${secret}pp`]) {
        const left = leftovers(secret, document);
        for (let i = 0; i + 2 <= secret.length; i++) {
          assert.ok(!left.includes(secret.slice(i, i + 2)), `${document}: "${secret.slice(i, i + 2)}" left in ${left}`);
        }
      }
    }
  });

  it("finds named HTML references, and secrets that look like references", () => {
    for (const [secret, echoed] of [
      ["abcdefgh+", "abcdefgh&plus;"], ["pw/12345", "pw&sol;12345"], ["abc:defgh", "abc&colon;defgh"],
      ["p@ssw0rd-long", "p&commat;ssw0rd-long"], ["a&b<c>d\"e", "a&ampb&lt;c&GT;d&quot;e"],
      // A value containing what looks like a reference is found as it is.
      ["pass&#0123word", "x pass&#0123word y"], ["pa&#x0041bcdefg", "x pa&#x0041bcdefg y"],
      [`prefix&#${"0".repeat(64)}suffix`, `x prefix&#${"0".repeat(64)}suffix y`],
    ]) {
      const clean = scrubText(echoed, scrubSpec({ type: "bearer" }, secret));
      assert.ok(clean.includes(REDACTED) && !clean.includes(secret), `${secret}: ${clean}`);
    }
  });

  it("passes other bytes through unchanged, binary included", async () => {
    const body = Buffer.concat([
      Buffer.from([0x00, 0x26, 0x23, 0x30, 0x35, 0xff]), randomBytes(5000), Buffer.from("&#00000123;&#x000041"),
      Buffer.from(`&#${"0".repeat(300)}97;&#x${"0".repeat(100)}`), randomBytes(100),
    ]);
    const out: Buffer[] = [];
    await new Promise<void>((resolve) => {
      const scrub = new Scrubber(scrubSpec({ type: "bearer" }, TOKEN));
      scrub.on("data", (chunk: Buffer) => out.push(chunk));
      scrub.on("end", resolve);
      const chunks: Buffer[] = [];
      for (let i = 0; i < body.length; i += 333) chunks.push(body.subarray(i, i + 333));
      Readable.from(chunks).pipe(scrub);
    });
    assert.ok(Buffer.concat(out).equals(body));
  });

  it("removes the secret wherever a stream is split", async () => {
    const secret = "abcdefgh12";
    const spec = scrubSpec({ type: "basic", username: "oauth2" }, secret);
    const bodies = [
      `x ${Buffer.from(secret).toString("base64")} y`,
      `{"t":"${Buffer.from(`pp${secret}`).toString("base64")}"}`,
      Buffer.from(`oauth2:${secret}`).toString("base64"),
      [...secret].map((c) => `&#${"0".repeat(70)}${c.charCodeAt(0)}`).join(""),
      encodeURIComponent(encodeURIComponent(secret)).toLowerCase(),
    ];
    for (const body of bodies) {
      for (let split = 1; split < body.length; split++) {
        let out = "";
        const scrub = new Scrubber(spec);
        scrub.on("data", (chunk: Buffer) => (out += chunk.toString("latin1")));
        const ended = new Promise((resolve) => scrub.on("end", resolve));
        scrub.write(Buffer.from(body.slice(0, split), "latin1"));
        scrub.end(Buffer.from(body.slice(split), "latin1"));
        await ended;
        assert.ok(out.includes(REDACTED), `split ${split} of ${body}: ${out}`);
        const leftovers = out.split(REDACTED).map((part) => Buffer.from(part.replace(/[^A-Za-z0-9+/=_-]/g, ""), "base64").toString("latin1")).join("|");
        for (let i = 0; i + 2 <= secret.length; i++) {
          assert.ok(!out.includes(secret.slice(i, i + 3)) || secret.slice(i, i + 3).length < 3, `split ${split}: ${out}`);
          assert.ok(!leftovers.includes(secret.slice(i, i + 2)), `split ${split} of ${body}: "${secret.slice(i, i + 2)}" in ${leftovers}`);
        }
      }
    }
  });

  it("finds zero-padded references split across chunks", async () => {
    const secret = "abcdefgh";
    const padded = [...secret].map((c) => `&#${"0".repeat(2000)}${c.charCodeAt(0)};`).join("");
    const hexPadded = [...secret].map((c) => `&#x${"0".repeat(1500)}${c.charCodeAt(0).toString(16)}`).join("");
    for (const body of [`before ${padded} after`, `before ${hexPadded} after`]) {
      let out = "";
      await new Promise<void>((resolve) => {
        const scrub = new Scrubber(scrubSpec({ type: "bearer" }, secret));
        scrub.on("data", (chunk: Buffer) => (out += chunk.toString("latin1")));
        scrub.on("end", resolve);
        const bytes = Buffer.from(body);
        const chunks: Buffer[] = [];
        for (let i = 0; i < bytes.length; i += 40) chunks.push(bytes.subarray(i, i + 40));
        Readable.from(chunks).pipe(scrub);
      });
      assert.equal(out, `before ${REDACTED} after`);
    }
  });

  it("checks a long run of zeros quickly, and ends it rather than hold it all", async () => {
    const scrub = new Scrubber(scrubSpec({ type: "bearer" }, "abcdefgh"));
    scrub.resume();
    const failed = new Promise<Error>((resolve) => scrub.on("error", resolve));
    const started = performance.now();
    scrub.write(Buffer.from("&#"));
    const zeros = Buffer.alloc(64 * 1024, "0");
    for (let i = 0; i < 8 * 16 && !scrub.destroyed; i++) scrub.write(zeros);
    assert.match((await failed).message, /could not be checked/);
    assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
  });

  it("ends a response that would need unbounded holding back", async () => {
    const scrub = new Scrubber(scrubSpec({ type: "bearer" }, "abcdefgh"));
    scrub.resume();
    const failed = new Promise<Error>((resolve) => scrub.on("error", resolve));
    scrub.write(Buffer.from("&#"));
    const zeros = Buffer.alloc(1024 * 1024, "0");
    for (let i = 0; i < 9 && !scrub.destroyed; i++) scrub.write(zeros);
    assert.match((await failed).message, /could not be checked/);
  });

  it("removes a secret split across chunks", async () => {
    const chunks = ["prefix glpat-abc", "defghijklmnop", "1234 suffix ", TOKEN.slice(0, 3), TOKEN.slice(3)];
    let out = "";
    await new Promise<void>((resolve) => {
      const scrub = new Scrubber(scrubSpec({ type: "bearer" }, TOKEN));
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

describe("vm guard", () => {
  it("blocks lending while fenced, keeps a mark across restarts until cleared", async () => {
    const dir = tmp();
    const guard = new VmGuard(dir);
    assert.equal(guard.blocked("ws-01"), null);
    await guard.fence("ws-01", true);
    assert.match(guard.blocked("ws-01")!, /right now/);
    guard.unfence("ws-01");
    assert.match(guard.blocked("ws-01")!, /Settings/);
    const reloaded = new VmGuard(dir);
    await reloaded.load();
    assert.match(reloaded.blocked("ws-01")!, /Settings/);
    await reloaded.clear("ws-01");
    assert.equal(reloaded.blocked("ws-01"), null);
    await reloaded.fence("ws-02", false);
    reloaded.unfence("ws-02");
    assert.equal(reloaded.blocked("ws-02"), null);
  });
});

describe("audit", () => {
  it("counts as unavailable for a minute after a write fails", async () => {
    let now = 1_000_000;
    const dir = tmp();
    // The log's path is a directory: every write fails.
    const audit = new AuditLog(path.join(dir, "missing", "dir"), () => now);
    const log = console.error;
    console.error = () => undefined;
    try {
      audit.record({ user: "u", event: "denied" });
      await audit.recent("u", 1);
    } finally {
      console.error = log;
    }
    assert.equal(audit.saturated(), true);
    now += 61_000;
    assert.equal(audit.saturated(), false);
  });

  it("changes no secret it could not log first", async () => {
    const dir = tmp();
    const store = new SecretStore(dir, randomKey());
    const meta = await store.create("u", { name: "api", hosts: ["api.example.com"], injection: { type: "bearer" } }, TOKEN);
    const { key: sealing } = await generateSealingKey();
    // The log's directory does not exist: every write fails, and the first
    // failure is the one that must stop the change.
    const audit = new AuditLog(path.join(dir, "no", "such", "dir"));
    const replay = new ReplayGuard();
    const handler = controlHandler({ store, leases: new Leases(), audit, sealing, vms: new Set(["ws-a"]), guard: new VmGuard(dir), replay });
    const socketPath = path.join(dir, "control.sock");
    const server = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const log = console.error;
    console.error = () => undefined;
    try {
      // An invalid change is refused before anything is logged.
      assert.equal((await unixRequest(socketPath, "PATCH", `/v1/users/u/secrets/${meta.id}`, { description: 42 })).status, 400);
      assert.equal(audit.saturated(), false);
      const patch = await unixRequest(socketPath, "PATCH", `/v1/users/u/secrets/${meta.id}`, { writes: "allow" });
      assert.equal(patch.status, 503);
      assert.equal(store.get("u", meta.id)!.writes, "ask");
    } finally {
      console.error = log;
      server.close();
    }
    // Later changes are refused outright while the log is failing.
    const sealed = await sealValue(sealing.publicKey, sealing.kid, payloadFor({ user: "u", name: "two", epoch: replay.epoch }));
    const again = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => again.listen(socketPath + "2", resolve));
    try {
      assert.equal((await unixRequest(socketPath + "2", "POST", "/v1/users/u/secrets", { sealed })).status, 503);
      assert.equal((await unixRequest(socketPath + "2", "DELETE", `/v1/users/u/secrets/${meta.id}`)).status, 503);
      assert.equal(store.list("u").length, 1);
    } finally {
      again.close();
    }
  });

  it("ends only the response the scrubber cannot check, and keeps serving", async () => {
    const dir = tmp();
    const key = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=api.example.com", "-addext", "subjectAltName=DNS:api.example.com", "-keyout", key, "-out", certFile,
    ], { stdio: "ignore" });
    const cert = readFileSync(certFile);
    const upstream = createHttpsServer({ key: readFileSync(key), cert }, (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/zeros") {
        res.write("&#");
        const zeros = Buffer.alloc(64 * 1024, "0");
        let sent = 0;
        const more = () => {
          while (sent < 64 && res.write(zeros)) sent++;
          if (sent < 64) res.once("drain", () => { sent++; more(); });
          else res.end();
        };
        more();
        res.on("error", () => undefined);
      } else res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    const store = new SecretStore(dir, randomKey());
    const meta = await store.create("u", { name: "api", hosts: ["api.example.com"], injection: { type: "bearer" } }, TOKEN);
    const leases = new Leases();
    const lease = leases.issue({ userId: "u", vm: "ws-a", secretId: meta.id, access: "read" });
    const handler = dataHandler("ws-a", { store, leases, audit: new AuditLog(dir), forward: { resolve: async () => "127.0.0.1", ca: cert, port } });
    const socketPath = path.join(dir, "vm.sock");
    const server = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const cut = await new Promise<string>((resolve) => {
        const req = httpRequest({ socketPath, method: "GET", path: `/${lease.token}/api.example.com/zeros` }, (res) => {
          res.resume();
          res.on("end", () => resolve("ended"));
          res.on("error", () => resolve("cut"));
          res.on("aborted", () => resolve("cut"));
        });
        req.on("error", () => resolve("cut"));
        req.end();
      });
      assert.equal(cut, "cut");
      // The process is still here and serving.
      assert.equal((await unixRequest(socketPath, "GET", `/${lease.token}/api.example.com/ok`)).body, "ok");
    } finally {
      server.close();
      upstream.close();
    }
  });

  it("keeps a guest's mark when the guest starts while the owner's allowing is being logged", async () => {
    const dir = tmp();
    const audit = new AuditLog(dir);
    const guard = new VmGuard(dir);
    await guard.fence("ws-a", true);
    guard.unfence("ws-a");
    // Hold the "allowed" record on its way to disk.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const record = audit.record.bind(audit);
    audit.record = async (event) => {
      if (event.event === "allowed") await held;
      return record(event);
    };
    const { key: sealing } = await generateSealingKey();
    const handler = controlHandler({ store: new SecretStore(dir, randomKey()), leases: new Leases(), audit, sealing, vms: new Set(["ws-a"]), guard });
    const socketPath = path.join(dir, "control.sock");
    const server = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const allowing = unixRequest(socketPath, "DELETE", "/v1/vms/ws-a/mark", { user: "u" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await unixRequest(socketPath, "POST", "/v1/vms/ws-a/fence", { mark: true })).status, 200);
      release();
      assert.equal((await allowing).status, 409);
      await unixRequest(socketPath, "POST", "/v1/vms/ws-a/unfence");
      assert.match(guard.blocked("ws-a")!, /Settings/);
    } finally {
      server.close();
    }
  });

  it("forwards nothing it could not log first", async () => {
    const dir = tmp();
    const store = new SecretStore(dir, randomKey());
    const meta = await store.create("u", { name: "api", hosts: ["api.example.com"], injection: { type: "bearer" } }, TOKEN);
    const leases = new Leases();
    const lease = leases.issue({ userId: "u", vm: "ws-a", secretId: meta.id, access: "read" });
    const audit = new AuditLog(path.join(dir, "no", "such", "dir"));
    let resolved = 0;
    const handler = dataHandler("ws-a", { store, leases, audit, forward: { resolve: async () => { resolved++; return "127.0.0.1"; } } });
    const socketPath = path.join(dir, "vm.sock");
    const server = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const log = console.error;
    console.error = () => undefined;
    try {
      const reply = await unixRequest(socketPath, "GET", `/${lease.token}/api.example.com/x`);
      assert.equal(reply.status, 503);
      assert.equal(resolved, 0);
    } finally {
      console.error = log;
      server.close();
    }
  });

  it("reports a full backlog instead of silently growing", async () => {
    const audit = new AuditLog(tmp());
    assert.equal(audit.saturated(), false);
    for (let i = 0; i < 10_000; i++) audit.record({ user: "u", event: "denied" });
    assert.equal(audit.saturated(), true);
    await audit.recent("u", 1);
    assert.equal(audit.saturated(), false);
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

  it("last at most the default time, and are revoked by VM", () => {
    const now = 1_000_000;
    const leases = new Leases(() => now);
    const long = leases.issue({ userId: "u", vm: "ws-01", secretId: "s", access: "read", ttlSeconds: 86_400 });
    assert.equal(long.expiresAt, now + MAX_TTL_SECONDS * 1000);
    const other = leases.issue({ userId: "v", vm: "ws-02", secretId: "s", access: "read" });
    assert.equal(leases.revoke({}), 0);
    assert.equal(leases.revoke({ vm: "ws-01" }), 1);
    assert.equal(leases.check(long.token, "ws-01"), null);
    assert.ok(leases.check(other.token, "ws-02"));
  });
});

describe("store", () => {
  it("persists ciphertext only and keeps hosts fixed", async () => {
    const dir = tmp();
    const store = new SecretStore(dir, randomKey());
    const meta = await store.create("user-a", { name: "blog", hosts: ["gitlab.com"], injection: { type: "bearer" } }, TOKEN);
    assert.equal(meta.hint, "");
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

  it("never returns a hint stored by an earlier version", async () => {
    const dir = tmp();
    const master = randomKey();
    const store = new SecretStore(dir, master);
    const meta = await store.create("user-a", { name: "old", hosts: ["a.com"], injection: { type: "bearer" } }, TOKEN);
    const file = path.join(dir, "secrets.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.users["user-a"].secrets[meta.id].hint = "1234";
    writeFileSync(file, JSON.stringify(data));
    const reloaded = new SecretStore(dir, master);
    await reloaded.load();
    assert.equal(reloaded.list("user-a")[0].hint, "");
    assert.equal(reloaded.get("user-a", meta.id)!.hint, "");
  });

  it("forgets a user entirely", async () => {
    const dir = tmp();
    const master = randomKey();
    const store = new SecretStore(dir, master);
    const a = await store.create("user-a", { name: "one", hosts: ["a.com"], injection: { type: "bearer" } }, TOKEN);
    await store.create("user-b", { name: "two", hosts: ["b.com"], injection: { type: "bearer" } }, "other-secret-value");
    assert.equal(await store.purgeUser("user-a"), true);
    assert.equal(await store.purgeUser("user-a"), false);
    assert.throws(() => store.reveal("user-a", a.id));
    const data = JSON.parse(readFileSync(path.join(dir, "secrets.json"), "utf8"));
    assert.deepEqual(Object.keys(data.users), ["user-b"]);
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
  let sealKey: { kid: string; public_key: string; epoch: string };

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
        if (req.url === "/gzip") {
          // A server that compresses although identity was asked for.
          res.writeHead(200, { "content-encoding": "gzip" });
          res.end(gzipSync(`you sent ${req.headers.authorization}`));
          return;
        }
        if (req.url === "/cookie") {
          res.writeHead(200, { "set-cookie": "session=minted-from-the-token; HttpOnly", "content-type": "text/plain" });
          res.end("ok");
          return;
        }
        if (req.url === "/slow") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("start\n");
          const tick = setInterval(() => res.write("."), 20);
          res.on("close", () => clearInterval(tick));
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
    const guard = new VmGuard(dir);
    const forward = { resolve: async () => "127.0.0.1", ca: cert, port };
    const listen = async (socketPath: string, handler: (req: never, res: never) => Promise<void>) => {
      const server = createHttpServer((req, res) => void handler(req as never, res as never));
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      servers.push(server);
    };
    await listen(control, controlHandler({ store, leases, audit, sealing, vms: new Set(["ws-a", "ws-b"]), guard }));
    await listen(vmA, dataHandler("ws-a", { store, leases, audit, forward, maxInFlight: 2, leaseCheckMs: 20 }));
    await listen(vmB, dataHandler("ws-b", { store, leases, audit, forward }));
    sealKey = JSON.parse((await unixRequest(control, "GET", "/v1/seal-key")).body);
  });

  after(() => {
    for (const server of servers) server.close();
  });

  const createSecret = async (user: string, name: string, overrides: Partial<SealedPayload> = {}, outer: Record<string, unknown> = {}) => {
    const sealed = await sealValue(sealKey.public_key, sealKey.kid, payloadFor({ user, name, epoch: sealKey.epoch, ...overrides }));
    return unixRequest(control, "POST", `/v1/users/${user}/secrets`, { sealed, ...outer });
  };
  const streamUntilClosed = (socketPath: string, url: string) =>
    new Promise<string>((resolve, reject) => {
      const req = httpRequest({ socketPath, method: "GET", path: url }, (res) => {
        res.on("data", () => undefined);
        res.on("close", () => resolve("closed"));
        res.on("end", () => resolve("ended"));
        res.on("error", () => resolve("closed"));
      });
      req.on("error", () => resolve("closed"));
      req.on("timeout", () => reject(new Error("still open")));
      req.setTimeout(5000);
      req.end();
    });
  const lease = async (user: string, vm: string, secret: string, access = "read") =>
    JSON.parse((await unixRequest(control, "POST", "/v1/leases", { user, vm, secret, access, chat: "chat-1" })).body) as { lease: string };

  it("creates a secret from a sealed value and never returns it", async () => {
    // The settings beside the envelope are ignored: only what was sealed counts.
    const created = await createSecret("user-a", "api", {}, { name: "other", hosts: ["attacker.example"], injection: { type: "bearer" } });
    assert.equal(created.status, 201);
    assert.ok(!created.body.includes(TOKEN));
    assert.deepEqual(JSON.parse(created.body).secret.hosts, ["api.example.com"]);
    assert.equal(JSON.parse(created.body).secret.name, "api");
    const listed = await unixRequest(control, "GET", "/v1/users/user-a/secrets");
    assert.ok(!listed.body.includes(TOKEN));
    assert.equal(JSON.parse(listed.body).secrets[0].name, "api");
    const plain = await unixRequest(control, "POST", "/v1/users/user-a/secrets", {
      name: "plain", hosts: ["api.example.com"], injection: { type: "bearer" }, value: TOKEN,
    });
    assert.equal(plain.status, 400);
  });

  it("refuses an envelope sealed for another account, replayed, or stale", async () => {
    const sealed = await sealValue(sealKey.public_key, sealKey.kid, payloadFor({ user: "user-a", name: "replayed", epoch: sealKey.epoch }));
    assert.equal((await unixRequest(control, "POST", "/v1/users/user-b/secrets", { sealed })).status, 400);
    assert.equal((await unixRequest(control, "POST", "/v1/users/user-a/secrets", { sealed })).status, 201);
    const again = await unixRequest(control, "POST", "/v1/users/user-a/secrets", { sealed });
    assert.equal(again.status, 400);
    assert.match(again.body, /already used/);
    assert.equal((await createSecret("user-a", "stale", { iat: Date.now() - SEAL_MAX_AGE_MS - 1000 })).status, 400);
    assert.equal((await createSecret("user-a", "wild", { hosts: ["*.example.com"] })).status, 400);
    assert.equal((await createSecret("user-a", "old-epoch", { epoch: "from-an-earlier-process" })).status, 400);
    const id = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-a/secrets")).body).secrets.find((s: { name: string }) => s.name === "replayed").id;
    await unixRequest(control, "DELETE", `/v1/users/user-a/secrets/${id}`);
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

  it("refuses compressed responses, and drops cookies, ranges and method overrides", async () => {
    seen = [];
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const gzip = await unixRequest(vmA, "GET", `/${token}/api.example.com/gzip`);
    assert.equal(gzip.status, 502);
    assert.match(gzip.body, /compressed/);
    const cookie = await unixRequest(vmA, "GET", `/${token}/api.example.com/cookie`);
    assert.equal(cookie.status, 200);
    assert.equal(cookie.headers["set-cookie"], undefined);
    await unixRequest(vmA, "GET", `/${token}/api.example.com/x`, undefined, {
      range: "bytes=10-12", "if-range": "x", "x-http-method-override": "DELETE", "x-http-method": "DELETE", "accept-encoding": "gzip",
    });
    const sent = seen.at(-1)!.headers;
    for (const header of ["range", "if-range", "x-http-method-override", "x-http-method"]) assert.equal(sent[header], undefined, header);
    assert.equal(sent["accept-encoding"], "identity");
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x?_method=DELETE`)).status, 403);
    const { lease: write } = await lease("user-a", "ws-a", "api", "write");
    assert.equal((await unixRequest(vmA, "GET", `/${write}/api.example.com/x?_method=DELETE`)).status, 200);
  });

  it("caps requests in flight per VM, and stops them when the lease is revoked", async () => {
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const first = streamUntilClosed(vmA, `/${token}/api.example.com/slow`);
    const second = streamUntilClosed(vmA, `/${token}/api.example.com/slow`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x`)).status, 429);
    const revoked = await unixRequest(control, "DELETE", "/v1/leases", { vm: "ws-a" });
    assert.ok(JSON.parse(revoked.body).revoked >= 1);
    assert.deepEqual(await Promise.all([first, second]), ["closed", "closed"]);
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x`)).status, 401);
    assert.equal((await unixRequest(control, "DELETE", "/v1/leases", { vm: "ws-unknown" })).status, 400);
  });

  it("fences a VM a guest works in: revokes, lends nothing, and stays paused until cleared", async () => {
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const fenced = JSON.parse((await unixRequest(control, "POST", "/v1/vms/ws-a/fence", { mark: true })).body);
    assert.equal(fenced.revoked, 1);
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x`)).status, 401);
    const during = await unixRequest(control, "POST", "/v1/leases", { user: "user-a", vm: "ws-a", secret: "api", access: "read" });
    assert.equal(during.status, 409);
    assert.match(during.body, /right now/);
    assert.equal((await unixRequest(control, "DELETE", "/v1/vms/ws-a/mark", { user: "user-a" })).status, 409);
    await unixRequest(control, "POST", "/v1/vms/ws-a/unfence");
    const after = await unixRequest(control, "POST", "/v1/leases", { user: "user-a", vm: "ws-a", secret: "api", access: "read" });
    assert.equal(after.status, 409);
    assert.match(after.body, /Settings/);
    assert.ok(JSON.parse((await unixRequest(control, "GET", "/v1/vms/ws-a")).body).guested_since);
    assert.equal((await unixRequest(control, "DELETE", "/v1/vms/ws-a/mark")).status, 400);
    assert.equal((await unixRequest(control, "DELETE", "/v1/vms/ws-a/mark", { user: "user-a" })).status, 200);
    const allowed = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-a/audit?limit=5")).body).events;
    assert.ok(allowed.some((e: { event: string; vm?: string }) => e.event === "allowed" && e.vm === "ws-a"));
    assert.equal((await unixRequest(control, "POST", "/v1/leases", { user: "user-a", vm: "ws-a", secret: "api", access: "read" })).status, 201);
    // A fence without a mark (a wipe) leaves nothing paused behind it.
    await unixRequest(control, "POST", "/v1/vms/ws-b/fence", {});
    await unixRequest(control, "POST", "/v1/vms/ws-b/unfence");
    assert.equal(JSON.parse((await unixRequest(control, "GET", "/v1/vms/ws-b")).body).guested_since, null);
    assert.equal((await unixRequest(control, "POST", "/v1/vms/ws-unknown/fence", {})).status, 400);
  });

  it("answers a refused request without reading its body", async () => {
    const { lease: token } = await lease("user-a", "ws-a", "api");
    const reply = await new Promise<number>((resolve, reject) => {
      // A body that never ends: a refused request must still be answered and closed.
      const req = httpRequest({ socketPath: vmA, method: "POST", path: `/${token}/api.example.com/x`, headers: { "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        res.on("close", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", () => resolve(-1));
      req.setTimeout(3000, () => reject(new Error("refused request held open")));
      req.write("x".repeat(1000));
    });
    assert.ok(reply === 403 || reply === -1, String(reply));
  });

  it("attaches the secret the way the lease asks, never anywhere else", async () => {
    seen = [];
    const leased = await unixRequest(control, "POST", "/v1/leases", {
      user: "user-a", vm: "ws-a", secret: "api", access: "read", injection: { type: "header", name: "PRIVATE-TOKEN" },
    });
    assert.equal(leased.status, 201);
    assert.deepEqual(JSON.parse(leased.body).injection, { type: "header", name: "PRIVATE-TOKEN" });
    const token = JSON.parse(leased.body).lease;
    // The caller's own credentials never travel with the secret.
    const reply = await unixRequest(vmA, "GET", `/${token}/api.example.com/x`, undefined, {
      authorization: "Bearer attacker", cookie: "session=attacker", "x-api-key": "attacker", "user-agent": "agent",
    });
    assert.equal(seen.at(-1)!.headers["private-token"], TOKEN);
    assert.equal(seen.at(-1)!.headers.authorization, undefined);
    assert.equal(seen.at(-1)!.headers.cookie, undefined);
    assert.equal(seen.at(-1)!.headers["x-api-key"], undefined);
    assert.equal(seen.at(-1)!.headers["user-agent"], "agent");
    assert.ok(!reply.body.includes(TOKEN));
    // The stored way, when the lease names none.
    const plain = JSON.parse((await unixRequest(control, "POST", "/v1/leases", { user: "user-a", vm: "ws-a", secret: "api", access: "read" })).body);
    assert.deepEqual(plain.injection, { type: "basic", username: "oauth2" });
    for (const injection of [
      { type: "header", name: "Host" }, { type: "header", name: "Cookie" }, { type: "basic", username: "a:b" }, { type: "nope" },
      // Headers servers log or store where the caller can read them back.
      { type: "header", name: "User-Agent" }, { type: "header", name: "Referer" }, { type: "header", name: "X-Request-Id" },
      { type: "header", name: "x-amz-meta-token" }, { type: "header", name: "x-goog-meta-api-key" },
    ]) {
      const refused = await unixRequest(control, "POST", "/v1/leases", { user: "user-a", vm: "ws-a", secret: "api", access: "read", injection });
      assert.equal(refused.status, 400, JSON.stringify(injection));
    }
  });

  it("replaces a secret with a new value and settings, as one change", async () => {
    const first = JSON.parse((await createSecret("user-r", "deploy")).body).secret;
    await createSecret("user-r", "other");
    const { lease: old } = await lease("user-r", "ws-a", "deploy");
    const replaced = await createSecret("user-r", "deploy", { replaces: first.id, hosts: ["other.example.com"], injection: { type: "bearer" } });
    assert.equal(replaced.status, 201);
    const secrets = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-r/secrets")).body).secrets;
    assert.deepEqual(secrets.map((s: { name: string }) => s.name).sort(), ["deploy", "other"]);
    const now = secrets.find((s: { name: string }) => s.name === "deploy");
    assert.notEqual(now.id, first.id);
    assert.deepEqual(now.hosts, ["other.example.com"]);
    assert.equal((await unixRequest(vmA, "GET", `/${old}/api.example.com/x`)).status, 401);
    // Not someone else's secret, not a missing one, and not onto another's name.
    assert.equal((await createSecret("user-x", "deploy", { replaces: now.id })).status, 404);
    assert.equal((await createSecret("user-r", "deploy", { replaces: "sec_missing" })).status, 404);
    // Only under its own name: the one the person was shown.
    assert.equal((await createSecret("user-r", "other", { replaces: now.id })).status, 400);
    const events = JSON.parse((await unixRequest(control, "GET", "/v1/users/user-r/audit?limit=10")).body).events;
    assert.ok(events.some((e: { event: string }) => e.event === "replaced"));
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

  it("forgets a user and their leases", async () => {
    await createSecret("user-c", "api");
    const { lease: token } = await lease("user-c", "ws-a", "api");
    const purged = JSON.parse((await unixRequest(control, "DELETE", "/v1/users/user-c")).body);
    assert.equal(purged.purged, true);
    assert.equal(purged.revoked, 1);
    assert.equal(JSON.parse((await unixRequest(control, "GET", "/v1/users/user-c/secrets")).body).secrets.length, 0);
    assert.equal((await unixRequest(vmA, "GET", `/${token}/api.example.com/x`)).status, 401);
  });
});
