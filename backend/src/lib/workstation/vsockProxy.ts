/**
 * ssh ProxyCommand for a workstation behind a vsock relay:
 *   node dist/lib/workstation/vsockProxy.js <socket> <port>
 * Relays stdin/stdout to the guest port after the CONNECT handshake.
 */
import { connectVsockMux } from "./vsockMux";

async function main(): Promise<void> {
  const [socketPath, portText] = process.argv.slice(2);
  const port = Number(portText);
  if (!socketPath || !Number.isInteger(port)) {
    process.stderr.write("usage: vsockProxy <socket> <port>\n");
    process.exit(2);
  }
  const socket = await connectVsockMux(socketPath, port);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
  process.stdin.on("end", () => socket.end());
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(255);
  });
}
