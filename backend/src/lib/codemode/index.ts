/**
 * Code mode (goals/mission-11-code-mode.md): the model works through one
 * tool, `run_python`, in a persistent Python kernel inside the user's
 * workstation VM, and calls every other tool from there.
 */
import type { WorkstationTarget } from "../workstation/exec";
import { KernelManager, localKernelLauncher, sshKernelLauncher, type KernelLauncher } from "./kernel/manager";

export { KernelManager, kernelKey, localKernelLauncher, sshKernelLauncher, type KernelLauncher } from "./kernel/manager";
export { KernelSession, type CellOutcome, type HostReply, type KernelToolSpec } from "./kernel/session";
export {
  cellResultContent,
  DEFAULT_CELL_TIMEOUT_MS,
  MAX_CELL_TIMEOUT_MS,
  NOT_IN_PYTHON,
  pythonToolsPromptSection,
  pythonToolSpecs,
  RUN_PYTHON_SCHEMA,
  RUN_PYTHON_TOOL,
} from "./python";

type Env = Record<string, string | undefined>;

/**
 * Where a user's kernels run, given their workstation (resolveWorkstation in
 * lib/workstation), or null when code mode is off for them.
 *
 * Code mode is on for every user with a workstation VM; `CODE_MODE_ENABLED=false`
 * turns it off for the deployment. Without a VM, `CODE_MODE_LOCAL_KERNEL_DIR`
 * runs kernels as local processes for development and tests, never in
 * production.
 */
export function kernelLauncherFor(target: WorkstationTarget | null, env: Env = process.env): KernelLauncher | null {
  if (/^(0|false|no|off)$/i.test(env.CODE_MODE_ENABLED?.trim() ?? "")) return null;
  if (target) return sshKernelLauncher(target);
  const localDir = env.CODE_MODE_LOCAL_KERNEL_DIR?.trim();
  if (localDir && env.NODE_ENV !== "production") return localKernelLauncher(localDir);
  return null;
}

/** The backend process's kernels, one per conversation. */
export const kernels = new KernelManager();
