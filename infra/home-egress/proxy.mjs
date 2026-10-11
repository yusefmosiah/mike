// Home egress: an HTTP CONNECT proxy on this Mac's loopback that reaches a
// short list of hosts (YouTube's by default) and nothing else.
//
// node-a's workstation egress proxy (tinyproxy, infra/node-a/workstations.nix)
// sends those hosts here through an SSH reverse tunnel (tunnel.sh), so a
// sandbox fetching captions does it from a residential address instead of a
// data-centre one that YouTube asks to sign in. Only CONNECT to port 443 of a
// listed host is served, and never to a private, loopback, link-local or CGNAT
// address, so the tunnel cannot reach this house's network or this Mac's own
// services. Each connection logs its host and outcome; no content.
import dns from "node:dns/promises";
import net from "node:net";

const PORT = Number(process.env.HOME_EGRESS_PORT ?? 18118);
const HOSTS = (process.env.HOME_EGRESS_HOSTS ?? "youtube.com,youtu.be,youtube-nocookie.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
const MAX_CONNECTIONS = 64;
const HEADER_LIMIT = 8 * 1024;
const IDLE_MS = 5 * 60 * 1000;

const log = (host, outcome) => console.log(`${new Date().toISOString()} ${host} ${outcome}`);

function listed(host) {
    return HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function publicAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split(".").map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            a >= 224
        );
    }
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return publicAddress(lower.slice(7));
    return !(lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower));
}

let open = 0;

const server = net.createServer((client) => {
    if (open >= MAX_CONNECTIONS) {
        client.end("HTTP/1.1 503 Busy\r\n\r\n");
        return;
    }
    open += 1;
    client.on("close", () => {
        open -= 1;
    });
    client.on("error", () => client.destroy());
    client.setTimeout(15_000, () => client.destroy());

    let head = Buffer.alloc(0);
    const refuse = (status, host, outcome) => {
        log(host, outcome);
        client.end(`HTTP/1.1 ${status}\r\n\r\n`);
    };

    const onData = async (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
            if (head.length > HEADER_LIMIT) refuse("431 Request Header Fields Too Large", "-", "refused: header");
            return;
        }
        client.off("data", onData);
        client.pause();
        const [method, target] = head.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
        const rest = head.subarray(end + 4);
        const match = /^([a-z0-9.-]+):(\d+)$/i.exec(target ?? "");
        const host = match?.[1].toLowerCase().replace(/\.$/, "") ?? "-";
        if (method !== "CONNECT" || !match) return refuse("405 Method Not Allowed", host, "refused: not CONNECT");
        if (match[2] !== "443") return refuse("403 Forbidden", host, "refused: port");
        if (!listed(host)) return refuse("403 Forbidden", host, "refused: host");

        let address;
        try {
            const addresses = await dns.lookup(host, { all: true });
            if (!addresses.length || !addresses.every(({ address: a }) => publicAddress(a))) {
                return refuse("403 Forbidden", host, "refused: private address");
            }
            address = addresses[0].address;
        } catch {
            return refuse("502 Bad Gateway", host, "failed: dns");
        }

        const upstream = net.connect(443, address, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (rest.length) upstream.write(rest);
            client.setTimeout(IDLE_MS, () => client.destroy());
            upstream.setTimeout(IDLE_MS, () => upstream.destroy());
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
            log(host, "ok");
        });
        upstream.on("error", () => {
            if (!client.destroyed) refuse("502 Bad Gateway", host, "failed: connect");
        });
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
});

server.listen(PORT, "127.0.0.1", () => log("-", `listening on 127.0.0.1:${PORT} for ${HOSTS.join(", ")}`));
