// Facade for the computers module: a person's own computers, driven from chat
// through the helper app in computer-helper/.
//
//   computers.devices.ts — add, list and revoke computers; device tokens
//   computers.bridge.ts  — commands waiting for a helper, and their results
//   computers.tools.ts   — computer_observe and computer_act for chat turns

export {
  ONLINE_WINDOW_MS,
  authenticateDevice,
  createComputerDevice,
  findOnlineDevice,
  hashDeviceToken,
  listComputerDevices,
  listOnlineDevices,
  parseHeartbeat,
  recordHeartbeat,
  parseDeviceName,
  revokeComputerDevice,
  touchDevice,
  type AuthenticatedDevice,
  type OnlineComputer,
} from "./computers.devices";
export {
  nextDeviceCommand,
  requeueDeviceCommand,
  resetDeviceBridgeForTests,
  sendDeviceCommand,
  submitDeviceResult,
} from "./computers.bridge";
export {
  COMPUTER_TOOL_NAMES,
  parseActions,
  runComputerTool,
  takeComputerScreenshot,
  type ComputerImage,
} from "./computers.tools";
