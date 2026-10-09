/**
 * Code mode (goals/mission-11-code-mode.md): the model writes JavaScript that
 * runs in QuickJS, compiled to WebAssembly, inside the backend process. The
 * script has no Node APIs, filesystem, network, timers or host objects; its
 * only way out is `tools.<name>(args)`, which the caller routes through the
 * same gate and dispatcher as a direct tool call. Only what the script logs
 * or returns reaches the model.
 *
 * Every tool call returns a promise, so a script may run several at once
 * (`await Promise.all([...])`). Limits: memory, stack, a wall-clock deadline
 * (enforced inside the interpreter, so `while (true) {}` stops too), the
 * number of tool calls, and output size.
 */
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";

export type ScriptToolCall = (name: string, args: unknown) => Promise<string>;

export type RunScriptInput = {
  code: string;
  /** Tool names the script may call. */
  toolNames: readonly string[];
  /** Runs one tool call and returns its result text (normally JSON). */
  callTool: ScriptToolCall;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
  memoryLimitBytes?: number;
  /** The turn's abort signal: a cancelled turn stops its script. */
  signal?: AbortSignal;
};

export type RunScriptResult =
  | { ok: true; output: string; result: unknown; toolCalls: number; truncated: boolean; durationMs: number }
  | { ok: false; error: string; output: string; toolCalls: number; durationMs: number };

export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
export const MAX_SCRIPT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TOOL_CALLS = 100;
export const DEFAULT_MAX_SCRIPT_OUTPUT_CHARS = 20_000;
const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
const MAX_STACK = 1024 * 1024;

// Runs inside QuickJS before the script. `__call` and `__log` are the only
// host functions; `tools` refuses names outside the allowed list.
const PRELUDE = `
const __names = new Set(JSON.parse(__toolNames));
const __fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } })();
globalThis.console = Object.freeze({
  log: (...a) => __log(a.map(__fmt).join(" ")),
  info: (...a) => __log(a.map(__fmt).join(" ")),
  warn: (...a) => __log(a.map(__fmt).join(" ")),
  error: (...a) => __log(a.map(__fmt).join(" ")),
});
globalThis.tools = new Proxy({}, {
  get(_, name) {
    if (typeof name !== "string" || !__names.has(name)) return undefined;
    return (args) => __call(name, JSON.stringify(args === undefined ? {} : args)).then((text) => {
      try { return JSON.parse(text); } catch { return text; }
    });
  },
  has(_, name) { return __names.has(name); },
  ownKeys() { return [...__names]; },
  getOwnPropertyDescriptor(_, name) { return __names.has(name) ? { enumerable: true, configurable: true } : undefined; },
});
`;

class Output {
  private text = "";
  truncated = false;
  constructor(private readonly max: number) {}
  push(line: string): void {
    if (this.truncated) return;
    const next = this.text ? `${this.text}\n${line}` : line;
    if (next.length > this.max) {
      this.text = `${next.slice(0, this.max)}\n[... output truncated ...]`;
      this.truncated = true;
    } else {
      this.text = next;
    }
  }
  toString(): string {
    return this.text;
  }
}

function errorMessage(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === "object" && "message" in dumped) {
    const { name, message } = dumped as { name?: string; message?: string };
    return name && name !== "Error" ? `${name}: ${message}` : String(message);
  }
  return String(dumped);
}

export async function runScript(input: RunScriptInput): Promise<RunScriptResult> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(1000, input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS), MAX_SCRIPT_TIMEOUT_MS);
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const output = new Output(input.maxOutputChars ?? DEFAULT_MAX_SCRIPT_OUTPUT_CHARS);
  const deadline = started + timeoutMs;
  let toolCalls = 0;
  const done = (
    result: { ok: true; result: unknown; truncated: boolean } | { ok: false; error: string },
  ): RunScriptResult =>
    ({ ...result, output: output.toString(), toolCalls, durationMs: Date.now() - started }) as RunScriptResult;

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT);
  runtime.setMaxStackSize(MAX_STACK);
  runtime.setInterruptHandler(() => Date.now() > deadline || !!input.signal?.aborted);
  const vm = runtime.newContext();
  let disposed = false;
  const pending = new Set<QuickJSDeferredPromise>();
  const pump = () => {
    if (disposed) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) jobs.error.dispose();
  };

  try {
    const names = vm.newString(JSON.stringify([...input.toolNames]));
    vm.setProp(vm.global, "__toolNames", names);
    names.dispose();

    const log = vm.newFunction("__log", (lineHandle) => {
      output.push(vm.getString(lineHandle));
    });
    vm.setProp(vm.global, "__log", log);
    log.dispose();

    const call = vm.newFunction("__call", (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const argsText = vm.getString(argsHandle);
      const deferred = vm.newPromise();
      pending.add(deferred);
      const settle = (text: string, ok: boolean) => {
        pending.delete(deferred);
        if (disposed) return;
        const value = ok ? vm.newString(text) : vm.newError(text);
        if (ok) deferred.resolve(value);
        else deferred.reject(value);
        value.dispose();
        deferred.dispose();
        pump();
      };
      if (!input.toolNames.includes(name)) {
        queueMicrotask(() => settle(`Unknown tool: ${name}`, false));
      } else if (++toolCalls > maxToolCalls) {
        queueMicrotask(() => settle(`Too many tool calls: the limit is ${maxToolCalls} per script`, false));
      } else {
        let args: unknown;
        try {
          args = JSON.parse(argsText);
        } catch {
          args = {};
        }
        input.callTool(name, args).then(
          (text) => settle(text, true),
          (error: unknown) => settle(error instanceof Error ? error.message : String(error), false),
        );
      }
      return deferred.handle;
    });
    vm.setProp(vm.global, "__call", call);
    call.dispose();

    const prelude = vm.evalCode(PRELUDE, "prelude.js");
    if (prelude.error) {
      const message = errorMessage(vm, prelude.error);
      prelude.error.dispose();
      return done({ ok: false, error: `sandbox setup failed: ${message}` });
    }
    prelude.value.dispose();

    const evaluated = vm.evalCode(`(async () => {\n${input.code}\n})()`, "script.js");
    if (evaluated.error) {
      const message = errorMessage(vm, evaluated.error);
      evaluated.error.dispose();
      return done({ ok: false, error: message });
    }
    const promiseHandle = evaluated.value;
    const settled = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    pump();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
      onAbort = () => resolve("aborted");
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([settled, stopped]);
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    if (outcome === "aborted" || input.signal?.aborted) {
      if (typeof outcome === "object") (outcome.error ?? outcome.value).dispose();
      return done({ ok: false, error: "Script cancelled" });
    }
    if (outcome === "timeout") {
      return done({ ok: false, error: `Script timed out after ${Math.round(timeoutMs / 1000)} s` });
    }
    if (outcome.error) {
      const message = errorMessage(vm, outcome.error);
      outcome.error.dispose();
      const interrupted = /interrupted/i.test(message);
      return done({ ok: false, error: interrupted ? `Script timed out after ${Math.round(timeoutMs / 1000)} s` : message });
    }
    const result = vm.dump(outcome.value) as unknown;
    outcome.value.dispose();
    return done({ ok: true, result: result === undefined ? null : result, truncated: output.truncated });
  } catch (error) {
    return done({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    disposed = true;
    for (const deferred of pending) {
      try {
        deferred.dispose();
      } catch {
        // already settled
      }
    }
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // A script stopped mid-flight can leave objects the runtime still
      // counts; the WebAssembly memory is dropped with the runtime either way.
    }
  }
}
