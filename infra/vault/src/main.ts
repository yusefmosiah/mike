// Mike's secrets vault: a small service on the VM host (see README.md).
//
// Listening sockets come from systemd (socket activation), named by
// FileDescriptorName: `control` for the backend, `vm-<name>` for each VM's
// vsock port. For development, VAULT_CONTROL_SOCKET and
// VAULT_VM_SOCKETS ("name=path,...") name Unix sockets to listen on instead.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { AuditLog } from "./audit.ts";
import { controlHandler } from "./control.ts";
import { generateSealingKey, importSealingKey } from "./crypto.ts";
import { dataHandler } from "./data.ts";
import { Leases } from "./leases.ts";
import { SecretStore } from "./store.ts";

const VM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A file holding key material, created once with no access for anyone else. */
async function keyFile(file: string, create: () => Promise<Buffer>): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = await create();
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  return bytes;
}

type Listener = { kind: "control" } | { kind: "vm"; vm: string };

function systemdSockets(): Map<number, Listener> {
  const out = new Map<number, Listener>();
  const count = Number(process.env.LISTEN_FDS ?? 0);
  if (!count || Number(process.env.LISTEN_PID) !== process.pid) return out;
  const names = (process.env.LISTEN_FDNAMES ?? "").split(":");
  for (let i = 0; i < count; i++) {
    const name = names[i] ?? "";
    if (name === "control") out.set(3 + i, { kind: "control" });
    else if (name.startsWith("vm-") && VM_NAME.test(name.slice(3))) out.set(3 + i, { kind: "vm", vm: name.slice(3) });
    else console.error(`ignoring socket ${3 + i} named ${JSON.stringify(name)}`);
  }
  return out;
}

async function main(): Promise<void> {
  const stateDir = process.env.STATE_DIRECTORY?.split(":")[0] || process.env.VAULT_STATE_DIR || "/var/lib/mike-vault";
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const masterKey = await keyFile(path.join(stateDir, "master.key"), async () => randomBytes(32));
  if (masterKey.length !== 32) throw new Error("master.key must be 32 bytes");
  const sealing = await importSealingKey(
    await keyFile(path.join(stateDir, "seal.pkcs8"), async () => (await generateSealingKey()).pkcs8),
  );

  const store = new SecretStore(stateDir, masterKey);
  await store.load();
  const leases = new Leases();
  const audit = new AuditLog(stateDir);

  const listeners: { listener: Listener; target: { fd: number } | { path: string } }[] = [];
  for (const [fd, listener] of systemdSockets()) listeners.push({ listener, target: { fd } });
  if (listeners.length === 0) {
    if (process.env.VAULT_CONTROL_SOCKET) {
      listeners.push({ listener: { kind: "control" }, target: { path: process.env.VAULT_CONTROL_SOCKET } });
    }
    for (const entry of (process.env.VAULT_VM_SOCKETS ?? "").split(",").filter(Boolean)) {
      const [vm, socketPath] = entry.split("=");
      if (!VM_NAME.test(vm) || !socketPath) throw new Error(`bad VAULT_VM_SOCKETS entry: ${entry}`);
      listeners.push({ listener: { kind: "vm", vm }, target: { path: socketPath } });
    }
  }
  if (!listeners.some(({ listener }) => listener.kind === "control")) throw new Error("no control socket");

  const vms = new Set(listeners.flatMap(({ listener }) => (listener.kind === "vm" ? [listener.vm] : [])));
  const servers: Server[] = [];
  for (const { listener, target } of listeners) {
    const handler = listener.kind === "control"
      ? controlHandler({ store, leases, audit, sealing, vms })
      : dataHandler(listener.vm, { store, leases, audit });
    const server = createServer((req, res) => {
      handler(req, res).catch((error) => {
        console.error("request failed:", (error as Error).message);
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    });
    // Large pushes take a while; requests are bounded by the upstream timeout.
    server.requestTimeout = 0;
    if ("path" in target) await rm(target.path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, () => resolve());
    });
    servers.push(server);
  }
  console.log(`vault ready: control and ${vms.size} vm socket(s) [${[...vms].join(", ")}], sealing key ${sealing.kid}`);

  const stop = () => {
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error) => {
  console.error("vault failed to start:", (error as Error).message);
  process.exit(1);
});
