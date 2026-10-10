// Citation checks over HTTP (goals/mission-6-citation-verification-subagents.md).
// Anyone who can read the chat can ask for a check, read its verdicts and
// re-check a verdict from its stored snapshot.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendServiceFailure } from "../../lib/serviceResult";
import { isMessageId } from "../chat/chat.service";
import {
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

// POST /citation-checks { chat_id, message_id }: queue a check of one answer.
citationsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const chatId = req.body?.chat_id;
    const messageId = req.body?.message_id;
    if (!isMessageId(chatId) || !isMessageId(messageId)) {
        return void res.status(400).json({ detail: "chat_id and message_id must be ids" });
    }
    const result = await startCitationCheck(createDb(), { ...actor(res), chatId, messageId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(202).json({ task: result.data });
}));

// GET /citation-checks?chat_id=&message_id=: the latest check and its verdicts.
citationsRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
    const chatId = req.query.chat_id;
    const messageId = req.query.message_id;
    if (!isMessageId(chatId) || !isMessageId(messageId)) {
        return void res.status(400).json({ detail: "chat_id and message_id must be ids" });
    }
    const result = await getCitationChecks(createDb(), { ...actor(res), chatId, messageId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
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
