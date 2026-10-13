// Sends one request upstream with the secret attached.
//
// The destination is always HTTPS on port 443 and is resolved here, by the
// vault: every address the name resolves to must be public, and the
// connection goes to the address that was checked (no second lookup for a
// rebinding answer to slip into). The certificate is verified against the
// name. The response comes back with the secret removed wherever it echoes.
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { scrubText } from "./scrub.ts";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}

export function isPublicIPv4(address: string): boolean {
  return isIP(address) === 4 && !blocked.check(address, "ipv4");
}

export class ForwardError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ForwardOptions = {
  /** Resolves a name to the address to connect to. Tests point it at a local server. */
  resolve?: (host: string) => Promise<string>;
  /** Extra trusted CA for tests. */
  ca?: string | Buffer;
  port?: number;
  timeoutMs?: number;
};

/** IPv4 only, like the VMs' egress proxy; every answer must be public. */
export async function resolvePublic(host: string): Promise<string> {
  let answers: { address: string }[];
  try {
    answers = await dnsLookup(host, { all: true, family: 4 });
  } catch {
    throw new ForwardError(502, `cannot resolve ${host}`);
  }
  if (answers.length === 0) throw new ForwardError(502, `cannot resolve ${host}`);
  if (!answers.every((answer) => isPublicIPv4(answer.address))) {
    throw new ForwardError(403, `${host} resolves to a private or reserved address`);
  }
  return answers[0].address;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

export type UpstreamRequest = {
  method: string;
  host: string;
  /** Path and query, starting with "/". */
  path: string;
  headers: IncomingHttpHeaders;
  body: Readable;
  inject: [string, string];
  patterns: string[];
};

export async function forward(upstream: UpstreamRequest, options: ForwardOptions = {}): Promise<IncomingMessage> {
  const address = await (options.resolve ?? resolvePublic)(upstream.host);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith("x-forwarded-") || key === "forwarded" || key === "x-real-ip") continue;
    if (value !== undefined) headers[key] = value;
  }
  // The secret replaces whatever the caller put in its header.
  headers[upstream.inject[0]] = upstream.inject[1];
  headers.host = upstream.host;
  // Plain bodies, so an echoed secret can be found and removed.
  headers["accept-encoding"] = "identity";
  const pinned: LookupFunction = (_hostname, opts, callback) => {
    if ((opts as { all?: boolean }).all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: upstream.host,
        servername: upstream.host,
        port: options.port ?? 443,
        method: upstream.method,
        path: upstream.path,
        headers,
        lookup: pinned,
        ca: options.ca,
        timeout: options.timeoutMs ?? 120_000,
        // One connection per request: an agent's keep-alive cannot outlive its lease.
        agent: false,
      },
      resolve,
    );
    request.on("timeout", () => request.destroy(new ForwardError(504, `${upstream.host} did not answer in time`)));
    request.on("error", (error) =>
      reject(error instanceof ForwardError ? error : new ForwardError(502, `could not reach ${upstream.host}: ${scrubText(error.message, upstream.patterns)}`)),
    );
    upstream.body.on("error", (error) => request.destroy(error));
    upstream.body.pipe(request);
  });
}

export function responseHeaders(
  headers: IncomingHttpHeaders,
  patterns: string[],
  rewriteLocation: (location: string) => string,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === "content-length" || value === undefined) continue;
    const clean = (text: string) => scrubText(text, patterns);
    out[key] = Array.isArray(value) ? value.map(clean) : clean(value);
  }
  if (typeof out.location === "string") out.location = rewriteLocation(out.location);
  return out;
}
