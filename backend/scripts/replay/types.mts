/**
 * Shapes shared by the replay simulator's steps. The wire payloads come from
 * @mike/contracts; everything here is the simulator's own file format.
 */
import type {
    AskInputItem,
    AskInputResponseItem,
    AssistantEvent,
} from "@mike/contracts";

export type { AskInputItem, AskInputResponseItem, AssistantEvent };

/** One chat_messages row, as `select json_agg(...) from chat_messages` exports it. */
export type ChatMessageRow = {
    id: string;
    parent_message_id: string | null;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files: MessageFileRef[] | null;
    workflow: { id: string; title: string } | null;
    created_at: string;
};

export type MessageFileRef = {
    filename: string;
    document_id?: string;
    version_id?: string;
    version_number?: number | null;
};

/** An ask_inputs pause in the original thread and what the user answered. */
export type OriginalAsk = {
    assistantMessageId: string;
    eventId: string;
    items: AskInputItem[];
    /** Null when the thread never answered it. */
    responses: AskInputResponseItem[] | null;
};

/**
 * Metrics for one turn (one user prompt plus everything the assistant did
 * until the next prompt, ask_inputs continuations included). The same shape
 * describes the original and the replay so the report can diff them.
 * `null` means "not measured", never zero.
 */
export type TurnMetrics = {
    /** Prompt sent to last frame (replay) or prompt to last model call end (original, needs entries). */
    wallMs: number | null;
    /** turn_usage parts, summed over continuations. */
    usage: { input: number; output: number; cost: number; parts: number };
    /** Per model call, from pi durable entries; null without an entries export. */
    calls: CallMetrics | null;
    tools: {
        codeCells: number;
        codeCellsFailed: number;
        /** ok cells whose output still carries a Python traceback or error line. */
        codeCellsErrorOutput: number;
        subagents: number;
        subagentsFailed: number;
        mcpCalls: number;
        mcpErrors: number;
        docReads: number;
        docCreated: number;
        docEdited: number;
        workflowsApplied: number;
    };
    /** `error` parts, plus stream/HTTP failures the runner saw (replay only). */
    errors: string[];
    asks: number;
    answerChars: number;
    reasoningChars: number;
};

export type CallMetrics = {
    modelCalls: number;
    subagentCalls: number;
    models: string[];
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    cost: number;
    compactions: number;
    /** Sum of the calls' own durations. */
    modelMs: number;
    stopReasons: Record<string, number>;
};

export type ExtractedTurn = {
    /** 1-based position on the branch path. */
    index: number;
    messageId: string;
    createdAt: string;
    content: string;
    files: MessageFileRef[];
    workflow: { id: string; title: string } | null;
    assistantMessageId: string | null;
    asks: OriginalAsk[];
    /** The original answer's visible text, for the report's language and duplicate checks. */
    answer: string;
    reasoning: string;
    metrics: TurnMetrics;
};

export type ExtractedThread = {
    format: "mike-replay-thread/1";
    source: string;
    leafId: string;
    /** created_at of the first prompt on the path: the world state's T0. */
    t0: string;
    /** created_at of the last message on the path. */
    t1: string;
    /** Messages in the export that are not on the path (other branches). */
    offPathMessages: number;
    /** Chat model/reasoning, when given on the command line. */
    model: string | null;
    turns: ExtractedTurn[];
};

/** What `seed` creates for the simulation account. */
export type SeedMap = {
    format: "mike-replay-seed/1";
    /** Original version_id (or document_id when no version) -> the new document. */
    documents: Record<string, MessageFileRef & { document_id: string }>;
    /** Original workflow id -> the workflow the simulation account should use (null: drop it). */
    workflows: Record<string, { id: string; title: string } | null>;
    memory: { applied: boolean; source: string | null; bytes: number } | null;
};

/** One SSE frame as the runner recorded it. */
export type RecordedFrame = {
    /** ms since the turn started. */
    t: number;
    seq: number | null;
    data: Record<string, unknown> | "[DONE]";
};

export type ReplayAttempt = {
    kind: "prompt" | "ask_response" | "retry";
    startedAt: string;
    endedAt: string;
    httpStatus: number | null;
    chatId: string | null;
    turnId: string | null;
    assistantMessageId: string | null;
    userMessageId: string | null;
    framesFile: string;
    frameCount: number;
    errors: string[];
    reconnects: number;
};

export type ReplayTurnRecord = {
    format: "mike-replay-turn/1";
    index: number;
    prompt: string;
    status: "ok" | "failed";
    startedAt: string;
    endedAt: string;
    wallMs: number;
    attempts: ReplayAttempt[];
    asks: {
        event: { event_id: string; items: AskInputItem[] };
        assistantMessageId: string;
        mappedFrom: "original" | "skipped";
        responses: AskInputResponseItem[];
    }[];
    droppedFiles: MessageFileRef[];
    /** Stored assistant rows for this turn, read back from GET /chat/:id. */
    assistantMessages: { id: string; content: AssistantEvent[] }[];
};

export type RunState = {
    format: "mike-replay-state/1";
    chatId: string | null;
    model: string | null;
    reasoning: string | null;
    /** Next turn index to run. */
    nextTurn: number;
    completed: number[];
    failed: number[];
    updatedAt: string;
};
