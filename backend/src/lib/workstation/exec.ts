/**
 * Runs a command in an employee's workstation VM (goals/mission-13-workstation-vms.md).
 *
 * The harness stays on the host; the VM holds no secrets. The channel is ssh:
 * on a Cloud Hypervisor host it rides the VM's vsock socket through a
 * ProxyCommand (`systemd-ssh-proxy vsock-mux/<socket> 22`), so the guest has
 * no network path to the host at all; on a Mac dev VM it is TCP to a forwarded
 * port. Either way the command runs as the guest's unprivileged `agent` user
 * under bash, with a remote `timeout` so a dropped connection cannot leave it
 * running forever.
 */
import { spawn as nodeSpawn } from "node:child_process";

export type WorkstationTarget = {
  /** Hostname for TCP (dev), or a label when `proxyCommand` carries the connection. */
  host: string;
  port?: number;
  user: string;
  identityFile: string;
  /** e.g. `systemd-ssh-proxy vsock-mux/<socket> 22` on a Cloud Hypervisor host. */
  proxyCommand?: string;
  /**
   * Known-hosts file. Without one, the host key is not checked: acceptable
   * only when the channel itself identifies the VM (a vsock socket or a
   * loopback-forwarded port on the developer's machine).
   */
  knownHostsFile?: string;
};

export type RunCommandInput = {
  command: string;
  /** Working directory inside the VM; default the agent's home. */
  cwd?: string;
  timeoutMs?: number;
  /** Per stream; the rest is cut from the middle so the start and end survive. */
  maxOutputChars?: number;
};

export type RunCommandResult =
  | {
      ok: true;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      timedOut: boolean;
      durationMs: number;
    }
  | { ok: false; error: string };

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
/** Seconds between the remote `timeout` SIGTERM and its SIGKILL. */
const REMOTE_KILL_GRACE_S = 5;
/** Extra local budget for ssh setup and the remote kill grace. */
const LOCAL_SLACK_MS = 15_000;

/** Single-quote a string for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The remote command line: bounded by `timeout`, in `cwd`, under bash. */
export function remoteCommandLine(input: RunCommandInput, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const script = input.cwd ? `cd ${shellQuote(input.cwd)} && ${input.command}` : input.command;
  return `timeout --kill-after=${REMOTE_KILL_GRACE_S}s ${seconds}s bash -lc ${shellQuote(script)}`;
}

export function sshArgs(target: WorkstationTarget, remote: string): string[] {
  const args = [
    "-F", "/dev/null",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "LogLevel=ERROR",
    "-i", target.identityFile,
  ];
  if (target.knownHostsFile) {
    args.push("-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHostsFile}`);
  } else {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }
  if (target.proxyCommand) {
    args.push("-o", `ProxyCommand=${target.proxyCommand}`);
    // systemd-ssh-proxy hands ssh the connected vsock socket instead of
    // relaying bytes, which ssh accepts only with fd passing on.
    if (/systemd-ssh-proxy/.test(target.proxyCommand)) args.push("-o", "ProxyUseFdpass=yes");
  }
  if (target.port) args.push("-p", String(target.port));
  args.push(`${target.user}@${target.host}`, "--", remote);
  return args;
}

/** Keeps the first and last part of a stream once it passes `max` characters. */
class Capped {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const take = chunk.slice(0, half - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.max - half) {
      const cut = this.tail.length - (this.max - half);
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }
  get truncated(): boolean {
    return this.dropped > 0;
  }
  toString(): string {
    return this.dropped ? `${this.head}\n[... ${this.dropped} characters omitted ...]\n${this.tail}` : this.head + this.tail;
  }
}

type SpawnFn = typeof nodeSpawn;

export async function runInWorkstation(
  target: WorkstationTarget,
  input: RunCommandInput,
  deps: { spawn?: SpawnFn; now?: () => number } = {},
): Promise<RunCommandResult> {
  const command = input.command.trim();
  if (!command) return { ok: false, error: "command is empty" };
  const timeoutMs = Math.min(Math.max(1000, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS), MAX_COMMAND_TIMEOUT_MS);
  const maxChars = Math.max(1000, input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const spawn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const started = now();

  return new Promise<RunCommandResult>((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn("ssh", sshArgs(target, remoteCommandLine({ ...input, command }, timeoutMs)), { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, error: "workstation unavailable" });
      return;
    }
    const stdout = new Capped(maxChars);
    const stderr = new Capped(maxChars);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
    let localTimeout = false;
    const timer = setTimeout(() => {
      localTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs + REMOTE_KILL_GRACE_S * 1000 + LOCAL_SLACK_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "workstation unavailable" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ssh exits 255 for its own failures (unreachable, auth refused).
      if (code === 255 && !localTimeout) {
        resolve({ ok: false, error: "workstation unreachable" });
        return;
      }
      // GNU timeout exits 124 on SIGTERM and 137 when it had to SIGKILL.
      const timedOut = localTimeout || code === 124 || code === 137;
      resolve({
        ok: true,
        exitCode: localTimeout ? null : code,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: now() - started,
      });
    });
  });
}
