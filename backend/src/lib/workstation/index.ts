/** Workstation VMs: running commands in an employee's VM (Mission 13). */
export { workstationFor } from "./config";
export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  runInWorkstation,
  type RunCommandInput,
  type RunCommandResult,
  type WorkstationTarget,
} from "./exec";
export { requestSnapshot, snapshotOncePerTurn, type SnapshotResult } from "./snapshot";
export { connectVsockMux } from "./vsockMux";
