/**
 * Files in and out of a workstation VM, over the same ssh channel as
 * run_command (goals/mission-16-documents-in-workstation.md).
 *
 * In: `writeWorkspaceBatch` streams a JSON header line and then the files'
 * bytes to a short Python receiver in the guest, which writes them under
 * ~/mike read-only and deletes what the header lists. Out:
 * `readWorkstationFile` copies one regular file, refusing symlinks and
 * anything outside the agent's home.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { shellQuote, sshArgs, type WorkstationTarget } from "./exec";

type SpawnFn = typeof nodeSpawn;

export const WORKSPACE_ROOT = "/home/agent/mike";
const HOME = "/home/agent";

/** One ssh exchange: stdin in, stdout bytes out (capped), exit code. */
async function exchange(
  target: WorkstationTarget,
  remote: string,
  opts: { stdin?: Buffer; maxStdoutBytes: number; timeoutMs: number },
  spawn: SpawnFn = nodeSpawn,
): Promise<{ ok: true; code: number | null; stdout: Buffer; stderr: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn("ssh", sshArgs(target, remote), { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, error: "workstation unavailable" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > opts.maxStdoutBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "workstation unavailable" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) return resolve({ ok: false, error: "file too large" });
      if (code === 255) return resolve({ ok: false, error: "workstation unreachable" });
      resolve({ ok: true, code, stdout: Buffer.concat(chunks), stderr });
    });
    // A closed stdin (the guest exited early) must not crash the backend.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin ?? Buffer.alloc(0));
  });
}

const python = (script: string, ...args: string[]) =>
  `python3 -I -c ${shellQuote(script)} ${args.map(shellQuote).join(" ")}`;

/**
 * Lists what ~/mike holds, as `{ path: versionId }`, keeping only entries
 * whose file is still there with the size recorded (the agent may have
 * removed or replaced one; it is then sent again).
 */
export const READ_MANIFEST = String.raw`
import json, os, sys
root = sys.argv[1]
try:
    with open(os.path.join(root, ".manifest.json")) as fh:
        manifest = json.load(fh)
except Exception:
    manifest = {}
kept = {}
for path, entry in (manifest.get("files") or {}).items():
    full = os.path.join(root, path)
    try:
        st = os.lstat(full)
    except OSError:
        continue
    if os.path.isfile(full) and not os.path.islink(full) and st.st_size == entry.get("size"):
        kept[path] = entry
sys.stdout.write(json.dumps(kept))
`;

export type ManifestEntry = { version: string; size: number };

export async function readWorkspaceManifest(
  target: WorkstationTarget,
  spawn?: SpawnFn,
): Promise<{ ok: true; files: Record<string, ManifestEntry> } | { ok: false; error: string }> {
  const result = await exchange(
    target,
    python(READ_MANIFEST, WORKSPACE_ROOT),
    { maxStdoutBytes: 32 * 1024 * 1024, timeoutMs: 60_000 },
    spawn,
  );
  if (!result.ok) return result;
  if (result.code !== 0) return { ok: false, error: "could not read the workspace manifest" };
  try {
    return { ok: true, files: JSON.parse(result.stdout.toString("utf8") || "{}") };
  } catch {
    return { ok: false, error: "could not read the workspace manifest" };
  }
}

/**
 * The guest side of a batch. Paths are relative to ~/mike and must stay
 * inside it. Files land read-only (0444) through a temporary name and an
 * atomic rename; directories other than ~/mike and ~/mike/out end 0555.
 */
export const RECEIVE = String.raw`
import json, os, sys
root = sys.argv[1]
out = os.path.join(root, "out")
stream = sys.stdin.buffer
header = json.loads(stream.readline())

def inside(rel):
    full = os.path.normpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) or full == out or full.startswith(out + os.sep):
        raise SystemExit("refused path: " + rel)
    return full

def writable(directory):
    parts = os.path.relpath(directory, root).split(os.sep)
    current = root
    for part in [p for p in parts if p not in ("", ".")]:
        current = os.path.join(current, part)
        if os.path.isdir(current) and not os.path.islink(current):
            os.chmod(current, 0o755)
    os.makedirs(directory, exist_ok=True)

os.makedirs(root, exist_ok=True)
os.chmod(root, 0o755)
os.makedirs(out, exist_ok=True)
for rel in header["delete"]:
    full = inside(rel)
    writable(os.path.dirname(full))
    try:
        os.unlink(full)
    except FileNotFoundError:
        pass
for item in header["files"]:
    full = inside(item["path"])
    writable(os.path.dirname(full))
    temporary = full + ".mike-part"
    left = item["size"]
    with open(temporary, "wb") as fh:
        while left:
            chunk = stream.read(min(left, 1 << 20))
            if not chunk:
                raise SystemExit("stream ended early")
            fh.write(chunk)
            left -= len(chunk)
    os.chmod(temporary, 0o444)
    os.replace(temporary, full)
with open(os.path.join(root, ".manifest.json"), "w") as fh:
    json.dump({"version": 1, "files": header["manifest"]}, fh)
for directory, subdirs, files in os.walk(root, topdown=False):
    if directory == root or directory == out or directory.startswith(out + os.sep):
        continue
    if os.path.islink(directory):
        continue
    if not os.listdir(directory):
        os.chmod(directory, 0o755)
        os.rmdir(directory)
    else:
        os.chmod(directory, 0o555)
`;

export type WorkspaceBatch = {
  /** Paths under ~/mike to remove. */
  delete: string[];
  /** Files to write, in order; `bytes` follow the header in the same order. */
  files: { path: string; bytes: Buffer }[];
  /** The complete manifest after this batch. */
  manifest: Record<string, ManifestEntry>;
};

export async function writeWorkspaceBatch(
  target: WorkstationTarget,
  batch: WorkspaceBatch,
  spawn?: SpawnFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const header = JSON.stringify({
    delete: batch.delete,
    files: batch.files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
    manifest: batch.manifest,
  });
  const stdin = Buffer.concat([Buffer.from(`${header}\n`, "utf8"), ...batch.files.map((file) => file.bytes)]);
  const result = await exchange(
    target,
    python(RECEIVE, WORKSPACE_ROOT),
    { stdin, maxStdoutBytes: 64 * 1024, timeoutMs: 10 * 60_000 },
    spawn,
  );
  if (!result.ok) return result;
  if (result.code !== 0) return { ok: false, error: "the workspace could not be updated" };
  return { ok: true };
}

/**
 * Copies one file out: a regular file inside /home/agent, opened without
 * following a symlink, at most `maxBytes`. Exit 3 means "not a regular
 * file", 4 "too large", 5 "outside the home directory", 6 "missing".
 */
export const READ_FILE = String.raw`
import os, stat, sys
home, path, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
full = os.path.normpath(path if os.path.isabs(path) else os.path.join(home, path))
if not full.startswith(home + os.sep):
    sys.exit(5)
real_parent = os.path.realpath(os.path.dirname(full))
if real_parent != home and not real_parent.startswith(home + os.sep):
    sys.exit(5)
try:
    fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
except FileNotFoundError:
    sys.exit(6)
except OSError:
    sys.exit(3)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode):
    sys.exit(3)
if st.st_size > limit:
    sys.exit(4)
out = sys.stdout.buffer
while True:
    chunk = os.read(fd, 1 << 20)
    if not chunk:
        break
    out.write(chunk)
`;

const READ_ERRORS: Record<number, string> = {
  3: "not a regular file",
  4: "file too large",
  5: "the path is outside the workstation home directory",
  6: "no such file",
};

export async function readWorkstationFile(
  target: WorkstationTarget,
  path: string,
  maxBytes: number,
  spawn?: SpawnFn,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const result = await exchange(
    target,
    python(READ_FILE, HOME, path, String(maxBytes)),
    { maxStdoutBytes: maxBytes, timeoutMs: 5 * 60_000 },
    spawn,
  );
  if (!result.ok) return result;
  if (result.code !== 0) {
    return { ok: false, error: READ_ERRORS[result.code ?? -1] ?? "the file could not be read" };
  }
  return { ok: true, bytes: result.stdout };
}
