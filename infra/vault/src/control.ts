// The control API, on a Unix socket only the backend can reach. It manages
// secrets and issues leases; nothing on it returns a secret's value.
//
//   GET    /v1/seal-key                     the key browsers seal values to
//   GET    /v1/users/:user/secrets          metadata, never values
//   POST   /v1/users/:user/secrets          { sealed }: the browser sealed the value with its
//                                           settings (crypto.ts); only those are used
//   PATCH  /v1/users/:user/secrets/:id      { description?, writes? }
//   DELETE /v1/users/:user/secrets/:id      also revokes its leases
//   DELETE /v1/users/:user                  forgets the user: every secret, their key, their leases
//   GET    /v1/users/:user/audit?limit=n
//   POST   /v1/leases                       { user, vm, secret (id or name), access, ttl_seconds?, chat? }
//   DELETE /v1/leases                       { user, chat?, token?, vm? } or { vm }
//   GET    /v1/vms/:vm                      { guests, guested_since }
//   POST   /v1/vms/:vm/fence                { mark }: revoke everything lent to the VM and lend
//                                           nothing until unfenced; with mark, stay paused after
//   POST   /v1/vms/:vm/unfence
//   DELETE /v1/vms/:vm/mark                 { user }: allow leases again (the owner chose to, or it was wiped)
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLog } from "./audit.ts";
import { unsealPayload, type SealedPayload, type SealedValue, type SealingKey } from "./crypto.ts";
import type { Leases } from "./leases.ts";
import type { VmGuard } from "./vms.ts";
import { PolicyError } from "./policy.ts";
import { Conflict, NotFound, USER_ID, type SecretStore } from "./store.ts";

export type ControlPlane = {
  store: SecretStore;
  leases: Leases;
  audit: AuditLog;
  sealing: SealingKey;
  /** The VMs this host runs; a lease names one of them. */
  vms: Set<string>;
  guard: VmGuard;
  replay?: ReplayGuard;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 64 * 1024;
/** How old a sealed envelope may be, and how far a browser's clock may run ahead. */
export const SEAL_MAX_AGE_MS = 10 * 60 * 1000;
const SEAL_MAX_SKEW_MS = 2 * 60 * 1000;

/**
 * Nonces of envelopes already used, for as long as an envelope stays fresh.
 * They are kept in memory, so each process has its own random epoch, which
 * the browser seals into the envelope (from /v1/seal-key): an envelope sealed
 * for an earlier process is refused, and a restart cannot make a used one new.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  readonly epoch = randomBytes(16).toString("base64url");
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** True the first time a fresh envelope's nonce is seen. */
  accept(payload: Pick<SealedPayload, "nonce" | "iat" | "epoch">): boolean {
    if (payload.epoch !== this.epoch) return false;
    const now = this.now();
    for (const [nonce, expires] of this.seen) if (expires <= now) this.seen.delete(nonce);
    if (payload.iat > now + SEAL_MAX_SKEW_MS || payload.iat < now - SEAL_MAX_AGE_MS) return false;
    if (payload.nonce.length < 16 || payload.nonce.length > 128 || this.seen.has(payload.nonce)) return false;
    if (this.seen.size >= 100_000) return false;
    this.seen.set(payload.nonce, payload.iat + SEAL_MAX_AGE_MS + SEAL_MAX_SKEW_MS);
    return true;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function sealedFrom(value: unknown): SealedValue {
  const sealed = (value ?? {}) as Record<string, unknown>;
  for (const field of ["kid", "epk", "iv", "ct"]) {
    if (typeof sealed[field] !== "string" || !(sealed[field] as string).length) {
      throw new HttpError(400, "the value must be sealed to the vault's key");
    }
  }
  return sealed as unknown as SealedValue;
}

function userFrom(value: unknown): string {
  if (typeof value !== "string" || !USER_ID.test(value)) throw new HttpError(400, "bad user id");
  return value;
}

export function controlHandler(plane: ControlPlane) {
  const { store, leases, audit } = plane;
  const replay = plane.replay ?? new ReplayGuard();
  const logFirst = async (event: Parameters<AuditLog["record"]>[0]) => {
    if (!(await audit.record(event))) throw new HttpError(503, "the vault is busy; try again shortly");
  };

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://vault");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    // Changes and leases are logged for their owner; while the log is
    // failing, none is made. Revoking (DELETE /v1/leases, fences) only takes
    // things away and stays allowed.
    const takesAway = (method === "DELETE" && url.pathname === "/v1/leases") || parts[1] === "vms";
    if (method !== "GET" && !takesAway && audit.saturated()) throw new HttpError(503, "the vault is busy; try again shortly");

    if (method === "GET" && url.pathname === "/v1/seal-key") {
      return [200, {
        kid: plane.sealing.kid,
        public_key: plane.sealing.publicKey,
        // For the host to pin into the web app's build (infra/node-a/staging.nix).
        sha256: createHash("sha256").update(plane.sealing.publicRaw).digest("hex"),
        // Sealed into each envelope: one sealed for an earlier process is refused.
        epoch: replay.epoch,
        alg: "ECDH-P256+HKDF-SHA256+A256GCM",
      }];
    }
    if (method === "GET" && url.pathname === "/v1/health") return [200, { ok: true }];

    if (parts[0] === "v1" && parts[1] === "users" && parts[2]) {
      const userId = userFrom(parts[2]);
      if (parts[3] === "secrets" && parts.length === 4) {
        if (method === "GET") return [200, { secrets: store.list(userId) }];
        if (method === "POST") {
          const body = await readJson(req);
          let payload: SealedPayload;
          try {
            payload = await unsealPayload(plane.sealing, sealedFrom(body.sealed));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, "the sealed value could not be opened; reload and try again");
          }
          // Everything below comes from inside the envelope, which only the
          // browser that sealed it could have written.
          if (payload.user !== userId) throw new HttpError(400, "the value was sealed for another account");
          if (!replay.accept(payload)) throw new HttpError(400, "this sealed value is stale or was already used; enter it again");
          // Logged before it happens: a change that cannot be logged is not made.
          const name = store.checkCreate(userId, payload, payload.value);
          const id = store.newId();
          await logFirst({ user: userId, event: "created", secret: id, secret_name: name });
          const meta = await store.create(userId, payload, payload.value, id);
          return [201, { secret: meta }];
        }
      }
      if (parts[3] === "secrets" && parts[4] && parts.length === 5) {
        const secretId = parts[4];
        if (method === "PATCH") {
          const body = await readJson(req);
          const current = store.checkUpdate(userId, secretId, body);
          await logFirst({ user: userId, event: "updated", secret: secretId, secret_name: current.name });
          const meta = await store.update(userId, secretId, body);
          return [200, { secret: meta }];
        }
        if (method === "DELETE") {
          const meta = store.get(userId, secretId);
          if (!meta) throw new NotFound("no such secret");
          // Its leases end whether or not the rest can be done.
          leases.revoke({ userId, secretId });
          await logFirst({ user: userId, event: "deleted", secret: secretId, secret_name: meta.name });
          await store.remove(userId, secretId);
          return [200, { deleted: true }];
        }
      }
      if (parts.length === 3 && method === "DELETE") {
        const revoked = leases.revoke({ userId });
        if (store.hasUser(userId)) await logFirst({ user: userId, event: "purged" });
        const purged = await store.purgeUser(userId);
        return [200, { purged, revoked }];
      }
      if (parts[3] === "audit" && parts.length === 4 && method === "GET") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return [200, { events: await audit.recent(userId, limit) }];
      }
    }

    if (parts[0] === "v1" && parts[1] === "vms" && parts[2]) {
      const vm = parts[2];
      if (!plane.vms.has(vm)) throw new HttpError(400, "unknown vm");
      const { guard } = plane;
      if (parts.length === 3 && method === "GET") return [200, guard.state(vm)];
      if (parts[3] === "fence" && parts.length === 4 && method === "POST") {
        const body = await readJson(req);
        // Fence first, then revoke, with no await between them or before the
        // next lease check: nothing can be lent in between.
        const marked = guard.fence(vm, body.mark === true);
        const revoked = leases.revoke({ vm });
        try {
          await marked;
        } catch (error) {
          guard.unfence(vm);
          throw error;
        }
        return [200, { revoked }];
      }
      if (parts[3] === "unfence" && parts.length === 4 && method === "POST") {
        guard.unfence(vm);
        return [200, guard.state(vm)];
      }
      if (parts[3] === "mark" && parts.length === 4 && method === "DELETE") {
        // Lending again is a change like any other: logged for the user who
        // allowed it (or whose VM was wiped), first.
        const body = await readJson(req);
        const userId = userFrom(body.user);
        if (guard.state(vm).guests > 0) throw new HttpError(409, "someone is working in this workstation right now");
        if (audit.saturated()) throw new HttpError(503, "the vault is busy; try again shortly");
        if (guard.state(vm).guested_since) await logFirst({ user: userId, event: "allowed", vm });
        // A guest may have started while the record was written: check again.
        // clear() drops the mark before it awaits anything, so nothing can
        // start between this check and the mark going.
        if (guard.state(vm).guests > 0) throw new HttpError(409, "someone is working in this workstation right now");
        await guard.clear(vm);
        return [200, guard.state(vm)];
      }
    }

    if (url.pathname === "/v1/leases") {
      const body = await readJson(req);
      if (method === "DELETE" && body.user === undefined) {
        // Everything lent to one VM: before someone else works in it, or it is wiped.
        const vm = typeof body.vm === "string" ? body.vm : "";
        if (!plane.vms.has(vm)) throw new HttpError(400, "unknown vm");
        return [200, { revoked: leases.revoke({ vm }) }];
      }
      const userId = userFrom(body.user);
      if (method === "POST") {
        const vm = typeof body.vm === "string" ? body.vm : "";
        if (!plane.vms.has(vm)) throw new HttpError(400, "unknown vm");
        const blocked = plane.guard.blocked(vm);
        if (blocked) throw new HttpError(409, blocked);
        const ref = typeof body.secret === "string" ? body.secret : "";
        const secret = store.get(userId, ref) ?? store.findByName(userId, ref.toLowerCase());
        if (!secret) throw new HttpError(404, "no such secret");
        const access = body.access === "write" ? "write" : "read";
        const chatId = typeof body.chat === "string" ? body.chat.slice(0, 128) : null;
        const lease = leases.issue({
          userId,
          vm,
          secretId: secret.id,
          access,
          ttlSeconds: typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined,
          chatId,
        });
        if (!(await audit.record({ user: userId, event: "lease", secret: secret.id, secret_name: secret.name, vm, chat: chatId, access }))) {
          leases.revoke({ token: lease.token });
          throw new HttpError(503, "the vault is busy; try again shortly");
        }
        return [201, {
          lease: lease.token,
          secret: secret.name,
          hosts: secret.hosts,
          access,
          expires_at: new Date(lease.expiresAt).toISOString(),
        }];
      }
      if (method === "DELETE") {
        const revoked = leases.revoke({
          userId,
          chatId: typeof body.chat === "string" ? body.chat : undefined,
          token: typeof body.token === "string" ? body.token : undefined,
          vm: typeof body.vm === "string" ? body.vm : undefined,
        });
        return [200, { revoked }];
      }
    }
    throw new HttpError(404, "not found");
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let status: number;
    let body: unknown;
    try {
      [status, body] = await route(req);
    } catch (error) {
      if (error instanceof HttpError) [status, body] = [error.status, { error: error.message }];
      else if (error instanceof PolicyError) [status, body] = [400, { error: error.message }];
      else if (error instanceof NotFound) [status, body] = [404, { error: error.message }];
      else if (error instanceof Conflict) [status, body] = [409, { error: error.message }];
      else {
        console.error("control request failed:", (error as Error).message);
        [status, body] = [500, { error: "internal error" }];
      }
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
}
