// HTTP layer for the vault: the signed-in user's secrets, by metadata only.
// A new value arrives sealed to the vault's key by the browser; this server
// relays it and cannot open it.
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  allowWorkstationVault,
  createSecret,
  deleteSecret,
  getSealKey,
  listSecrets,
  secretActivity,
  updateSecret,
  vaultEnabled,
  workstationVaultState,
} from "./vault.service";

export const vaultRouter = Router();

vaultRouter.use(requireAuth);
vaultRouter.use((_req: Request, res: Response, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

vaultRouter.get("/status", (_req, res) => {
  res.json({ enabled: vaultEnabled() });
});

vaultRouter.get(
  "/seal-key",
  asyncRoute(async (_req, res) => {
    const result = await getSealKey();
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

vaultRouter.get(
  "/secrets",
  asyncRoute(async (_req, res) => {
    const result = await listSecrets(res.locals.userId as string);
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ secrets: result.data });
  }),
);

vaultRouter.post(
  "/secrets",
  asyncRoute(async (req, res) => {
    const result = await createSecret(res.locals.userId as string, (req.body ?? {}) as Record<string, unknown>);
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(201).json({ secret: result.data });
  }),
);

vaultRouter.patch(
  "/secrets/:secretId",
  asyncRoute(async (req, res) => {
    const result = await updateSecret(
      res.locals.userId as string,
      String(req.params.secretId),
      (req.body ?? {}) as Record<string, unknown>,
    );
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ secret: result.data });
  }),
);

vaultRouter.delete(
  "/secrets/:secretId",
  asyncRoute(async (req, res) => {
    const result = await deleteSecret(res.locals.userId as string, String(req.params.secretId));
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ deleted: true });
  }),
);

vaultRouter.get(
  "/activity",
  asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const result = await secretActivity(res.locals.userId as string, limit);
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ events: result.data });
  }),
);

vaultRouter.get(
  "/workstation",
  asyncRoute(async (_req, res) => {
    const result = await workstationVaultState(createDb(), res.locals.userId as string);
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ workstation: result.data });
  }),
);

vaultRouter.post(
  "/workstation/allow",
  asyncRoute(async (_req, res) => {
    const result = await allowWorkstationVault(createDb(), res.locals.userId as string);
    if (!result.ok) return sendServiceFailure(res, result);
    res.json({ workstation: result.data });
  }),
);

vaultRouter.use(routerErrorHandler);
