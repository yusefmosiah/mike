import { attachAssistantTurnSse } from "../../lib/assistantTurnRuns";
// HTTP layer for the project-chat module.
//
// The route handler parses the request body, calls
// prepareProjectChatStream for the pre-stream DB work, and drives the turn
// (driveProjectChatTurn) with the run attached to this response as SSE.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import {
    isMessageId,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalReasoning,
    devLog,
} from "../chat/chat.service";
import { sendInternalError } from "../../lib/httpError";
import {
    driveProjectChatTurn,
    prepareProjectChatStream,
} from "./projectChat.service";

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedDisplayedDoc = parseOptionalDisplayedDoc(body.displayed_doc);
    if (!parsedDisplayedDoc.ok) {
        return void res.status(400).json({ detail: parsedDisplayedDoc.detail });
    }
    const parsedAttachedDocuments = parseOptionalAttachedDocuments(
        body.attached_documents,
    );
    if (!parsedAttachedDocuments.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAttachedDocuments.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }
    // Auto Mode is a per-turn opt-in, off unless the caller asks for it.
    // Anything but a boolean is a client bug, not a preference. The content
    // .edit gate prepareProjectChatStream already applies to every send (403
    // for a viewer) is the same standing writing needs, so a stream never
    // starts for a caller who may not write.
    const rawAutoMode = body.auto_mode;
    if (rawAutoMode !== undefined && typeof rawAutoMode !== "boolean") {
        return void res
            .status(400)
            .json({ detail: "auto_mode must be a boolean" });
    }
    const autoMode = rawAutoMode === true;
    // Regenerate names the existing prompt the new answer hangs from; see
    // linkOnlyToMessageId in prepareProjectChatStream. Without it a send is a send.
    const rawLinkOnlyToMessageId = body.link_only_to_message_id;
    if (
        rawLinkOnlyToMessageId != null &&
        !isMessageId(rawLinkOnlyToMessageId)
    ) {
        return void res
            .status(400)
            .json({ detail: "link_only_to_message_id must be a message id" });
    }
    const linkOnlyToMessageId = isMessageId(rawLinkOnlyToMessageId)
        ? rawLinkOnlyToMessageId
        : null;

    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const model = parsedModel.value;
    const displayed_doc = parsedDisplayedDoc.value;
    const attached_documents = parsedAttachedDocuments.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    const assistantMessageId = askInputsResponse ? null : randomUUID();
    const inputMessageId = askInputsResponse ? null : randomUUID();

    const db = createDb();

    devLog("[project-chat/stream] incoming request", {
        userId,
        projectId,
        chat_id,
        model,
        auto_mode: autoMode,
    });

    const prep = await prepareProjectChatStream(db, {
        userId,
        userEmail,
        projectId,
        messages,
        chatId: chat_id ?? null,
        inputMessageId,
        linkOnlyToMessageId,
        displayed_doc,
        attached_documents,
        askInputsResponse,
        autoMode,
        requestedModel: model,
        requestedReasoning: parsedReasoning.value,
        requestedTimeZone: req.body?.time_zone,
        // The turn's identity, which is also its claim on the thread.
        turnId:
            assistantMessageId ??
            askInputsResponse?.assistant_message_id ??
            randomUUID(),
    });
    if (!prep.ok) {
        if ("internal" in prep) return void sendInternalError(res, prep.error);
        return void res.status(prep.status).json({
            ...(prep.code ? { code: prep.code } : {}),
            detail: prep.detail,
            ...(prep.generating ? { generating: prep.generating } : {}),
        });
    }

    const turnUserMessageId = prep.prepared.turnUserMessageId;
    const outcome = await driveProjectChatTurn(db, {
        prepared: prep.prepared,
        userId,
        userEmail,
        projectId,
        assistantMessageId,
        inputMessageId,
        askInputsResponse,
        // A fresh answer can be driven again after a restart; an ask_inputs
        // continuation appends to an existing row and is not recorded.
        durableContext:
            assistantMessageId && turnUserMessageId
                ? {
                      surface: "project-chat",
                      userId,
                      userEmail: userEmail ?? null,
                      projectId,
                      chatId: prep.prepared.chatId,
                      model: model ?? null,
                      reasoning: parsedReasoning.value ?? null,
                      autoMode,
                      timeZone:
                          typeof req.body?.time_zone === "string"
                              ? req.body.time_zone
                              : null,
                      displayedDoc: displayed_doc ?? null,
                      attachedDocuments: attached_documents ?? null,
                      turnUserMessageId,
                  }
                : null,
        open: (run) => attachAssistantTurnSse(res, run),
    });
    if (!outcome.ok) return void res.status(outcome.status).json(outcome.body);
}));

projectChatRouter.use(routerErrorHandler("[project-chat]"));
