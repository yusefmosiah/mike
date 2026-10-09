export {
  DEFAULT_MAX_SCRIPT_OUTPUT_CHARS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_TIMEOUT_MS,
  runScript,
  type RunScriptInput,
  type RunScriptResult,
  type ScriptToolCall,
} from "./runScript";

export const RUN_SCRIPT_TOOL = "run_script";

/** Code mode is offered to the model only where the deployment turns it on. */
export function codeModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.CODE_MODE_ENABLED ?? "");
}

/** The tool result the model reads for one `run_script` call. */
export function scriptResultContent(result: import("./runScript").RunScriptResult, maxChars = 20_000): string {
  if (!result.ok) {
    return JSON.stringify({ error: result.error, output: result.output, tool_calls: result.toolCalls });
  }
  let value: unknown = result.result;
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length > maxChars) {
    value = `${serialized.slice(0, maxChars)} [... result truncated; return less, or log a summary ...]`;
  }
  return JSON.stringify({
    result: value,
    output: result.output,
    tool_calls: result.toolCalls,
    truncated: result.truncated || serialized.length > maxChars,
    duration_ms: result.durationMs,
  });
}
