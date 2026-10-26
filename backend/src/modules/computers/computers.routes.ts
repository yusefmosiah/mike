// HTTP layer for the computers module. Two surfaces on one router:
//
//   signed in (requireAuth)    — add, list and revoke computers
//   /device/* (bearer token)   — the helper app: collect the next command,
//                                return a result, and say it is still there

import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { ComputerCommandResult } from "@mike/contracts";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  authenticateDevice,
  createComputerDevice,
  listComputerDevices,
  nextDeviceCommand,
  parseDeviceName,
  parseHeartbeat,
  recordHeartbeat,
  requeueDeviceCommand,
  revokeComputerDevice,
  submitDeviceResult,
  touchDevice,
  type AuthenticatedDevice,
} from "./computers.service";

export const computersRouter = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WAIT_SECONDS = 25;

// ---------------------------------------------------------------------------
// Helper app (bearer device token)
// ---------------------------------------------------------------------------

// A helper polls every ~25 s and beats every 15 s; this is ample headroom
// while still stopping a stolen token from hammering the API.
const deviceLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Too many requests. Please try again later." },
});

function deviceOf(res: Response): AuthenticatedDevice {
  return res.locals.computerDevice as AuthenticatedDevice;
}

async function authenticateRequest(req: Request, res: Response): Promise<boolean> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ detail: "Device token required" });
    return false;
  }
  const db = createDb();
  const result = await authenticateDevice(db, token);
  if (!result.ok) {
    sendServiceFailure(res, result);
    return false;
  }
  if (!result.data) {
    res.status(401).json({ detail: "Device token not recognised" });
    return false;
  }
  res.locals.computerDevice = result.data;
  await touchDevice(db, result.data.id);
  return true;
}

function requireDevice(req: Request, res: Response, next: NextFunction): void {
  authenticateRequest(req, res).then((ok) => ok && next(), next);
}

// GET /computers/device/next?wait=25 — the next command, or 204 after waiting.
computersRouter.get("/device/next", deviceLimiter, requireDevice, asyncRoute(async (req, res) => {
  const device = deviceOf(res);
  const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(req.query.wait) || 0));
  const closed = new AbortController();
  res.on("close", () => closed.abort());
  const command = await nextDeviceCommand(device.id, wait * 1000, closed.signal);
  if (!command) return void (res.headersSent || closed.signal.aborted ? undefined : res.status(204).end());
  if (closed.signal.aborted) {
    requeueDeviceCommand(device.id, command.id);
    return;
  }
  res.json(command);
}));

// POST /computers/device/results/:commandId — the helper's answer to one command.
computersRouter.post("/device/results/:commandId", deviceLimiter, requireDevice, (req, res) => {
  const body = req.body as ComputerCommandResult | undefined;
  if (!body || typeof body !== "object" || typeof body.ok !== "boolean") {
    return void res.status(400).json({ detail: "A result needs ok" });
  }
  const accepted = submitDeviceResult(deviceOf(res).id, String(req.params.commandId), body);
  if (!accepted) return void res.status(404).json({ detail: "No such command, or it already ended" });
  res.status(204).end();
});

// POST /computers/device/heartbeat — still here (requireDevice records it),
// with the helper's platform and capabilities (ComputerHeartbeat).
computersRouter.post("/device/heartbeat", deviceLimiter, requireDevice, asyncRoute(async (req, res) => {
  const device = deviceOf(res);
  await recordHeartbeat(createDb(), device.id, parseHeartbeat(req.body));
  res.json({ name: device.name });
}));

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

// GET /computers
computersRouter.get("/", requireAuth, asyncRoute(async (_req, res) => {
  const result = await listComputerDevices(createDb(), res.locals.userId as string);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json({ devices: result.data });
}));

// POST /computers { name } — the token is in this answer and nowhere else.
computersRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
  const name = parseDeviceName((req.body as Record<string, unknown> | undefined)?.name);
  if (!name.ok) return void res.status(400).json({ code: "bad_request", detail: name.detail });
  const result = await createComputerDevice(createDb(), res.locals.userId as string, name.value);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json(result.data);
}));

// DELETE /computers/:deviceId
computersRouter.delete("/:deviceId", requireAuth, asyncRoute(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.deviceId)) {
    return void res.status(404).json({ detail: "Computer not found" });
  }
  const result = await revokeComputerDevice(createDb(), res.locals.userId as string, req.params.deviceId);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(204).end();
}));

computersRouter.use(routerErrorHandler("[computers]"));
