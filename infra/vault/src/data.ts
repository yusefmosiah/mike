// The forwarding endpoint one VM sees, at http://127.0.0.1:8200 inside it
// (a guest service relays that port to this socket over vsock).
//
//   GET  /                         usage
//   GET  /<lease>                  what the lease allows
//   ANY  /<lease>/<host>/<path>    the request, sent to https://<host>/<path>
//                                  with the secret attached
//
// Which VM is asking comes from the socket the connection arrived on, never
// from anything in the request.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLog } from "./audit.ts";
import { forward, ForwardError, responseHeaders, type ForwardOptions } from "./forward.ts";
import type { Leases } from "./leases.ts";
import { accessFor, hostAllowed, injectedHeader, normalizeHost, PolicyError, scrubPatterns } from "./policy.ts";
import { Scrubber } from "./scrub.ts";
import type { SecretStore } from "./store.ts";

export type DataPlane = {
  store: SecretStore;
  leases: Leases;
  audit: AuditLog;
  forward?: ForwardOptions;
};

const USAGE = `Mike vault: requests made with a secret the user stored, without the secret.

  curl $MIKE_VAULT_URL/<lease>/<host>/<path>

sends the request to https://<host>/<path> with the secret attached the way
the user configured it. Use a lease from the vault_lease tool; it works only
from this machine, for the hosts the secret allows, until it expires. Reads
(GET, HEAD, OPTIONS) need a read lease; anything else needs a write lease.

  git remote set-url origin $MIKE_VAULT_URL/<lease>/<host>/<repo path>.git

makes git push and pull go through the vault too.
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function dataHandler(vm: string, plane: DataPlane) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = req.url ?? "/";
    const queryAt = raw.indexOf("?");
    const pathPart = queryAt === -1 ? raw : raw.slice(0, queryAt);
    const query = queryAt === -1 ? "" : raw.slice(queryAt);
    const [token = "", hostPart, ...rest] = pathPart.slice(1).split("/");

    if (!token) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(USAGE);
      return;
    }
    const lease = plane.leases.check(token, vm);
    const secret = lease ? plane.store.get(lease.userId, lease.secretId) : null;
    if (!lease || !secret) {
      req.resume();
      sendJson(res, 401, { error: "This lease is unknown, expired or not for this machine. Ask for a new one with vault_lease." });
      return;
    }
    if (hostPart === undefined || hostPart === "") {
      req.resume();
      sendJson(res, 200, {
        secret: secret.name,
        hosts: secret.hosts,
        access: lease.access,
        expires_at: new Date(lease.expiresAt).toISOString(),
      });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const deny = (status: number, reason: string) => {
      req.resume();
      plane.audit.record({ user: lease.userId, event: "denied", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId, method, host: hostPart, reason });
      sendJson(res, status, { error: reason });
    };
    let host: string;
    try {
      host = normalizeHost(decodeURIComponent(hostPart));
      if (host.startsWith("*.")) throw new PolicyError("not a host name");
    } catch {
      deny(400, `not a host name: ${hostPart}`);
      return;
    }
    if (!hostAllowed(secret.hosts, host)) {
      deny(403, `${secret.name} may be sent only to ${secret.hosts.join(", ")}`);
      return;
    }
    if (accessFor(method) === "write" && lease.access !== "write") {
      deny(403, `${method} changes things and this is a read lease; ask for a write lease with vault_lease`);
      return;
    }
    if (req.headers.upgrade) {
      deny(501, "upgrades (websockets) are not supported");
      return;
    }

    let value: string;
    try {
      value = plane.store.reveal(lease.userId, secret.id);
    } catch {
      deny(410, "this secret was deleted");
      return;
    }
    const patterns = scrubPatterns(secret.injection, value);
    const path = `/${rest.join("/")}${query}`;
    const base = `/${token}`;
    const rewriteLocation = (location: string) => {
      if (location.startsWith("/") && !location.startsWith("//")) return `${base}/${host}${location}`;
      try {
        const url = new URL(location);
        if (url.protocol === "https:" && !url.port && hostAllowed(secret.hosts, url.hostname)) {
          return `${base}/${url.hostname}${url.pathname}${url.search}`;
        }
      } catch {
        /* leave it */
      }
      return location;
    };

    try {
      const upstream = await forward(
        { method, host, path, headers: req.headers, body: req, inject: injectedHeader(secret.injection, value), patterns },
        plane.forward,
      );
      plane.store.touch(lease.userId, secret.id);
      plane.audit.record({
        user: lease.userId, event: "request", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId,
        access: lease.access, method, host, path: path.split("?")[0].slice(0, 300), status: upstream.statusCode,
      });
      res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers, patterns, rewriteLocation));
      upstream.pipe(new Scrubber(patterns)).pipe(res);
      upstream.on("error", () => res.destroy());
    } catch (error) {
      const status = error instanceof ForwardError ? error.status : 502;
      const reason = error instanceof ForwardError ? error.message : "the request failed";
      plane.audit.record({ user: lease.userId, event: "denied", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId, method, host, reason });
      if (!res.headersSent) sendJson(res, status, { error: reason });
      else res.destroy();
    }
  };
}
