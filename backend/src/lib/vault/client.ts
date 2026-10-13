// The secrets vault's control API (infra/vault), on a Unix socket the
// backend container mounts. The vault holds its own keys: nothing here can
// read a stored value, and a new value arrives sealed by the browser, so the
// backend only relays it.
import { request } from "node:http";
import type { VaultInjection, VaultSecret } from "@mike/contracts";

export type { VaultInjection, VaultSecret };

export type VaultAccess = "read" | "write";

export type SealedValue = { kid: string; epk: string; iv: string; ct: string };

export type VaultLease = {
  lease: string;
  secret: string;
  hosts: string[];
  access: VaultAccess;
  /** How this lease attaches the secret. */
  injection?: VaultInjection;
  expires_at: string;
};

export type VaultAuditEvent = {
  at: string;
  event: string;
  secret?: string;
  secret_name?: string;
  vm?: string;
  access?: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  reason?: string;
};

/** The vault answered with a 4xx; `message` is written for the person who asked. */
export class VaultRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The vault is not configured or not reachable. */
export class VaultUnavailableError extends Error {}

type Env = Record<string, string | undefined>;

export function vaultSocket(env: Env = process.env): string | null {
  return env.VAULT_CONTROL_SOCKET?.trim() || null;
}

export function vaultEnabled(env: Env = process.env): boolean {
  return vaultSocket(env) !== null;
}

/** The URL a workstation reaches the vault on (infra/workstation/guest.nix). */
export const VAULT_GUEST_URL = "http://127.0.0.1:8200";

const TIMEOUT_MS = 10_000;

function call<T>(method: string, path: string, body?: unknown, env: Env = process.env): Promise<T> {
  const socketPath = vaultSocket(env);
  if (!socketPath) return Promise.reject(new VaultUnavailableError("the vault is not configured"));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        timeout: TIMEOUT_MS,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new VaultUnavailableError("the vault sent an unreadable reply"));
            return;
          }
          const status = res.statusCode ?? 500;
          if (status >= 200 && status < 300) resolve(parsed as T);
          else if (status >= 400 && status < 500) {
            const message = (parsed as { error?: unknown })?.error;
            reject(new VaultRequestError(status, typeof message === "string" ? message : "the vault refused the request"));
          } else reject(new VaultUnavailableError(`the vault failed (${status})`));
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new VaultUnavailableError("the vault did not answer")));
    req.on("error", (error) =>
      reject(error instanceof VaultUnavailableError ? error : new VaultUnavailableError("the vault is not reachable")),
    );
    req.end(payload);
  });
}

const userPath = (userId: string) => `/v1/users/${encodeURIComponent(userId)}`;

export async function vaultSealKey(): Promise<{ kid: string; public_key: string; sha256: string; epoch: string; alg: string }> {
  return call("GET", "/v1/seal-key");
}

export async function listVaultSecrets(userId: string): Promise<VaultSecret[]> {
  return (await call<{ secrets: VaultSecret[] }>("GET", `${userPath(userId)}/secrets`)).secrets;
}

export async function createVaultSecret(
  userId: string,
  input: {
    name: string;
    description?: string;
    hosts: string[];
    injection: VaultInjection;
    writes?: "ask" | "allow";
    sealed: SealedValue;
  },
): Promise<VaultSecret> {
  return (await call<{ secret: VaultSecret }>("POST", `${userPath(userId)}/secrets`, input)).secret;
}

export async function updateVaultSecret(
  userId: string,
  secretId: string,
  input: { description?: string; writes?: "ask" | "allow" },
): Promise<VaultSecret> {
  return (await call<{ secret: VaultSecret }>("PATCH", `${userPath(userId)}/secrets/${encodeURIComponent(secretId)}`, input)).secret;
}

export async function deleteVaultSecret(userId: string, secretId: string): Promise<void> {
  await call("DELETE", `${userPath(userId)}/secrets/${encodeURIComponent(secretId)}`);
}

export async function vaultAudit(userId: string, limit = 100): Promise<VaultAuditEvent[]> {
  return (await call<{ events: VaultAuditEvent[] }>("GET", `${userPath(userId)}/audit?limit=${limit}`)).events;
}

export async function issueVaultLease(input: {
  userId: string;
  vm: string;
  /** The secret's id or name. */
  secret: string;
  access: VaultAccess;
  chatId?: string | null;
  ttlSeconds?: number;
  /** How to attach it for this lease; the stored way when absent. */
  injection?: VaultInjection | null;
}): Promise<VaultLease> {
  return call("POST", "/v1/leases", {
    user: input.userId,
    vm: input.vm,
    secret: input.secret,
    access: input.access,
    chat: input.chatId ?? undefined,
    ttl_seconds: input.ttlSeconds,
    ...(input.injection ? { injection: input.injection } : {}),
  });
}

/** Revokes leases: a user's (for one chat, or on one VM), or everything lent to one VM. */
export async function revokeVaultLeases(
  filter: { userId: string; chatId?: string | null; vm?: string } | { vm: string },
): Promise<number> {
  const body = "userId" in filter
    ? { user: filter.userId, ...(filter.chatId ? { chat: filter.chatId } : {}), ...(filter.vm ? { vm: filter.vm } : {}) }
    : { vm: filter.vm };
  return (await call<{ revoked: number }>("DELETE", "/v1/leases", body)).revoked;
}

const vmPath = (vm: string) => `/v1/vms/${encodeURIComponent(vm)}`;

/**
 * Revokes everything lent to `vm` and lends it nothing until `unfenceVaultVm`.
 * With `mark` (a guest is about to work in it), leases stay paused afterwards
 * until the owner allows them again or the VM is wiped.
 */
export async function fenceVaultVm(vm: string, mark: boolean): Promise<void> {
  await call("POST", `${vmPath(vm)}/fence`, { mark });
}

export async function unfenceVaultVm(vm: string): Promise<void> {
  await call("POST", `${vmPath(vm)}/unfence`, {});
}

export type VaultVmState = { guests: number; guested_since: string | null };

export async function vaultVmState(vm: string): Promise<VaultVmState> {
  return call("GET", vmPath(vm));
}

/** Allows leases in `vm` again after a guest worked in it; logged for `userId`. */
export async function clearVaultVmMark(vm: string, userId: string): Promise<VaultVmState> {
  return call("DELETE", `${vmPath(vm)}/mark`, { user: userId });
}

/** Forgets a user in the vault: every secret, their key and their leases. */
export async function purgeVaultUser(userId: string): Promise<void> {
  await call("DELETE", userPath(userId));
}

const attachment = (injection: VaultInjection) =>
  injection.type === "basic"
    ? `HTTP basic auth, username ${injection.username}`
    : injection.type === "header"
      ? `the ${injection.name} header`
      : "Authorization: Bearer";

/** How the agent uses a lease, returned with it. */
export function leaseInstructions(lease: VaultLease): string {
  const base = `$MIKE_VAULT_URL/${lease.lease}`;
  const host = lease.hosts[0] ?? "<host>";
  return [
    `Lease for "${lease.secret}" (${lease.access}), valid until ${lease.expires_at} or the end of this turn, whichever is first, only from this workstation.`,
    `Send requests to ${base}/<host>/<path> instead of https://<host>/<path>; the vault attaches the secret${lease.injection ? ` as ${attachment(lease.injection)}` : ""}. Allowed hosts: ${lease.hosts.join(", ")}.`,
    `Example: curl -sS ${base}/${host}/<path>`,
    `For git over HTTPS, use the URL directly instead of saving it as a remote: git push ${base}/${host}/<owner>/<repo>.git <branch> (no username or token in the URL).`,
    lease.access === "read"
      ? "This lease allows GET, HEAD and OPTIONS only. Ask for a write lease to push or change anything."
      : "This lease also allows requests that change things (POST, PUT, PATCH, DELETE, git push).",
    "Never print, store or ask for the secret itself; you cannot see it and do not need it.",
  ].join("\n");
}
