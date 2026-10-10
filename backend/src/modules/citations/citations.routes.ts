// Citation checks over HTTP (goals/mission-6-citation-verification-subagents.md).
// Anyone who can read a document can ask for a check of its citations, read
// the verdicts and re-check a verdict from its stored snapshot.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendServiceFailure } from "../../lib/serviceResult";
import { isMessageId } from "../chat/chat.service";
import {
    autoCheckCitations,
    autoCheckPending,
    cancelCitationCheck,
    getCitationChecks,
    recheckCitation,
    startCitationCheck,
} from "./citations.service";

export const citationsRouter = Router();

function actor(res: { locals: Record<string, unknown> }) {
    return {
        userId: res.locals.userId as string,
        userEmail: (res.locals.userEmail as string | undefined) ?? null,
    };
}

// POST /citation-checks/documents/:documentId { version_id?, model? }: queue a
// check of a document version (the current one unless named).
citationsRouter.post("/documents/:documentId", requireAuth, asyncRoute(async (req, res) => {
    const documentId = req.params.documentId;
    const versionId = req.body?.version_id ?? null;
    const model = typeof req.body?.model === "string" ? req.body.model : null;
    if (!isMessageId(documentId) || (versionId !== null && !isMessageId(versionId))) {
        return void res.status(400).json({ detail: "documentId and version_id must be ids" });
    }
    const result = await startCitationCheck(createDb(), { ...actor(res), documentId, versionId, model });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(202).json({ task: result.data });
}));

// GET /citation-checks/documents/:documentId?version_id=: the latest check and its verdicts.
citationsRouter.get("/documents/:documentId", requireAuth, asyncRoute(async (req, res) => {
    const documentId = req.params.documentId;
    const versionId = typeof req.query.version_id === "string" ? req.query.version_id : null;
    if (!isMessageId(documentId) || (versionId !== null && !isMessageId(versionId))) {
        return void res.status(400).json({ detail: "documentId and version_id must be ids" });
    }
    const db = createDb();
    const result = await getCitationChecks(db, { ...actor(res), documentId, versionId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json({ ...result.data, auto_pending: await autoCheckPending(db, documentId) });
}));

// Opening a document: check it if its citations changed since the last check.
citationsRouter.post("/documents/:documentId/auto", requireAuth, asyncRoute(async (req, res) => {
    const documentId = req.params.documentId;
    if (!isMessageId(documentId)) return void res.status(400).json({ detail: "documentId must be an id" });
    const result = await autoCheckCitations(createDb(), { ...actor(res), documentId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json({ started: result.data.started, reason: result.data.reason, task: result.data.task });
}));

// POST /citation-checks/:checkId/recheck: regrade from the stored snapshot.
citationsRouter.post("/:checkId/recheck", requireAuth, asyncRoute(async (req, res) => {
    if (!isMessageId(req.params.checkId)) return void res.status(400).json({ detail: "checkId must be an id" });
    const result = await recheckCitation(createDb(), { ...actor(res), checkId: req.params.checkId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
}));

// POST /citation-checks/tasks/:taskId/cancel
citationsRouter.post("/tasks/:taskId/cancel", requireAuth, asyncRoute(async (req, res) => {
    if (!isMessageId(req.params.taskId)) return void res.status(400).json({ detail: "taskId must be an id" });
    const result = await cancelCitationCheck(createDb(), { ...actor(res), taskId: req.params.taskId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
}));

citationsRouter.use(routerErrorHandler("[citations]"));
