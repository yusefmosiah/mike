// A person's computers: add one (its token is shown once), list, revoke, and
// recognise a helper by its bearer token.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../lib/db";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import type { ComputerDevice, CreatedComputerDevice } from "@mike/contracts";

/** A device counts as online for this long after the server last heard from it. */
export const ONLINE_WINDOW_MS = 60_000;
const MAX_DEVICES = 20;
const MAX_NAME = 80;
const TOKEN_PREFIX = "cmp_";
const DEVICE_COLUMNS = "id, user_id, name, created_at, last_seen_at, revoked_at";

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export type AuthenticatedDevice = { id: string; userId: string; name: string };

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isOnline(lastSeenAt: string | null, now: number): boolean {
  return !!lastSeenAt && now - Date.parse(lastSeenAt) < ONLINE_WINDOW_MS;
}

function toView(row: DeviceRow, now = Date.now()): ComputerDevice {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    online: isOnline(row.last_seen_at, now),
  };
}

export function parseDeviceName(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "name is required" };
  }
  const name = value.trim();
  if (name.length > MAX_NAME) {
    return { ok: false, detail: `name must be at most ${MAX_NAME} characters` };
  }
  return { ok: true, value: name };
}

export async function createComputerDevice(
  db: Db,
  userId: string,
  name: string,
): Promise<ServiceResult<CreatedComputerDevice>> {
  const { data: live, error: countError } = await db
    .from("computer_devices")
    .select("id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .limit(MAX_DEVICES);
  if (countError) return internalFailure(countError);
  if ((live ?? []).length >= MAX_DEVICES) {
    return failure("conflict", "Revoke a computer before adding another.", "too_many_devices");
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const { data, error } = await db
    .from("computer_devices")
    .insert({ user_id: userId, name, token_hash: hashDeviceToken(token) })
    .select(DEVICE_COLUMNS)
    .single();
  if (error || !data) return internalFailure(error);
  return ok({ device: toView(data as DeviceRow), token });
}

export async function listComputerDevices(
  db: Db,
  userId: string,
): Promise<ServiceResult<ComputerDevice[]>> {
  const { data, error } = await db
    .from("computer_devices")
    .select(DEVICE_COLUMNS)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_DEVICES);
  if (error) return internalFailure(error);
  const now = Date.now();
  return ok(((data ?? []) as DeviceRow[]).map((row) => toView(row, now)));
}

export async function revokeComputerDevice(
  db: Db,
  userId: string,
  deviceId: string,
): Promise<ServiceResult<null>> {
  const { data, error } = await db
    .from("computer_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", deviceId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) return internalFailure(error);
  if (!data || (data as unknown[]).length === 0) {
    return failure("not_found", "Computer not found");
  }
  return ok(null);
}

/** The live device a bearer token belongs to, or null. */
export async function authenticateDevice(
  db: Db,
  token: string,
): Promise<ServiceResult<AuthenticatedDevice | null>> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return ok(null);
  const { data, error } = await db
    .from("computer_devices")
    .select(DEVICE_COLUMNS)
    .eq("token_hash", hashDeviceToken(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return ok(null);
  const row = data as DeviceRow;
  return ok({ id: row.id, userId: row.user_id, name: row.name });
}

const lastTouched = new Map<string, number>();
const TOUCH_EVERY_MS = 10_000;

/** Record that a device was heard from, at most every few seconds. */
export async function touchDevice(db: Db, deviceId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastTouched.get(deviceId) ?? 0) < TOUCH_EVERY_MS) return;
  lastTouched.set(deviceId, now);
  await db
    .from("computer_devices")
    .update({ last_seen_at: new Date(now).toISOString() })
    .eq("id", deviceId);
}

/** The user's most recently seen online device, or null (also when the lookup fails). */
export async function findOnlineDevice(
  db: Db,
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  try {
    const { data, error } = await db
      .from("computer_devices")
      .select("id, name")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data as { id: string; name: string };
  } catch {
    return null;
  }
}
