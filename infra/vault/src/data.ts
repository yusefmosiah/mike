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
import { pipeline } from "node:stream";
import type { AuditLog } from "./audit.ts";
import { forward, ForwardError, responseHeaders, type ForwardOptions } from "./forward.ts";
import type { Leases } from "./leases.ts";
import { accessFor, hostAllowed, injectedHeader, METHOD_OVERRIDE_PARAMS, normalizeHost, scrubSpec } from "./policy.ts";
import { Scrubber } from "./scrub.ts";
import type { SecretStore } from "./store.ts";

export type DataPlane = {
  store: SecretStore;
  leases: Leases;
  audit: AuditLog;
  forward?: ForwardOptions;
  /** Requests one VM may have in flight at once (default 8). */
  maxInFlight?: number;
  /** How often an in-flight request re-checks its lease (default 5 s). */
  leaseCheckMs?: number;
};

const DEFAULT_MAX_IN_FLIGHT = 8;

const USAGE = `Mike vault: requests made with a secret the user stored, without the secret.

  curl $MIKE_VAULT_URL/<lease>/<host>/<path>

sends the request to https://<host>/<path> with the secret attached the way
the user configured it. Use a lease from the vault_lease tool; it works only
from this machine, for the hosts the secret allows, until it expires or the
turn ends. Reads (GET, HEAD, OPTIONS) need a read lease; anything else needs a
write lease. Compressed responses and range requests are not supported.

  git push $MIKE_VAULT_URL/<lease>/<host>/<repo path>.git <branch>

sends git through the vault too. Use the URL directly; do not save it as a
remote.
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Answers a request that will not be forwarded, without reading its body:
 * the connection closes after the answer, so a slow or endless upload cannot
 * hold it open.
 */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("connection", "close");
  res.on("finish", () => req.destroy());
  sendJson(res, status, body);
}

export function dataHandler(vm: string, plane: DataPlane) {
  let inFlight = 0;
  const maxInFlight = plane.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
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
      refuse(req, res, 401, { error: "This lease is unknown, expired or not for this machine. Ask for a new one with vault_lease." });
      return;
    }
    if (plane.audit.saturated()) {
      // Every use is logged for its owner; while the log is behind, nothing is used.
      refuse(req, res, 503, { error: "The vault is busy; try again shortly." });
      return;
    }
    if (hostPart === undefined || hostPart === "") {
      refuse(req, res, 200, {
        secret: secret.name,
        hosts: secret.hosts,
        access: lease.access,
        expires_at: new Date(lease.expiresAt).toISOString(),
      });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const deny = (status: number, reason: string) => {
      res.setHeader("connection", "close");
      res.on("finish", () => req.destroy());
      plane.audit.record({ user: lease.userId, event: "denied", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId, method, host: hostPart, reason });
      sendJson(res, status, { error: reason });
    };
    let host: string;
    try {
      host = normalizeHost(decodeURIComponent(hostPart));
    } catch {
      deny(400, `not a host name: ${hostPart}`);
      return;
    }
    if (!hostAllowed(secret.hosts, host)) {
      deny(403, `${secret.name} may be sent only to ${secret.hosts.join(", ")}`);
      return;
    }
    if (accessFor(method, rest.join("/"), query) === "write" && lease.access !== "write") {
      deny(403, `${method} changes things and this is a read lease; ask for a write lease with vault_lease`);
      return;
    }
    if (lease.access === "read") {
      const params = new URLSearchParams(query.slice(1));
      if ([...params.keys()].some((key) => METHOD_OVERRIDE_PARAMS.has(key.toLowerCase()))) {
        deny(403, "a method override in the query needs a write lease");
        return;
      }
    }
    if (req.headers.upgrade) {
      deny(501, "upgrades (websockets) are not supported");
      return;
    }
    if (inFlight >= maxInFlight) {
      refuse(req, res, 429, { error: `at most ${maxInFlight} requests at a time from one machine` });
      return;
    }
    inFlight++;
    // A request lives no longer than its lease: once the lease expires or is
    // revoked (the turn ended), an upload or download still running stops.
    const watch = setInterval(() => {
      if (!plane.leases.check(token, vm)) {
        req.destroy();
        res.destroy();
      }
    }, plane.leaseCheckMs ?? 5000);
    watch.unref();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
      clearInterval(watch);
    };
    res.on("close", release);

    let value: string;
    try {
      value = plane.store.reveal(lease.userId, secret.id);
    } catch {
      deny(410, "this secret was deleted");
      return;
    }
    const injection = lease.injection ?? secret.injection;
    const scrub = scrubSpec(injection, value);
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

    // Every use is on disk before it happens: if it cannot be logged, it
    // does not happen.
    const logged = await plane.audit.record({
      user: lease.userId, event: "request", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId,
      access: lease.access, method, host, path: path.split("?")[0].slice(0, 300),
    });
    if (!logged) {
      refuse(req, res, 503, { error: "The vault is busy; try again shortly." });
      return;
    }
    try {
      const upstream = await forward(
        { method, host, path, headers: req.headers, body: req, inject: injectedHeader(injection, value), scrub },
        plane.forward,
      );
      plane.store.touch(lease.userId, secret.id);
      res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers, scrub, rewriteLocation));
      // Any failure along the way (upstream, a response the scrubber cannot
      // check, the VM hanging up, the lease running out) ends this response
      // and the upstream request, and nothing else.
      pipeline(upstream, new Scrubber(scrub), res, () => undefined);
    } catch (error) {
      const status = error instanceof ForwardError ? error.status : 502;
      const reason = error instanceof ForwardError ? error.message : "the request failed";
      plane.audit.record({ user: lease.userId, event: "denied", secret: secret.id, secret_name: secret.name, vm, chat: lease.chatId, method, host, reason });
      if (!res.headersSent) refuse(req, res, status, { error: reason });
      else res.destroy();
    }
  };
}
