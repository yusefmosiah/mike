/** Workstation VMs: running commands in an employee's VM (Mission 13). */
export { clearAssignmentCache, resolveWorkstation } from "./assignments";
export { targetForVm, workstationFor, workstationPool } from "./config";
export {
  Capped,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  runInWorkstation,
  shellQuote,
  sshArgs,
  type RunCommandInput,
  type RunCommandResult,
  type WorkstationTarget,
} from "./exec";
export { requestSnapshot, snapshotOncePerTurn, type SnapshotResult } from "./snapshot";
export { connectVsockMux } from "./vsockMux";
