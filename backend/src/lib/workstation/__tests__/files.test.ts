/**
 * The guest side of ~/mike, run for real: the fake `ssh` executes the remote
 * command in a local bash with /home/agent pointed at a temporary directory,
 * so the Python receiver and reader touch real files.
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceManifest, readWorkstationFile, readWorkstationTree, writeWorkspaceBatch } from "../files";
import type { WorkstationTarget } from "../exec";

const target: WorkstationTarget = { host: "vm", user: "agent", identityFile: "/keys/dev" };
let home: string;

/** ssh's last argument is the remote command; run it here instead. */
const localSsh = ((_command: string, args: string[]) =>
  nodeSpawn("bash", ["-c", args[args.length - 1]!.replaceAll("/home/agent", home)], {
    stdio: ["pipe", "pipe", "pipe"],
  })) as never;

const mike = (...parts: string[]) => path.join(home, "mike", ...parts);
const mode = (file: string) => statSync(file).mode & 0o777;

beforeEach(() => {
  // Canonical, as /home/agent is: macOS's tmpdir sits behind a symlink.
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ws-home-")));
});
afterEach(() => {
  // Read-only directories have to be opened up before they can be removed.
  const open = (dir: string) => {
    if (!existsSync(dir)) return;
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) open(path.join(dir, entry.name));
    }
  };
  open(home);
  rmSync(home, { recursive: true, force: true });
});

describe("writeWorkspaceBatch", () => {
  it("writes files read-only under ~/mike, records them, and deletes what it is told", async () => {
    const first = await writeWorkspaceBatch(
      target,
      {
        delete: [],
        files: [
          { path: "projects/Acme/Contracts/Lease.docx", bytes: Buffer.from("lease v1") },
          { path: "library/notes.md", bytes: Buffer.from("# notes") },
        ],
        manifest: {
          "projects/Acme/Contracts/Lease.docx": { version: "v1", size: 8 },
          "library/notes.md": { version: "n1", size: 7 },
        },
      },
      localSsh,
    );
    expect(first).toEqual({ ok: true });
    expect(readFileSync(mike("projects/Acme/Contracts/Lease.docx"), "utf8")).toBe("lease v1");
    expect(mode(mike("projects/Acme/Contracts/Lease.docx"))).toBe(0o444);
    expect(mode(mike("projects/Acme/Contracts"))).toBe(0o555);
    expect(existsSync(mike("out"))).toBe(true);
    expect(mode(mike("out"))).toBe(0o755);

    const manifest = await readWorkspaceManifest(target, localSsh);
    expect(manifest).toEqual({
      ok: true,
      files: {
        "projects/Acme/Contracts/Lease.docx": { version: "v1", size: 8 },
        "library/notes.md": { version: "n1", size: 7 },
      },
    });

    // A new version replaces the file; a revoked document goes, and so does
    // the folder it leaves empty.
    const second = await writeWorkspaceBatch(
      target,
      {
        delete: ["projects/Acme/Contracts/Lease.docx", "library/notes.md"],
        files: [{ path: "projects/Acme/Contracts/Lease.docx", bytes: Buffer.from("lease v2!") }],
        manifest: { "projects/Acme/Contracts/Lease.docx": { version: "v2", size: 9 } },
      },
      localSsh,
    );
    expect(second).toEqual({ ok: true });
    expect(readFileSync(mike("projects/Acme/Contracts/Lease.docx"), "utf8")).toBe("lease v2!");
    expect(existsSync(mike("library"))).toBe(false);
  });

  it("refuses a path that leaves ~/mike or writes into ~/mike/out", async () => {
    for (const bad of ["../escape.txt", "out/x.txt"]) {
      const result = await writeWorkspaceBatch(
        target,
        { delete: [], files: [{ path: bad, bytes: Buffer.from("x") }], manifest: {} },
        localSsh,
      );
      expect(result).toEqual({ ok: false, error: "the workspace could not be updated" });
    }
    expect(existsSync(path.join(home, "escape.txt"))).toBe(false);
  });
});

describe("readWorkspaceManifest", () => {
  it("is empty before the first sync and forgets files the agent removed or changed", async () => {
    expect(await readWorkspaceManifest(target, localSsh)).toEqual({ ok: true, files: {} });
    await writeWorkspaceBatch(
      target,
      {
        delete: [],
        files: [
          { path: "library/a.txt", bytes: Buffer.from("aaa") },
          { path: "library/b.txt", bytes: Buffer.from("bbb") },
        ],
        manifest: { "library/a.txt": { version: "a", size: 3 }, "library/b.txt": { version: "b", size: 3 } },
      },
      localSsh,
    );
    chmodSync(mike("library"), 0o755);
    rmSync(mike("library/a.txt"));
    chmodSync(mike("library/b.txt"), 0o644);
    writeFileSync(mike("library/b.txt"), "changed by the agent");
    expect(await readWorkspaceManifest(target, localSsh)).toEqual({ ok: true, files: {} });
  });
});

describe("readWorkstationFile", () => {
  it("copies a regular file in the home directory", async () => {
    mkdirSync(path.join(home, "mike", "out"), { recursive: true });
    writeFileSync(mike("out/summary.md"), "# Summary\n");
    expect(await readWorkstationFile(target, "/home/agent/mike/out/summary.md", 1000, localSsh)).toEqual({
      ok: true,
      bytes: Buffer.from("# Summary\n"),
    });
    expect(await readWorkstationFile(target, "mike/out/summary.md", 1000, localSsh)).toMatchObject({ ok: true });
  });

  it("refuses symlinks, directories, large files, missing files and paths outside home", async () => {
    mkdirSync(path.join(home, "mike", "out"), { recursive: true });
    writeFileSync(mike("out/big.txt"), "x".repeat(50));
    symlinkSync("/etc/passwd", mike("out/link.txt"));
    expect(await readWorkstationFile(target, "mike/out/link.txt", 1000, localSsh)).toEqual({ ok: false, error: "not a regular file" });
    expect(await readWorkstationFile(target, "mike/out", 1000, localSsh)).toEqual({ ok: false, error: "not a regular file" });
    expect(await readWorkstationFile(target, "mike/out/big.txt", 10, localSsh)).toEqual({ ok: false, error: "file too large" });
    expect(await readWorkstationFile(target, "mike/out/none.txt", 10, localSsh)).toEqual({ ok: false, error: "no such file" });
    expect(await readWorkstationFile(target, "/etc/hostname", 1000, localSsh)).toEqual({
      ok: false,
      error: "the path is outside the workstation home directory",
    });
    expect(await readWorkstationFile(target, "../../etc/hostname", 1000, localSsh)).toEqual({
      ok: false,
      error: "the path is outside the workstation home directory",
    });
  });

  it("refuses a file reached through a symlinked directory that leaves home", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "ws-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "secret");
      symlinkSync(outside, path.join(home, "door"));
      expect(await readWorkstationFile(target, "door/secret.txt", 1000, localSsh)).toEqual({
        ok: false,
        error: "the path is outside the workstation home directory",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("~/skills", () => {
  it("is written read-only with no writable folder, so a skill may be called out", async () => {
    const tree = { root: "/home/agent/skills", writable: "" };
    const result = await writeWorkspaceBatch(
      target,
      {
        delete: [],
        files: [{ path: "out/SKILL.md", bytes: Buffer.from("x") }],
        manifest: { "out/SKILL.md": { version: "v", size: 1 } },
      },
      localSsh,
      tree,
    );
    expect(result).toEqual({ ok: true });
    expect(mode(path.join(home, "skills", "out", "SKILL.md"))).toBe(0o444);
    expect(mode(path.join(home, "skills", "out"))).toBe(0o555);
    expect(await readWorkspaceManifest(target, localSsh, "/home/agent/skills")).toEqual({
      ok: true,
      files: { "out/SKILL.md": { version: "v", size: 1 } },
    });
  });
});

describe("readWorkstationTree", () => {
  const limits = { maxFiles: 10, maxBytes: 1000 };

  it("copies a folder's regular files, skipping caches", async () => {
    const dir = path.join(home, "drafts", "pdf");
    mkdirSync(path.join(dir, "scripts", "__pycache__"), { recursive: true });
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: pdf\n---\nSteps.");
    writeFileSync(path.join(dir, "scripts", "fill.py"), "print('fill')");
    writeFileSync(path.join(dir, "scripts", "empty.txt"), "");
    writeFileSync(path.join(dir, "scripts", "__pycache__", "fill.pyc"), "junk");
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
    const result = await readWorkstationTree(target, "drafts/pdf/", limits, localSsh);
    expect(result.ok && result.files.map((f) => [f.path, f.bytes.toString()])).toEqual([
      ["SKILL.md", "---\nname: pdf\n---\nSteps."],
      ["scripts/empty.txt", ""],
      ["scripts/fill.py", "print('fill')"],
    ]);
  });

  it("refuses symlinks, missing or non-folders, paths outside home and folders over the limits", async () => {
    const dir = path.join(home, "drafts", "s");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.txt"), "x".repeat(600));
    writeFileSync(path.join(dir, "b.txt"), "x".repeat(600));
    expect(await readWorkstationTree(target, "drafts/s", limits, localSsh)).toEqual({ ok: false, error: "the folder is too large" });
    expect(await readWorkstationTree(target, "drafts/s", { maxFiles: 1, maxBytes: 10_000 }, localSsh)).toEqual({
      ok: false,
      error: "the folder has too many files",
    });
    expect(await readWorkstationTree(target, "drafts/s/a.txt", limits, localSsh)).toEqual({ ok: false, error: "not a folder" });
    expect(await readWorkstationTree(target, "drafts/none", limits, localSsh)).toEqual({ ok: false, error: "no such folder" });
    expect(await readWorkstationTree(target, "/etc", limits, localSsh)).toEqual({
      ok: false,
      error: "the path is outside the workstation home directory",
    });
    symlinkSync("/etc/passwd", path.join(dir, "link"));
    expect(await readWorkstationTree(target, "drafts/s", { maxFiles: 10, maxBytes: 10_000 }, localSsh)).toEqual({
      ok: false,
      error: "the folder contains a symbolic link",
    });
    symlinkSync(dir, path.join(home, "door"));
    expect(await readWorkstationTree(target, "door", limits, localSsh)).toEqual({
      ok: false,
      error: "the path is outside the workstation home directory",
    });
  });
});
