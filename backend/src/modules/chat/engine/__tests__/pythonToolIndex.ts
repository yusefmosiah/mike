import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Code mode is the only mode: a turn offers run_python alone, and the tools
// it may call are the functions its turn context indexes. A test points
// CODE_MODE_LOCAL_KERNEL_DIR here so a local python3 kernel stands in for
// the workstation (and so the turn has tools at all).

/** A fresh directory for local kernels. */
export function localKernelDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mike-kernel-"));
}

/** The functions a prompt's Python index lists: one line each, or a connector's names on one line. */
export function pythonFunctionNames(text: string): string[] {
  const index = text.slice(text.indexOf("TOOLS IN PYTHON:"));
  const names = [
    ...[...index.matchAll(/^\s*- (\w+)\(/gm)].map((match) => match[1]!),
    ...[...index.matchAll(/^- .+, \d+ functions: (.+)$/gm)].flatMap((match) => match[1]!.split(", ")),
  ];
  return [...new Set(names)];
}

/** The functions a turn's Python has, from its tool-index turn context. */
export function pythonToolNames(params: { turnContext?: { key: string; text: string }[] } | undefined): string[] {
  return pythonFunctionNames(params?.turnContext?.find((section) => section.key === "tool-index")?.text ?? "");
}
