// HTTP layer for the diligence module.
//
// Two endpoints: POST /diligence/runs queues one RLM deep run over a project,
// GET /diligence/runs/:jobId polls it. Handlers parse the request, call the
// service with the caller from res.locals, and map ServiceResult failures onto
// status codes; visibility and permission policy live in the service.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { enqueueRlmRun, getRlmRun } from "./diligence.service";

export const diligenceRouter = Router();
diligenceRouter.use(requireAuth);

diligenceRouter.post(
    "/runs",
    asyncRoute(async (req, res) => {
        const result = await enqueueRlmRun({
            db: createServerSupabase(),
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string | undefined,
            body: req.body,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.status(202).json({ job_id: result.data.jobId });
    }),
);

diligenceRouter.get(
    "/runs/:jobId",
    asyncRoute(async (req, res) => {
        const result = await getRlmRun({
            db: createServerSupabase(),
            jobId: req.params.jobId,
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string | undefined,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

diligenceRouter.use(routerErrorHandler("[diligence]"));
