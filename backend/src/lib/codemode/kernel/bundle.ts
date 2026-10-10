/**
 * The kernel's Python files, and the remote command that installs them in a
 * workstation VM and starts the kernel.
 *
 * The files travel inside the ssh command itself (deflated, then base64, in
 * one argument: Linux caps a single argument at 128 KiB), so starting a
 * kernel is one ssh connection. They land in
 * `~/.mike/kernel/<hash>/`: a VM keeps every version it has run, and a new
 * backend build never changes files under a kernel that is already running.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const KERNEL_PACKAGE_DIR = path.join(__dirname, "mike_kernel");

export type KernelBundle = { hash: string; files: Record<string, string> };

let cached: KernelBundle | null = null;

export function kernelBundle(dir = KERNEL_PACKAGE_DIR): KernelBundle {
  if (cached && dir === KERNEL_PACKAGE_DIR) return cached;
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".py")).sort()) {
    files[`mike_kernel/${name}`] = readFileSync(path.join(dir, name), "utf8");
  }
  if (!files["mike_kernel/repl.py"]) throw new Error(`kernel files missing in ${dir}`);
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
  const bundle = { hash, files };
  if (dir === KERNEL_PACKAGE_DIR) cached = bundle;
  return bundle;
}

// Writes the files into a temporary directory beside the target and renames
// it into place, so a half-written install is never used. Reads its arguments
// only: the target directory and the base64 of the deflated JSON of
// {relative path: text}.
const INSTALLER = [
  "import base64, json, os, sys, tempfile, zlib",
  "target = sys.argv[1]",
  "files = json.loads(zlib.decompress(base64.b64decode(sys.argv[2])))",
  "os.makedirs(os.path.dirname(target), exist_ok=True)",
  "tmp = tempfile.mkdtemp(dir=os.path.dirname(target))",
  "for rel, text in files.items():",
  "    path = os.path.join(tmp, rel)",
  "    os.makedirs(os.path.dirname(path), exist_ok=True)",
  "    open(path, 'w').write(text)",
  "try:",
  "    os.rename(tmp, target)",
  "except OSError:",
  "    import shutil; shutil.rmtree(tmp, ignore_errors=True)",
].join("\n");

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The bash command run over ssh: install this bundle if the VM lacks it,
 * then replace the shell with the kernel, started in the agent's home.
 */
export function kernelStartCommand(bundle: KernelBundle, python = "python3"): string {
  const payload = deflateSync(Buffer.from(JSON.stringify(bundle.files))).toString("base64");
  const dir = `"$HOME/.mike/kernel/${bundle.hash}"`;
  return [
    `test -f ${dir}/mike_kernel/repl.py || ${python} -c ${quote(INSTALLER)} ${dir} ${payload}`,
    `cd "$HOME"`,
    `PYTHONPATH=${dir} exec ${python} -u -m mike_kernel`,
  ].join(" && ");
}
