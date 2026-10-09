// HTTP layer for the word-chat module — the Word task pane's chat surface.
//
// Route handlers parse params/query/body, call the wordChat.service functions,
// and map their typed results onto status codes and JSON. POST /word-chat
// prepares the turn and hands the rest to driveWordChatTurn, attaching the run
// to this response.

import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendInternalError } from "../../lib/httpError";
import {
  attachAssistantTurnSse,
    requestedIncarnation,
  getActiveAssistantTurn,
  getAssistantTurnRun,
} from "../../lib/assistantTurnRuns";
import {
  parseChatMessages,
  parseOptionalChatId,
  parseOptionalDocumentContext,
  parseOptionalModel,
  parseOptionalReasoning,
  submitClientToolResult,
  WORD_EDIT_FORMATS,
  type WordEditApplyMode,
} from "../chat/chat.service";
import {
  driveWordChatTurn,
  getWordChatWithMessages,
  listWordChats,
  prepareWordChatStream,
  saveProposedWordEdit,
  updateWordChatModel,
  updateWordChatReasoning,
  updateWordEditOutcome,
  type ProposedWordEdit,
} from "./wordChat.service";

export const wordChatRouter = Router();

type WordChatStorageMode = "cloud" | "local";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDocumentId(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return { ok: false, detail: "document_id must be a UUID" };
  }
  return { ok: true, value };
}

function parseDocumentName(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: "Word document" };
  }
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "document_name must be a non-empty string",
    };
  }
  const documentName = value.trim();
  if (documentName.length > 255) {
    return {
      ok: false,
      detail: "document_name must be at most 255 characters",
    };
  }
  return { ok: true, value: documentName };
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseStorageMode(
  value: unknown,
): { ok: true; value: WordChatStorageMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "cloud") {
    return { ok: true, value: "cloud" };
  }
  if (value === "local") return { ok: true, value: "local" };
  return { ok: false, detail: 'storage must be "cloud" or "local"' };
}

function parseEditApplyMode(
  value: unknown,
): { ok: true; value: WordEditApplyMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "approval") {
    return { ok: true, value: "approval" };
  }
  if (value === "direct") return { ok: true, value: "direct" };
  return {
    ok: false,
    detail: 'edit_apply_mode must be "direct" or "approval"',
  };
}

function parseBlockIndex(
  value: string,
): { ok: true; value: number } | { ok: false; detail: string } {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return {
      ok: false,
      detail: "blockIndex must be a non-negative integer",
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) {
    return { ok: false, detail: "blockIndex is out of range" };
  }
  return { ok: true, value: parsed };
}

function parseProposedWordEdit(
  value: unknown,
): { ok: true; value: ProposedWordEdit } | { ok: false; detail: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "edit body is required" };
  }
  const body = value as Record<string, unknown>;
  const original =
    typeof body.original_text === "string" ? body.original_text : "";
  if (!original.trim()) {
    return { ok: false, detail: "original_text is required" };
  }
  if (original.length > 200) {
    return {
      ok: false,
      detail: "original_text must be at most 200 characters",
    };
  }
  const replacement =
    typeof body.replacement_text === "string" ? body.replacement_text : "";
  if (replacement.length > 200_000) {
    return { ok: false, detail: "replacement_text is too long" };
  }
  const formats = Array.isArray(body.formats)
    ? body.formats.filter(
        (entry): entry is string =>
          typeof entry === "string" && WORD_EDIT_FORMATS.has(entry),
      )
    : [];
  if (Array.isArray(body.formats) && formats.length !== body.formats.length) {
    return { ok: false, detail: "formats contains an unsupported value" };
  }
  const parsedMode = parseEditApplyMode(body.apply_mode);
  if (!parsedMode.ok) return parsedMode;
  if (
    body.occurrence !== undefined &&
    body.occurrence !== null &&
    body.occurrence !== "all"
  ) {
    return { ok: false, detail: 'occurrence must be "all" or null' };
  }
  return {
    ok: true,
    value: {
      original_text: original,
      replacement_text: replacement,
      formats,
      occurrence: body.occurrence === "all" ? "all" : null,
      reason:
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 10_000)
          : null,
      apply_mode: parsedMode.value,
    },
  };
}

/**
 * The run this caller may act on, or undefined.
 *
 * Everything a Word turn can be authorised by lives in the run: the user it
 * belongs to and the embedded document the pane was attached to when it
 * started. That is deliberate — a local chat has no server row, and a cloud
 * chat's row says nothing about which run is live — so ownership is checked
 * here rather than being inferred from the transcript.
 */
function wordTurnRunFor(
  chatId: string,
  turnId: string,
  caller: { userId: string; clientDocumentId: string },
) {
  const run = getAssistantTurnRun(turnId, "word");
  if (!run || run.chatId !== chatId) return undefined;
  if (run.userId !== caller.userId) return undefined;
  if (run.meta.clientDocumentId !== caller.clientDocumentId) return undefined;
  return run;
}

/** One answer for unknown, finished-and-forgotten, and not-yours. */
function turnNotFound(res: Response): void {
  res.status(404).json({
    code: "turn_not_found",
    detail: "This response is no longer being generated.",
  });
}

// GET /word-chat?document_id=<embedded document UUID>&limit=10
wordChatRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;
  const requestedOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
  const offset = Number.isFinite(requestedOffset)
    ? Math.max(requestedOffset, 0)
    : 0;
  const db = createDb();
  const result = await listWordChats(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    limit,
    offset,
  });
  if (!result.ok) {
    return void res.status(500).json({ detail: "Failed to load Word chats" });
  }
  res.json(result.chats);
}));

// GET /word-chat/:chatId?document_id=<embedded document UUID>
wordChatRouter.get("/:chatId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const db = createDb();
  const result = await getWordChatWithMessages(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    return void res.status(500).json({ detail: "Failed to load Word chat" });
  }
  res.json({
    chat: result.chat,
    messages: result.messages,
    // A turn still generating into this chat, so a pane that has just
    // reopened attaches to it instead of showing a transcript whose last
    // answer is missing. (The reserved, still-null assistant row is filtered
    // out of `messages`, so there is nothing to double up with.)
    active_turn: getActiveAssistantTurn(req.params.chatId, "word"),
  });
}));

// GET /word-chat/:chatId/turn/:turnId/stream?document_id=<uuid>&from=<seq>
// Attach to a turn that is (or was, within the retention window) generating
// into this chat: frames with a sequence number >= `from` are replayed, then
// the live ones follow until the turn ends.
//
// Authorised from the RUN, not from a database row: a `storage: "local"` Word
// chat is never persisted, so there is no row to check — the run knows whose
// turn it is and which embedded document it belongs to, and that is exactly
// the pair the pane presents.
wordChatRouter.get(
  "/:chatId/turn/:turnId/stream",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    const run = wordTurnRunFor(req.params.chatId, req.params.turnId, {
      userId: res.locals.userId as string,
      clientDocumentId: parsedDocumentId.value,
    });
    if (!run) return void turnNotFound(res);
    const rawFrom = Number.parseInt(String(req.query.from ?? "1"), 10);
    const from = Number.isFinite(rawFrom) && rawFrom > 0 ? rawFrom : 1;
    attachAssistantTurnSse(res, run, from, requestedIncarnation(req.query.incarnation));
  }),
);

// POST /word-chat/:chatId/turn/:turnId/stop?document_id=<uuid>
// The one way to cut a Word answer short. Closing the SSE socket no longer
// does it, so the pane's Stop control calls this first and only then drops
// its own connection.
wordChatRouter.post(
  "/:chatId/turn/:turnId/stop",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    const run = wordTurnRunFor(req.params.chatId, req.params.turnId, {
      userId: res.locals.userId as string,
      clientDocumentId: parsedDocumentId.value,
    });
    if (!run) return void turnNotFound(res);
    if (run.finished) return void res.json({ stopped: false, finished: true });
    run.stop();
    res.json({ stopped: true, finished: false });
  }),
);

// PATCH /word-chat/:chatId/model?document_id=<embedded document UUID>
// Selection-time persistence for an existing cloud Word chat.
wordChatRouter.patch("/:chatId/model", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const parsedModel = parseOptionalModel(req.body?.model);
  if (!parsedModel.ok || !parsedModel.value) {
    return void res.status(400).json({
      detail: parsedModel.ok ? "model is required" : parsedModel.detail,
    });
  }

  const db = createDb();
  const result = await updateWordChatModel(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
    requestedModel: parsedModel.value,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    if (result.kind === "model") {
      return void res.status(result.status).json({
        code: result.code,
        detail: result.detail,
      });
    }
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  res.json({ id: req.params.chatId, model: result.model });
}));

// PATCH /word-chat/:chatId/reasoning?document_id=<embedded document UUID>
wordChatRouter.patch("/:chatId/reasoning", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedReasoning = parseOptionalReasoning(req.body?.reasoningLevel);
  if (
    !isUuid(req.params.chatId) ||
    !parsedReasoning.ok ||
    !parsedReasoning.value
  ) {
    return void res.status(400).json({
      detail: parsedReasoning.ok
        ? "reasoningLevel is required"
        : parsedReasoning.detail,
    });
  }
  const db = createDb();
  const result = await updateWordChatReasoning(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
    reasoningLevel: parsedReasoning.value,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    return void res.status(500).json({ detail: "Failed to save reasoning" });
  }
  res.json({
    id: req.params.chatId,
    reasoning_level: parsedReasoning.value,
  });
}));

// PUT /word-chat/messages/:messageId/edits/:blockIndex
// Idempotently creates the canonical edit row as soon as a streamed edit
// block seals. The final assistant-message save later replaces the raw tags
// with a lightweight reference to the same row.
wordChatRouter.put(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const parsedEdit = parseProposedWordEdit(req.body);
    if (!parsedEdit.ok) {
      return void res.status(400).json({ detail: parsedEdit.detail });
    }
    const db = createDb();
    const result = await saveProposedWordEdit(db, {
      userId,
      clientDocumentId: parsedDocumentId.value,
      messageId: req.params.messageId,
      blockIndex: parsedBlockIndex.value,
      edit: parsedEdit.value,
    });
    if (!result.ok) {
      if (result.kind === "not_found") {
        return void res.status(404).json({ detail: "Message not found" });
      }
      return void res.status(500).json({ detail: "Failed to save Word edit" });
    }
    res.json(result.edit);
  }),
);

// PATCH /word-chat/messages/:messageId/edits/:blockIndex
// Stores durable apply and accept/reject outcomes without rewriting the
// assistant message JSON.
wordChatRouter.patch(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.apply_status !== undefined) {
      if (
        body.apply_status !== "proposed" &&
        body.apply_status !== "applied" &&
        body.apply_status !== "unmanaged" &&
        body.apply_status !== "failed"
      ) {
        return void res.status(400).json({ detail: "Invalid apply_status" });
      }
      patch.apply_status = body.apply_status;
      if (body.apply_status === "applied") {
        patch.applied_at = new Date().toISOString();
      }
    }
    if (body.resolution_status !== undefined) {
      if (
        body.resolution_status !== "accepted" &&
        body.resolution_status !== "rejected"
      ) {
        return void res
          .status(400)
          .json({ detail: "Invalid resolution_status" });
      }
      patch.resolution_status = body.resolution_status;
      patch.apply_status = "applied";
      patch.resolved_at = new Date().toISOString();
    }
    for (const field of [
      "matched_occurrences",
      "applied_occurrences",
    ] as const) {
      if (body[field] === undefined) continue;
      if (
        typeof body[field] !== "number" ||
        !Number.isSafeInteger(body[field]) ||
        body[field] < 0
      ) {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] = body[field];
    }
    for (const field of ["error_code", "error_message"] as const) {
      if (body[field] === undefined) continue;
      if (body[field] !== null && typeof body[field] !== "string") {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] =
        typeof body[field] === "string" ? body[field].slice(0, 10_000) : null;
    }
    if (Object.keys(patch).length === 1) {
      return void res.status(400).json({ detail: "No edit fields supplied" });
    }
    const db = createDb();
    const result = await updateWordEditOutcome(db, {
      userId,
      clientDocumentId: parsedDocumentId.value,
      messageId: req.params.messageId,
      blockIndex: parsedBlockIndex.value,
      patch,
    });
    if (!result.ok) {
      if (result.kind === "message_not_found") {
        return void res.status(404).json({ detail: "Message not found" });
      }
      if (result.kind === "edit_not_found") {
        return void res.status(404).json({ detail: "Edit not found" });
      }
      return void res
        .status(500)
        .json({ detail: "Failed to update Word edit" });
    }
    res.json(result.edit);
  }),
);

// POST /word-chat/tool-result — the task pane's return channel for a
// client-executed tool call. The SSE stream carries a `client_tool_call`
// frame down to the pane; the pane executes it with Office.js and posts the
// outcome here, which resolves the tool loop awaiting inside POST /word-chat.
wordChatRouter.post("/tool-result", requireAuth, (req, res) => {
  const userId = res.locals.userId as string;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  if (typeof body.tool_call_id !== "string" || !isUuid(body.tool_call_id)) {
    return void res.status(400).json({ detail: "tool_call_id must be a UUID" });
  }
  // `result` is opaque here; the awaiting adapter normalizes it. Delivery
  // fails for expired, unknown, or foreign ids — all three answer the same
  // 404 so the endpoint cannot be probed for live call ids.
  const delivered = submitClientToolResult(
    body.tool_call_id,
    userId,
    body.result,
  );
  if (!delivered) {
    return void res
      .status(404)
      .json({ detail: "Unknown or expired tool call" });
  }
  res.status(204).end();
});

// POST /word-chat — Word-specific streaming endpoint.
wordChatRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
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
  if (parsedChatId.value && !isUuid(parsedChatId.value)) {
    return void res.status(400).json({ detail: "chat_id must be a UUID" });
  }
  const parsedModel = parseOptionalModel(body.model);
  if (!parsedModel.ok) {
    return void res.status(400).json({ detail: parsedModel.detail });
  }
  const parsedReasoning = parseOptionalReasoning(body.reasoning);
  if (!parsedReasoning.ok) {
    return void res.status(400).json({ detail: parsedReasoning.detail });
  }
  const parsedDocumentContext = parseOptionalDocumentContext(
    body.document_context,
  );
  if (!parsedDocumentContext.ok) {
    return void res.status(400).json({ detail: parsedDocumentContext.detail });
  }
  const parsedDocumentId = parseDocumentId(body.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedDocumentName = parseDocumentName(body.document_name);
  if (!parsedDocumentName.ok) {
    return void res.status(400).json({ detail: parsedDocumentName.detail });
  }
  const parsedStorage = parseStorageMode(body.storage);
  if (!parsedStorage.ok) {
    return void res.status(400).json({ detail: parsedStorage.detail });
  }
  const parsedEditApplyMode = parseEditApplyMode(body.edit_apply_mode);
  if (!parsedEditApplyMode.ok) {
    return void res.status(400).json({ detail: parsedEditApplyMode.detail });
  }
  // Capability flag from the task pane. Only a pane that declares it can
  // answer client_tool_call frames; older panes keep the streamed <EDITS>
  // protocol so they are never handed tool calls they would ignore.
  const clientToolsEnabled = body.client_tools === true;

  const activeDocumentName = parsedDocumentName.value;
  const persistChat = parsedStorage.value === "cloud";
  const editApplyMode = parsedEditApplyMode.value;
  const db = createDb();

  const prep = await prepareWordChatStream(db, {
    userId,
    userEmail,
    messages: parsedMessages.value,
    chatId: parsedChatId.value ?? null,
    clientDocumentId: parsedDocumentId.value,
    activeDocumentName,
    documentContext: parsedDocumentContext.documentContext,
    persistChat,
    clientToolsEnabled,
    requestedModel: parsedModel.value,
    requestedReasoning: parsedReasoning.value,
    requestedTimeZone: req.body?.time_zone,
  });
  if (!prep.ok) {
    if (prep.status === 500 && "error" in prep)
      return void sendInternalError(res, prep.error);
    return void res.status(prep.status).json({
      ...(prep.code ? { code: prep.code } : {}),
      detail: prep.detail,
    });
  }

  const prepared = prep.prepared;
  const outcome = await driveWordChatTurn(db, {
    prepared,
    userId,
    userEmail,
    clientDocumentId: parsedDocumentId.value,
    activeDocumentName,
    persistChat,
    clientToolsEnabled,
    editApplyMode,
    assistantMessageId: randomUUID(),
    // Only a cloud chat's rows can rebuild the turn after a restart.
    durableContext:
      persistChat && prepared.inputMessageId
        ? {
            surface: "word",
            userId,
            userEmail: userEmail ?? null,
            chatId: prepared.chatId,
            clientDocumentId: parsedDocumentId.value,
            activeDocumentName,
            documentContext: parsedDocumentContext.documentContext ?? null,
            clientToolsEnabled,
            editApplyMode,
            model: parsedModel.value ?? null,
            reasoning: parsedReasoning.value ?? null,
            timeZone:
              typeof req.body?.time_zone === "string" ? req.body.time_zone : null,
            turnUserMessageId: prepared.inputMessageId,
          }
        : null,
    open: (run) => attachAssistantTurnSse(res, run),
  });
  if (!outcome.ok) res.status(outcome.status).json(outcome.body);
}));

wordChatRouter.use(routerErrorHandler("[word-chat]"));
