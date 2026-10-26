// computer_observe and computer_act (COMPUTER_TOOLS in the chat module's
// toolSchemas.ts): a chat turn's calls, sent to the person's most recently
// seen computer. The kernel gets text only; a screenshot waits here, keyed by
// the call, until the turn attaches it to the run_python result as an image.

import type {
  ComputerAction,
  ComputerCommandResult,
  ComputerObservation,
} from "@mike/contracts";
import type { Db } from "../../lib/db";
import { sendDeviceCommand } from "./computers.bridge";
import { findOnlineDevice, listOnlineDevices } from "./computers.devices";

export const COMPUTER_TOOL_NAMES = new Set(["computer_observe", "computer_act"]);

const OBSERVE_TIMEOUT_MS = 30_000;
const ACT_TIMEOUT_MS = 90_000;
const MAX_ACTIONS = 20;
const MAX_TREE_CHARS = 12_000;
const ACTION_TYPES = new Set(["click", "type", "key", "scroll", "open_app", "wait"]);

export type ComputerImage = { data: string; mimeType: string };

const screenshots = new Map<string, { image: ComputerImage; at: number }>();
const SCREENSHOT_TTL_MS = 5 * 60_000;

function stashScreenshot(callId: string, image: ComputerImage): void {
  const now = Date.now();
  for (const [key, entry] of screenshots) {
    if (now - entry.at > SCREENSHOT_TTL_MS) screenshots.delete(key);
  }
  screenshots.set(callId, { image, at: now });
}

/** The screenshot a computer_observe call took, once. */
export function takeComputerScreenshot(callId: string): ComputerImage | null {
  const entry = screenshots.get(callId);
  if (!entry) return null;
  screenshots.delete(callId);
  return entry.image;
}

const fail = (error: string) => JSON.stringify({ ok: false, error });

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** The element list as the model reads it, trimmed to a budget. */
function observationText(observation: ComputerObservation): string {
  const elements = [...observation.elements];
  const body = () =>
    JSON.stringify({
      ok: true,
      frame_id: observation.frame_id,
      app: observation.app,
      window_title: observation.window_title,
      elements,
      ...(observation.elements_note ? { elements_note: observation.elements_note } : {}),
      has_screenshot: !!observation.screenshot,
      ...(observation.screenshot_note ? { screenshot_note: observation.screenshot_note } : {}),
      ...(elements.length < observation.elements.length
        ? { truncated: `${observation.elements.length - elements.length} more elements not listed` }
        : {}),
    });
  let text = body();
  while (text.length > MAX_TREE_CHARS && elements.length > 0) {
    elements.splice(Math.floor(elements.length * 0.8));
    text = body();
  }
  return text;
}

export function parseActions(
  value: unknown,
): { ok: true; actions: ComputerAction[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "actions must be a non-empty list" };
  }
  if (value.length > MAX_ACTIONS) {
    return { ok: false, error: `at most ${MAX_ACTIONS} actions per call` };
  }
  for (const [index, action] of value.entries()) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return { ok: false, error: `action ${index} must be an object` };
    }
    const type = (action as { type?: unknown }).type;
    if (typeof type !== "string" || !ACTION_TYPES.has(type)) {
      return { ok: false, error: `action ${index} has an unknown type` };
    }
  }
  return { ok: true, actions: value as ComputerAction[] };
}

function resultError(result: ComputerCommandResult): string | null {
  return result.ok ? null : result.error;
}

/**
 * Run one computer tool call. Never throws; every failure is a JSON
 * `{ok:false, error}` the model can read and react to.
 */
export async function runComputerTool(input: {
  db: Db;
  userId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const named = typeof input.args.computer === "string" ? input.args.computer : null;
  const device = await findOnlineDevice(input.db, input.userId, named);
  if (!device) {
    const online = named ? await listOnlineDevices(input.db, input.userId) : [];
    if (online.length > 0) {
      return fail(`No connected computer is named '${named}'. Connected: ${online.map((d) => d.name).join(", ")}.`);
    }
    return fail("No computer is connected. Ask the person to open the helper app on their computer.");
  }
  if (input.name === "computer_observe") {
    const result = await sendDeviceCommand(
      device.id,
      {
        type: "observe",
        screenshot: input.args.screenshot !== false,
        max_elements: clampInt(input.args.max_elements, 80, 1, 150),
      },
      { timeoutMs: OBSERVE_TIMEOUT_MS, signal: input.signal },
    );
    const error = resultError(result);
    if (error !== null) return fail(error);
    if (!("observation" in result)) return fail("The computer answered with something else.");
    const { observation } = result;
    if (observation.screenshot?.data) {
      stashScreenshot(input.callId, {
        data: observation.screenshot.data,
        mimeType: observation.screenshot.mime_type,
      });
    }
    return observationText(observation);
  }
  if (input.name === "computer_act") {
    const frameId = input.args.frame_id;
    if (typeof frameId !== "string" || !frameId) return fail("frame_id is required");
    const parsed = parseActions(input.args.actions);
    if (!parsed.ok) return fail(parsed.error);
    if (device.capabilities?.coordinates === "refs_only") {
      const aimed = parsed.actions.findIndex(
        (action) => (action.type === "click" || action.type === "scroll") && !action.ref && (action.x !== undefined || action.y !== undefined),
      );
      if (aimed >= 0) {
        return fail(`action ${aimed}: ${device.name} takes clicks and scrolls on listed elements only; use a ref from computer_observe.`);
      }
    }
    const result = await sendDeviceCommand(
      device.id,
      { type: "act", frame_id: frameId, actions: parsed.actions },
      { timeoutMs: ACT_TIMEOUT_MS, signal: input.signal },
    );
    const error = resultError(result);
    if (error !== null) return fail(error);
    if (!("act" in result)) return fail("The computer answered with something else.");
    return JSON.stringify({ ok: true, ...result.act });
  }
  return fail(`No tool named '${input.name}'.`);
}
