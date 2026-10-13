// The control API, on a Unix socket only the backend can reach. It manages
// secrets and issues leases; nothing on it returns a secret's value.
//
//   GET    /v1/seal-key                     the key browsers seal values to
//   GET    /v1/users/:user/secrets          metadata, never values
//   POST   /v1/users/:user/secrets          { name, description?, hosts, injection, writes?, sealed }
//   PATCH  /v1/users/:user/secrets/:id      { description?, writes? }
//   DELETE /v1/users/:user/secrets/:id      also revokes its leases
//   GET    /v1/users/:user/audit?limit=n
//   POST   /v1/leases                       { user, vm, secret (id or name), access, ttl_seconds?, chat? }
//   DELETE /v1/leases                       { user, chat?, token? }
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLog } from "./audit.ts";
import { unsealValue, type SealedValue, type SealingKey } from "./crypto.ts";
import type { Leases } from "./leases.ts";
import { PolicyError } from "./policy.ts";
import { Conflict, NotFound, USER_ID, type SecretStore } from "./store.ts";

export type ControlPlane = {
  store: SecretStore;
  leases: Leases;
  audit: AuditLog;
  sealing: SealingKey;
  /** The VMs this host runs; a lease names one of them. */
  vms: Set<string>;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 64 * 1024;

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

  const route = async (req: IncomingMessage): Promise<[number, unknown]> => {
    const url = new URL(req.url ?? "/", "http://vault");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/v1/seal-key") {
      return [200, { kid: plane.sealing.kid, public_key: plane.sealing.publicKey, alg: "ECDH-P256+HKDF-SHA256+A256GCM" }];
    }
    if (method === "GET" && url.pathname === "/v1/health") return [200, { ok: true }];

    if (parts[0] === "v1" && parts[1] === "users" && parts[2]) {
      const userId = userFrom(parts[2]);
      if (parts[3] === "secrets" && parts.length === 4) {
        if (method === "GET") return [200, { secrets: store.list(userId) }];
        if (method === "POST") {
          const body = await readJson(req);
          let value: string;
          try {
            value = (await unsealValue(plane.sealing, sealedFrom(body.sealed))).toString("utf8");
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, "the sealed value could not be opened; reload and try again");
          }
          const meta = await store.create(userId, body as never, value);
          audit.record({ user: userId, event: "created", secret: meta.id, secret_name: meta.name });
          return [201, { secret: meta }];
        }
      }
      if (parts[3] === "secrets" && parts[4] && parts.length === 5) {
        const secretId = parts[4];
        if (method === "PATCH") {
          const body = await readJson(req);
          const meta = await store.update(userId, secretId, body);
          audit.record({ user: userId, event: "updated", secret: meta.id, secret_name: meta.name });
          return [200, { secret: meta }];
        }
        if (method === "DELETE") {
          const meta = store.get(userId, secretId);
          await store.remove(userId, secretId);
          leases.revoke({ userId, secretId });
          audit.record({ user: userId, event: "deleted", secret: secretId, secret_name: meta?.name });
          return [200, { deleted: true }];
        }
      }
      if (parts[3] === "audit" && parts.length === 4 && method === "GET") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return [200, { events: await audit.recent(userId, limit) }];
      }
    }

    if (url.pathname === "/v1/leases") {
      const body = await readJson(req);
      const userId = userFrom(body.user);
      if (method === "POST") {
        const vm = typeof body.vm === "string" ? body.vm : "";
        if (!plane.vms.has(vm)) throw new HttpError(400, "unknown vm");
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
        audit.record({ user: userId, event: "lease", secret: secret.id, secret_name: secret.name, vm, chat: chatId, access });
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
