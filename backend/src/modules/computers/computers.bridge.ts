// Commands for a person's computer, held in memory until its helper collects
// them. The helper long-polls nextDeviceCommand; a chat tool awaits
// sendDeviceCommand until the helper posts the result back.
//
// In memory, like the Word client-tool bridge: it assumes one API process,
// which staging is. A second instance would need the queue in Postgres.

import { randomUUID } from "node:crypto";
import type {
  ComputerCommand,
  ComputerCommandResult,
} from "@mike/contracts";

type CommandBody = ComputerCommand extends infer C
  ? C extends ComputerCommand
    ? Omit<C, "id">
    : never
  : never;

type Pending = {
  deviceId: string;
  command: ComputerCommand;
  delivered: boolean;
  resolve: (result: ComputerCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Waiter = (command: ComputerCommand | null) => void;

const pending = new Map<string, Pending>();
const waiters = new Map<string, Waiter[]>();

function failureResult(error: string): ComputerCommandResult {
  return { ok: false, error };
}

function settle(id: string, result: ComputerCommandResult): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(result);
}

function deliver(deviceId: string): void {
  const queue = waiters.get(deviceId);
  if (!queue?.length) return;
  for (const entry of pending.values()) {
    if (entry.deviceId !== deviceId || entry.delivered) continue;
    entry.delivered = true;
    queue.shift()!(entry.command);
    if (!queue.length) break;
  }
}

/**
 * Queue a command for a device and wait for its result. Never throws: a
 * timeout, an abort or a helper that never collects the command all come
 * back as `{ ok: false, error }` for the model to read.
 */
export function sendDeviceCommand(
  deviceId: string,
  body: CommandBody,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ComputerCommandResult> {
  if (options.signal?.aborted) {
    return Promise.resolve(failureResult("The turn was stopped."));
  }
  const id = randomUUID();
  const command = { ...body, id } as ComputerCommand;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      settle(
        id,
        failureResult(
          entry?.delivered
            ? "The computer did not answer in time."
            : "The computer did not collect the command. Is its helper running?",
        ),
      );
    }, options.timeoutMs);
    pending.set(id, { deviceId, command, delivered: false, resolve, timer });
    options.signal?.addEventListener(
      "abort",
      () => settle(id, failureResult("The turn was stopped.")),
      { once: true },
    );
    deliver(deviceId);
  });
}

/** The device's next command, waiting up to waitMs; null when none came. */
export function nextDeviceCommand(
  deviceId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<ComputerCommand | null> {
  return new Promise((resolve) => {
    let done = false;
    const waiter: Waiter = (command) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(command);
    };
    const remove = () => {
      const queue = waiters.get(deviceId);
      if (!queue) return;
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) waiters.delete(deviceId);
    };
    const timer = setTimeout(() => {
      remove();
      waiter(null);
    }, waitMs);
    signal?.addEventListener(
      "abort",
      () => {
        remove();
        waiter(null);
      },
      { once: true },
    );
    const queue = waiters.get(deviceId) ?? [];
    queue.push(waiter);
    waiters.set(deviceId, queue);
    deliver(deviceId);
  });
}

/** Put back a command whose poll response never reached the helper. */
export function requeueDeviceCommand(deviceId: string, commandId: string): void {
  const entry = pending.get(commandId);
  if (!entry || entry.deviceId !== deviceId) return;
  entry.delivered = false;
  deliver(deviceId);
}

/** Accept a helper's result. False when the command is unknown or not this device's. */
export function submitDeviceResult(
  deviceId: string,
  commandId: string,
  result: ComputerCommandResult,
): boolean {
  const entry = pending.get(commandId);
  if (!entry || entry.deviceId !== deviceId || !entry.delivered) return false;
  settle(commandId, result);
  return true;
}

/** Test hook: forget every command and waiter. */
export function resetDeviceBridgeForTests(): void {
  for (const id of [...pending.keys()]) settle(id, failureResult("reset"));
  for (const queue of waiters.values()) for (const waiter of queue) waiter(null);
  waiters.clear();
}
