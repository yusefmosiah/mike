/**
 * `run`: sends the extracted prompts, in order, to a new chat as the
 * simulation account, through the same endpoints and SSE stream the web app
 * uses, and records everything that comes back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askResponseContent, mapAskResponse, pendingAsk } from "./asks.mts";
import { ApiError, readSse, type MikeClient } from "./client.mts";
import type {
    AskInputResponseItem,
    AssistantEvent,
    ExtractedThread,
    ExtractedTurn,
    MessageFileRef,
    RecordedFrame,
    ReplayAttempt,
    ReplayTurnRecord,
    RunState,
    SeedMap,
} from "./types.mts";

export type RunOptions = {
    thread: ExtractedThread;
    seed: SeedMap | null;
    outDir: string;
    model: string | null;
    reasoning: string | null;
    from?: number;
    until?: number;
    delayMs: number;
    retry: boolean;
    maxAskRounds: number;
    timeZone: string;
    autocompact: number | null;
    /** Reuse this chat instead of the state file's or a new one. */
    chatId?: string;
    /** Drop original workflows the seed map does not name, instead of sending their ids. */
    dropUnmappedWorkflows: boolean;
    downloadDocs: boolean;
    /** How long to wait for a turn the stream lost track of to finish. */
    turnTimeoutMs: number;
    log: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
};

type ChatRow = {
    id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: MessageFileRef[] | null;
    workflow?: { id: string; title: string } | null;
};
type ChatDetail = {
    messages: ChatRow[];
    active_turn?: { id: string } | null;
    generating?: { user_id: string | null } | null;
};
type ApiMessage = {
    role: "user" | "assistant";
    content: string;
    files?: MessageFileRef[];
    workflow?: { id: string; title: string };
};

const pad = (n: number) => String(n).padStart(3, "0");
const nowIso = () => new Date().toISOString();

/** The web app's history for a turn: user rows as typed, assistant rows as their visible text. */
export function historyMessages(rows: readonly ChatRow[]): ApiMessage[] {
    return rows.map((row) => {
        if (row.role === "user") {
            return {
                role: "user",
                content: typeof row.content === "string" ? row.content : "",
                ...(row.files && row.files.length > 0 ? { files: row.files } : {}),
                ...(row.workflow ? { workflow: row.workflow } : {}),
            };
        }
        const parts = Array.isArray(row.content) ? row.content : [];
        const text = typeof row.content === "string"
            ? row.content
            : parts.flatMap((p) => (p.type === "content" ? [p.text] : [])).join("");
        return { role: "assistant", content: text };
    });
}

/** Original attachments -> the simulation account's copies; unmapped ones are dropped and reported. */
export function mapFiles(
    files: readonly MessageFileRef[],
    seed: SeedMap | null,
): { files: MessageFileRef[]; dropped: MessageFileRef[] } {
    const out: MessageFileRef[] = [];
    const dropped: MessageFileRef[] = [];
    for (const file of files) {
        const mapped =
            (file.version_id && seed?.documents[file.version_id]) ||
            (file.document_id && seed?.documents[file.document_id]) ||
            null;
        if (mapped) out.push({ ...mapped, filename: mapped.filename || file.filename });
        else dropped.push(file);
    }
    return { files: out, dropped };
}

export function mapWorkflow(
    workflow: ExtractedTurn["workflow"],
    seed: SeedMap | null,
    dropUnmapped: boolean,
): { id: string; title: string } | null {
    if (!workflow) return null;
    if (seed && Object.hasOwn(seed.workflows, workflow.id)) return seed.workflows[workflow.id] ?? null;
    return dropUnmapped ? null : workflow;
}

export function loadState(outDir: string): RunState | null {
    const file = path.join(outDir, "state.json");
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as RunState;
}

function saveState(outDir: string, state: RunState) {
    state.updatedAt = nowIso();
    writeFileSync(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

type StreamOutcome = ReplayAttempt & { done: boolean };

class Runner {
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly client: MikeClient;
    private readonly opts: RunOptions;
    constructor(client: MikeClient, opts: RunOptions) {
        this.client = client;
        this.opts = opts;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    async detail(chatId: string): Promise<ChatDetail> {
        return this.client.json<ChatDetail>("GET", `/chat/${chatId}`);
    }

    /** Waits until the chat has no turn generating (after a lost stream). */
    async waitIdle(chatId: string): Promise<boolean> {
        const deadline = Date.now() + this.opts.turnTimeoutMs;
        while (Date.now() < deadline) {
            const d = await this.detail(chatId).catch(() => null);
            if (d && !d.active_turn && !d.generating) return true;
            await this.sleep(5_000);
        }
        return false;
    }

    /**
     * POST /chat and read its SSE stream to [DONE], resuming from the last
     * frame id when the connection drops (the web app's reconnect, simplified).
     */
    async stream(kind: ReplayAttempt["kind"], body: Record<string, unknown>, framesFile: string, chatId: string): Promise<StreamOutcome> {
        const startedAt = nowIso();
        const t0 = Date.now();
        const outcome: StreamOutcome = {
            kind,
            startedAt,
            endedAt: startedAt,
            httpStatus: null,
            chatId,
            turnId: null,
            assistantMessageId: null,
            userMessageId: null,
            framesFile: path.basename(framesFile),
            frameCount: 0,
            errors: [],
            reconnects: 0,
            done: false,
        };
        let lastSeq = 0;
        let incarnation: string | null = null;
        const record = (frame: RecordedFrame) => {
            outcome.frameCount += 1;
            appendFileSync(framesFile, `${JSON.stringify(frame)}\n`);
        };
        const consume = async (res: Response) => {
            if (!res.body) throw new Error("no response body");
            for await (const frame of readSse(res.body)) {
                const seq = frame.id !== null && Number.isFinite(Number(frame.id)) ? Number(frame.id) : null;
                if (seq !== null) lastSeq = seq;
                record({ t: Date.now() - t0, seq, data: frame.data });
                if (frame.data === "[DONE]") {
                    outcome.done = true;
                    return;
                }
                const d = frame.data;
                if (d.type === "stream_incarnation" && typeof d.incarnation === "string") incarnation = d.incarnation;
                if (d.type === "turn_restarted") lastSeq = 0;
                if (d.type === "chat_id") {
                    if (typeof d.chatId === "string") outcome.chatId = d.chatId;
                    if (typeof d.turnId === "string") outcome.turnId = d.turnId;
                    if (typeof d.assistantMessageId === "string") outcome.assistantMessageId = d.assistantMessageId;
                    if (typeof d.userMessageId === "string") outcome.userMessageId = d.userMessageId;
                }
                if (d.type === "error") outcome.errors.push(`stream error: ${String(d.message ?? "")}`);
                if (d.type === "cancelled") outcome.errors.push("stream cancelled");
            }
        };

        // A turn already generating in the chat (a previous attempt the stream
        // lost) answers 409; wait it out once.
        let res = await this.client.raw("POST", "/chat", { body, accept: "text/event-stream" });
        if (res.status === 409) {
            await res.body?.cancel().catch(() => {});
            this.opts.log("  chat busy (409); waiting for the running turn to finish");
            await this.waitIdle(chatId);
            res = await this.client.raw("POST", "/chat", { body, accept: "text/event-stream" });
        }
        outcome.httpStatus = res.status;
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            outcome.errors.push(`HTTP ${res.status}: ${text.slice(0, 500)}`);
            outcome.endedAt = nowIso();
            return outcome;
        }
        for (let attempt = 0; ; attempt++) {
            try {
                await consume(res);
                if (outcome.done) break;
                throw new Error("stream ended without [DONE]");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!outcome.turnId || attempt >= 5) {
                    outcome.errors.push(`stream lost: ${message}`);
                    break;
                }
                outcome.reconnects += 1;
                await this.sleep(Math.min(1_000 * 2 ** attempt, 15_000));
                const query = new URLSearchParams({ from: String(lastSeq + 1) });
                if (incarnation) query.set("incarnation", incarnation);
                const resumed = await this.client
                    .raw("GET", `/chat/${outcome.chatId}/turn/${outcome.turnId}/stream?${query}`, { accept: "text/event-stream" })
                    .catch(() => null);
                if (resumed?.status === 404) {
                    // The turn finished (or the server forgot it); its stored copy is what counts.
                    await resumed.body?.cancel().catch(() => {});
                    outcome.errors.push(`stream lost: ${message}; turn no longer streamable`);
                    break;
                }
                if (!resumed?.ok) {
                    await resumed?.body?.cancel().catch(() => {});
                    continue;
                }
                res = resumed;
            }
        }
        if (!outcome.done && outcome.chatId) await this.waitIdle(outcome.chatId);
        outcome.endedAt = nowIso();
        return outcome;
    }

    /** The assistant rows after the turn's prompt, as stored. */
    turnRows(detail: ChatDetail, userMessageId: string | null, prompt: string): ChatRow[] {
        const rows = detail.messages;
        let at = userMessageId ? rows.findIndex((r) => r.id === userMessageId) : -1;
        if (at < 0) {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i]!.role === "user" && rows[i]!.content === prompt) {
                    at = i;
                    break;
                }
            }
        }
        if (at < 0) return [];
        const out: ChatRow[] = [];
        for (const row of rows.slice(at + 1)) {
            if (row.role === "user") break;
            out.push(row);
        }
        return out;
    }

    async downloadDocs(turnIndex: number, rows: ChatRow[]) {
        const dir = path.join(this.opts.outDir, "docs");
        for (const row of rows) {
            for (const part of Array.isArray(row.content) ? row.content : []) {
                if ((part.type !== "doc_created" && part.type !== "doc_edited") || !part.download_url) continue;
                try {
                    const { data } = await this.client.bytes(part.download_url);
                    mkdirSync(dir, { recursive: true });
                    const safe = part.filename.replace(/[^\w.\- ()]+/g, "_");
                    writeFileSync(path.join(dir, `turn-${pad(turnIndex)}-${safe}`), data);
                } catch (error) {
                    this.opts.log(`  could not download ${part.filename}: ${error instanceof Error ? error.message : error}`);
                }
            }
        }
    }

    async runTurn(turn: ExtractedTurn, chatId: string): Promise<ReplayTurnRecord> {
        const { opts } = this;
        const started = Date.now();
        const record: ReplayTurnRecord = {
            format: "mike-replay-turn/1",
            index: turn.index,
            prompt: turn.content,
            status: "ok",
            startedAt: nowIso(),
            endedAt: "",
            wallMs: 0,
            attempts: [],
            asks: [],
            droppedFiles: [],
            assistantMessages: [],
        };
        const { files, dropped } = mapFiles(turn.files, opts.seed);
        record.droppedFiles = dropped;
        if (dropped.length > 0) opts.log(`  ${dropped.length} attachment(s) not seeded; sent without them`);
        const workflow = mapWorkflow(turn.workflow, opts.seed, opts.dropUnmappedWorkflows);
        const prompt: ApiMessage = {
            role: "user",
            content: turn.content,
            ...(files.length > 0 ? { files } : {}),
            ...(workflow ? { workflow } : {}),
        };
        const common = {
            chat_id: chatId,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
            time_zone: opts.timeZone,
        };
        const framesPath = (n: number) => path.join(opts.outDir, `turn-${pad(turn.index)}.${n}.frames.ndjson`);

        const history = historyMessages((await this.detail(chatId)).messages);
        let attempt = await this.stream("prompt", { ...common, messages: [...history, prompt] }, framesPath(0), chatId);
        record.attempts.push(attempt);
        const userMessageId = attempt.userMessageId;

        const failed = (a: StreamOutcome) => !a.done || a.errors.length > 0 || (a.httpStatus ?? 0) >= 400;
        if (failed(attempt) && opts.retry) {
            opts.log(`  turn ${turn.index} failed (${attempt.errors.join("; ")}); retrying once`);
            if (userMessageId) {
                // Regenerate: move this reader's leaf back onto the prompt and
                // answer it again, as the web app's regenerate control does.
                const leaf = await this.client.json<{ path: ChatRow[] }>("POST", `/chat/${chatId}/leaf`, {
                    leaf_message_id: userMessageId,
                });
                attempt = await this.stream(
                    "retry",
                    { ...common, messages: historyMessages(leaf.path), link_only_to_message_id: userMessageId },
                    framesPath(record.attempts.length),
                    chatId,
                );
            } else {
                const again = historyMessages((await this.detail(chatId)).messages);
                attempt = await this.stream("retry", { ...common, messages: [...again, prompt] }, framesPath(record.attempts.length), chatId);
            }
            record.attempts.push(attempt);
        }

        // Answer ask_inputs pauses with the original answers, by position.
        const seededNames = new Set(Object.values(opts.seed?.documents ?? {}).map((d) => d.filename));
        for (let round = 0; round < opts.maxAskRounds; round++) {
            const detail = await this.detail(chatId);
            const rows = this.turnRows(detail, userMessageId ?? attempt.userMessageId, turn.content);
            const last = rows[rows.length - 1];
            const parts = last && Array.isArray(last.content) ? last.content : [];
            const ask = pendingAsk(parts);
            if (!last || !ask) break;
            const mapped = mapAskResponse(ask.items, turn.asks[round], seededNames);
            record.asks.push({
                event: { event_id: ask.event_id, items: ask.items },
                assistantMessageId: last.id,
                mappedFrom: mapped.mappedFrom,
                responses: mapped.responses,
            });
            opts.log(`  ask_inputs (${ask.items.length} item(s)) answered from ${mapped.mappedFrom}`);
            const askFiles = documentFilesFor(mapped.responses, opts.seed);
            const content = askResponseContent(ask.items, mapped.responses);
            attempt = await this.stream(
                "ask_response",
                {
                    ...common,
                    messages: [
                        ...historyMessages(detail.messages),
                        { role: "user", content, ...(askFiles.length > 0 ? { files: askFiles } : {}) },
                    ],
                    ask_inputs_response: {
                        assistant_message_id: last.id,
                        ask_event_id: ask.event_id,
                        responses: mapped.responses,
                    },
                },
                framesPath(record.attempts.length),
                chatId,
            );
            record.attempts.push(attempt);
        }

        const finalRows = this.turnRows(await this.detail(chatId), userMessageId ?? attempt.userMessageId, turn.content);
        record.assistantMessages = finalRows
            .filter((r) => r.role === "assistant")
            .map((r) => ({ id: r.id, content: Array.isArray(r.content) ? r.content : [] }));
        if (opts.downloadDocs) await this.downloadDocs(turn.index, finalRows);
        const last = record.attempts[record.attempts.length - 1]!;
        record.status = failed(last as StreamOutcome) ? "failed" : "ok";
        record.endedAt = nowIso();
        record.wallMs = Date.now() - started;
        return record;
    }
}

function documentFilesFor(responses: readonly AskInputResponseItem[], seed: SeedMap | null): MessageFileRef[] {
    const byName = new Map(Object.values(seed?.documents ?? {}).map((d) => [d.filename, d]));
    return responses.flatMap((r) =>
        r.kind === "documents" && !r.skipped ? r.filenames.flatMap((f) => (byName.has(f) ? [byName.get(f)!] : [])) : [],
    );
}

export async function runReplay(client: MikeClient, opts: RunOptions): Promise<RunState> {
    mkdirSync(opts.outDir, { recursive: true });
    const previous = loadState(opts.outDir);
    const state: RunState = previous ?? {
        format: "mike-replay-state/1",
        chatId: null,
        model: opts.model,
        reasoning: opts.reasoning,
        nextTurn: 1,
        completed: [],
        failed: [],
        updatedAt: nowIso(),
    };
    if (previous && (previous.model !== opts.model || previous.reasoning !== opts.reasoning)) {
        throw new Error(
            `state.json in ${opts.outDir} was run with model ${previous.model}/${previous.reasoning}; use a new --out for a different model`,
        );
    }
    if (opts.chatId) state.chatId = opts.chatId;

    if (opts.autocompact !== null) {
        try {
            await client.json("PUT", "/user/autocompact", { model: opts.model, tokens: opts.autocompact });
            opts.log(`autocompact set to ${opts.autocompact} tokens for ${opts.model ?? "the default model"}`);
        } catch (error) {
            if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
                opts.log("autocompact endpoint not available on this deployment (404); continuing without it");
            } else throw error;
        }
    }

    if (!state.chatId) {
        const created = await client.json<{ id: string }>("POST", "/chat/create", {});
        state.chatId = created.id;
        opts.log(`created chat ${state.chatId}`);
    }
    saveState(opts.outDir, state);
    writeFileSync(
        path.join(opts.outDir, "run.json"),
        `${JSON.stringify(
            {
                format: "mike-replay-run/1",
                thread: opts.thread.source,
                leafId: opts.thread.leafId,
                t0: opts.thread.t0,
                chatId: state.chatId,
                model: opts.model,
                reasoning: opts.reasoning,
                timeZone: opts.timeZone,
                autocompact: opts.autocompact,
                apiBase: client.apiBase,
                updatedAt: nowIso(),
            },
            null,
            2,
        )}\n`,
    );

    const runner = new Runner(client, opts);
    const from = opts.from ?? state.nextTurn;
    const until = opts.until ?? opts.thread.turns.length;
    const turns = opts.thread.turns.filter((t) => t.index >= from && t.index <= until);
    for (const [i, turn] of turns.entries()) {
        opts.log(`turn ${turn.index}/${opts.thread.turns.length}: ${turn.content.slice(0, 80).replace(/\s+/g, " ")}`);
        let record: ReplayTurnRecord;
        try {
            record = await runner.runTurn(turn, state.chatId);
        } catch (error) {
            // A failure outside the stream (login expired, network) stops the
            // run where it is; the state file resumes from this turn.
            saveState(opts.outDir, state);
            throw error;
        }
        writeFileSync(path.join(opts.outDir, `turn-${pad(turn.index)}.json`), `${JSON.stringify(record, null, 2)}\n`);
        state.completed = [...new Set([...state.completed, turn.index])].sort((a, b) => a - b);
        state.failed = state.failed.filter((n) => n !== turn.index);
        if (record.status === "failed") state.failed.push(turn.index);
        state.nextTurn = turn.index + 1;
        saveState(opts.outDir, state);
        opts.log(`  ${record.status} in ${(record.wallMs / 1000).toFixed(1)} s`);
        if (opts.delayMs > 0 && i < turns.length - 1) await (opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(opts.delayMs);
    }
    return state;
}
