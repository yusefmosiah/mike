/**
 * Sandboxed computation (lib): the `execute_code` tool's JavaScript runner.
 * See ./executeCode.ts for the context surface, resource caps, and the
 * non-goal (vm is not a hardened boundary against adversarial code).
 */

export {
  EXECUTE_CODE_DEFAULT_MAX_OUTPUT_CHARS,
  EXECUTE_CODE_DEFAULT_TIMEOUT_MS,
  EXECUTE_CODE_MAX_CODE_CHARS,
  EXECUTE_CODE_MAX_TIMEOUT_MS,
  EXECUTE_CODE_MIN_TIMEOUT_MS,
  executeCode,
} from "./executeCode";
export type { ExecuteCodeInput, ExecuteCodeResult } from "./executeCode";
