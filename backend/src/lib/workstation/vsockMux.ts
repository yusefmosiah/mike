/**
 * Cloud Hypervisor's vsock multiplexer, from the host side: connect to the
 * VM's Unix socket, send `CONNECT <port>\n`, and once it answers `OK ...\n`
 * the socket is a byte stream to that guest port.
 *
 * In a container there is no systemd-ssh-proxy, and the socket the backend
 * sees is a host relay (`/run/mike-workstations/<vm>.sock`, see
 * infra/node-a/workstations.nix) that forwards bytes to the VM's own socket,
 * so the handshake is done here. The stream comes back paused. `vsockProxy.ts` wraps this as an ssh
 * ProxyCommand.
 */
import { connect, type Socket } from "node:net";

export async function connectVsockMux(socketPath: string, port: number, timeoutMs = 10_000): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffered = Buffer.alloc(0);
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("vsock handshake timed out"), timeoutMs);
    socket.once("error", (error) => fail(error.message));
    socket.once("connect", () => socket.write(`CONNECT ${port}\n`));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > 256) fail("vsock handshake: no reply line");
        return;
      }
      socket.off("data", onData);
      // Paused, so nothing after the reply line is emitted before the caller
      // listens; `pipe` (or `resume`) starts the flow.
      socket.pause();
      const line = buffered.subarray(0, newline).toString("utf8").trim();
      if (!line.startsWith("OK")) {
        fail(`vsock handshake refused: ${line.slice(0, 80)}`);
        return;
      }
      clearTimeout(timer);
      socket.removeAllListeners("error");
      const rest = buffered.subarray(newline + 1);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}
