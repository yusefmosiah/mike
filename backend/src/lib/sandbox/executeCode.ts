/**
 * Sandboxed JavaScript execution for the `execute_code` tool.
 *
 * The model-written code runs in a fresh `node:vm` context whose global
 * surface is minimal and frozen by construction: the listed ECMAScript
 * intrinsics plus a capturing console. The context deliberately omits every
 * I/O and ambient global — no network (fetch / WebSocket / XMLHttpRequest),
 * no timers, no process / require / module / Buffer — so there is no network
 * egress surface inside it by construction.
 *
 * Resource caps: a wall-clock `timeout` (the vm option, which also stops a
 * synchronous infinite loop — there is no escape from it short of the vm
 * itself), a maximum source length, and output truncation. A fresh context is
 * created per call, so global bindings never leak from one call to the next.
 *
 * Non-goal: `node:vm` is a convenience isolation, not a hardened security
 * boundary against adversarial code (Node's own documentation says as much).
 * This helper bounds what model-written computation may reach; it does not
 * defend against a hostile author in the same process, including one that
 * mutates the shared host intrinsics.
 */

import { runInNewContext } from "node:vm";

/** Wall-clock budget for one execution when the caller does not ask for one. */
export const EXECUTE_CODE_DEFAULT_TIMEOUT_MS = 5_000;
/** Requested timeouts are clamped to this window. */
export const EXECUTE_CODE_MIN_TIMEOUT_MS = 100;
export const EXECUTE_CODE_MAX_TIMEOUT_MS = 30_000;
/** Longest accepted source, in characters. Longer sources are rejected outright. */
export const EXECUTE_CODE_MAX_CODE_CHARS = 50_000;
/** Output cap when the caller does not ask for one. */
export const EXECUTE_CODE_DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export type ExecuteCodeInput = {
  /** JavaScript source. Plain JS only: imports/exports are syntax errors here. */
  code: string;
  /** Execution timeout in ms. Default 5000, clamped to 100..30000. */
  timeoutMs?: number;
  /** Output cap in characters. Default 20000. */
  maxOutputChars?: number;
};

export type ExecuteCodeResult =
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; error: string };

/** Run model-written JavaScript and return its console output + completion value. */
export async function executeCode(
  input: ExecuteCodeInput,
): Promise<ExecuteCodeResult> {
  const code = input.code;
  if (typeof code !== "string") {
    return { ok: false, error: "code must be a string." };
  }
  if (code.length > EXECUTE_CODE_MAX_CODE_CHARS) {
    return {
      ok: false,
      error: `code is ${code.length} characters; the limit is ${EXECUTE_CODE_MAX_CODE_CHARS}.`,
    };
  }

  const timeoutMs = clampInt(
    input.timeoutMs,
    EXECUTE_CODE_MIN_TIMEOUT_MS,
    EXECUTE_CODE_MAX_TIMEOUT_MS,
    EXECUTE_CODE_DEFAULT_TIMEOUT_MS,
  );
  const maxOutputChars = clampInt(
    input.maxOutputChars,
    1,
    Number.MAX_SAFE_INTEGER,
    EXECUTE_CODE_DEFAULT_MAX_OUTPUT_CHARS,
  );

  const logLines: string[] = [];
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(stringifyValue).join(" "));
  };

  // The whole ambient surface. Nothing here touches network, filesystem or
  // process state, and the object is frozen so the code cannot rebind its
  // globals for the duration of the call.
  const context = {
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    Error,
    TypeError,
    RangeError,
    console: { log: capture, error: capture, warn: capture },
  };
  Object.freeze(context.console);
  Object.freeze(context);

  let completion: unknown;
  try {
    completion = runInNewContext(code, context, { timeout: timeoutMs });
  } catch (err) {
    // Syntax errors, thrown values, and the vm timeout all land here. The
    // vm's errors are realm-local classes, never instances of the host
    // `Error`, so read the message by shape instead of `instanceof`.
    const thrown =
      typeof err === "object" && err !== null
        ? (err as { message?: unknown })
        : null;
    const message =
      thrown && typeof thrown.message === "string" && thrown.message
        ? thrown.message
        : stringifyValue(err);
    return { ok: false, error: message.slice(0, 2000) };
  }

  const parts = [...logLines];
  if (completion !== undefined) parts.push(stringifyValue(completion));

  let output = parts.join("\n");
  let truncated = false;
  if (output.length > maxOutputChars) {
    output = output.slice(0, maxOutputChars);
    truncated = true;
  }
  return { ok: true, output, truncated };
}

/** Integer clamp with a fallback for missing/non-finite input. */
function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Strings pass through raw; everything else becomes JSON, then String(). */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular or otherwise unstringifiable; String() below is the fallback.
  }
  return String(value);
}
