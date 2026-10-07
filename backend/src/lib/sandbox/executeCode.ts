/**
 * The `execute_code` runner — disabled.
 *
 * The previous implementation ran model-written JavaScript in a `node:vm`
 * context seeded with host intrinsics. That is not an isolation boundary:
 * `Object.constructor("return process")()` returned the backend's own
 * `process`, environment secrets included, and Auto Mode approved the tool
 * without review. It is removed until execution moves to a separate process
 * or container that holds no secrets and has no network (see
 * goals/STATUS.md, tabled work). The vm version is in git history at b0e80cc.
 *
 * The function stays so callers keep a stable shape; it never runs code.
 */

export type ExecuteCodeInput = {
  code: string;
  timeoutMs?: number;
  maxOutputChars?: number;
};

export type ExecuteCodeResult =
  | { ok: true; output: string; truncated: boolean }
  | { ok: false; error: string };

export const EXECUTE_CODE_DISABLED_ERROR =
  "execute_code is disabled: code execution has no isolated runtime yet.";

export async function executeCode(
  _input: ExecuteCodeInput,
): Promise<ExecuteCodeResult> {
  return { ok: false, error: EXECUTE_CODE_DISABLED_ERROR };
}
