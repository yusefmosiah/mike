#!/usr/bin/env node
/**
 * Thread replay simulator. See README.md in this directory.
 *
 *   node scripts/replay/cli.mts extract --messages msgs.json --out thread.json [--leaf <id>] [--entries entries.json --convs convs.json]
 *   node scripts/replay/cli.mts seed    --thread thread.json --out seed.json [--attachments-dir dir] [--owner] [--memory-file f]
 *   node scripts/replay/cli.mts run     --thread thread.json --out replay/ [--seed seed.json] [--model m] [--reasoning r] ...
 *   node scripts/replay/cli.mts report  --thread thread.json --replay replay/ --out report/ [--replay-entries e.json] [--original-tree a.txt --replay-tree b.txt]
 *   node scripts/replay/cli.mts plan-baseline --current cur.txt --snapshot snap.txt --t0 <iso> [--exclude-chat id]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MikeClient } from "./client.mts";
import { extractThread } from "./extract.mts";
import { diffTrees, parseListing, planBaseline } from "./files.mts";
import {
    callMetricsByWindow,
    chatConversationIds,
    duplicateSections,
    normalizeEntries,
    parseConversationIds,
    subagentConversationIds,
    type DurableEntry,
} from "./metrics.mts";
import { buildReport, renderMarkdown, type Report } from "./report.mts";
import { runReplay } from "./runner.mts";
import { seedSimulation } from "./seed.mts";
import type { ChatMessageRow, ExtractedThread, ReplayTurnRecord, RunState, SeedMap } from "./types.mts";

const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const log = (message: string) => process.stderr.write(`${message}\n`);

/**
 * Entries narrowed to one chat (when --conversations names its lineage) and
 * the subagent conversations among them.
 */
function loadEntries(
    entriesFile: string,
    convsFile: string | undefined,
    conversations: string | undefined,
): { entries: DurableEntry[]; subagents: Set<number> } {
    let entries = normalizeEntries(readJson<unknown[]>(entriesFile));
    const convs = convsFile ? readJson<unknown[]>(convsFile) : [];
    if (conversations) {
        const ids = chatConversationIds(parseConversationIds(conversations, (f) => readFileSync(f, "utf8")), convs);
        entries = entries.filter((e) => ids.has(e.conversationId));
    } else {
        const spread = new Set(entries.map((e) => e.conversationId)).size;
        if (spread > 1) log(`note: ${spread} conversations in the entries export; pass --conversations <chat lineage> if it spans more than this chat`);
    }
    return { entries, subagents: subagentConversationIds(convs) };
}

function fail(message: string): never {
    log(`replay: ${message}`);
    process.exit(2);
}

function need(value: string | undefined, flag: string): string {
    if (!value) fail(`${flag} is required`);
    return value;
}

function intOption(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) fail(`${flag} must be a non-negative integer`);
    return n;
}

/**
 * A logged-in client from MIKE_URL and <PREFIX>_EMAIL/_PASSWORD, <PREFIX>_TOKEN, or
 * <PREFIX>_TOKEN_FILE (read before each request, so a long replay outlives one
 * token). Never prints them.
 */
async function clientFromEnv(prefix: "MIKE_SIM" | "MIKE_OWNER"): Promise<MikeClient> {
    const origin = process.env.MIKE_URL;
    if (!origin) fail("set MIKE_URL to the web app's origin, e.g. https://mike.example.com");
    const tokenFile = process.env[`${prefix}_TOKEN_FILE`];
    const token = tokenFile ? () => readFileSync(tokenFile, "utf8").trim() : process.env[`${prefix}_TOKEN`];
    const client = new MikeClient({
        origin,
        apiBase: process.env.MIKE_API_BASE || undefined,
        bearerToken: token || undefined,
        storageBase: process.env.MIKE_STORAGE_BASE || undefined,
    });
    if (!token) {
        const email = process.env[`${prefix}_EMAIL`];
        const password = process.env[`${prefix}_PASSWORD`];
        if (!email || !password) fail(`set ${prefix}_EMAIL and ${prefix}_PASSWORD (or ${prefix}_TOKEN)`);
        const user = await client.login(email, password);
        log(`logged in as ${prefix === "MIKE_SIM" ? "the simulation account" : "the owner"} (${user.id})`);
    }
    return client;
}

async function extractCommand(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            messages: { type: "string" },
            leaf: { type: "string" },
            entries: { type: "string" },
            convs: { type: "string" },
            conversations: { type: "string" },
            model: { type: "string" },
            out: { type: "string" },
        },
    });
    const file = need(values.messages, "--messages");
    const rows = readJson<ChatMessageRow[]>(file);
    if (!Array.isArray(rows)) fail("--messages must be a JSON array of chat_messages rows");
    const loaded = values.entries ? loadEntries(values.entries, values.convs, values.conversations) : null;
    const thread = extractThread(rows, {
        source: path.basename(file),
        leafId: values.leaf,
        model: values.model ?? null,
        entries: loaded?.entries,
        subagentConversations: loaded?.subagents,
    });
    const out = values.out ?? "thread.json";
    writeJson(out, thread);
    const asks = thread.turns.reduce((a, t) => a + t.asks.length, 0);
    const files = thread.turns.reduce((a, t) => a + t.files.length, 0);
    log(`${thread.turns.length} prompts on the branch to ${thread.leafId} (${thread.offPathMessages} messages on other branches)`);
    log(`T0 ${thread.t0}; ${files} attachment(s); ${asks} ask_inputs pause(s); wrote ${out}`);
}

async function seedCommand(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            thread: { type: "string" },
            out: { type: "string" },
            "attachments-dir": { type: "string" },
            owner: { type: "boolean", default: false },
            "memory-file": { type: "string" },
            "no-memory": { type: "boolean", default: false },
            "workflow-map": { type: "string" },
        },
    });
    const thread = readJson<ExtractedThread>(need(values.thread, "--thread"));
    const out = values.out ?? "seed.json";
    const sim = await clientFromEnv("MIKE_SIM");
    const owner = values.owner ? await clientFromEnv("MIKE_OWNER") : undefined;
    const map = await seedSimulation(sim, {
        thread,
        attachmentsDir: values["attachments-dir"],
        owner,
        memoryFile: values["no-memory"] ? undefined : values["memory-file"],
        copyOwnerMemory: !values["no-memory"],
        workflowMap: values["workflow-map"] ? readJson(values["workflow-map"]) : undefined,
        existing: existsSync(out) ? readJson<SeedMap>(out) : null,
        log,
    });
    writeJson(out, map);
    log(`wrote ${out}`);
}

async function runCommand(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            thread: { type: "string" },
            seed: { type: "string" },
            out: { type: "string" },
            model: { type: "string" },
            reasoning: { type: "string" },
            from: { type: "string" },
            until: { type: "string" },
            "delay-ms": { type: "string" },
            retry: { type: "boolean", default: false },
            "max-ask-rounds": { type: "string" },
            "time-zone": { type: "string" },
            autocompact: { type: "string" },
            "chat-id": { type: "string" },
            "drop-unmapped-workflows": { type: "boolean", default: false },
            "no-download-docs": { type: "boolean", default: false },
            "turn-timeout-ms": { type: "string" },
        },
    });
    const thread = readJson<ExtractedThread>(need(values.thread, "--thread"));
    const outDir = need(values.out, "--out");
    const levels = ["none", "low", "medium", "high", "xhigh", "max"];
    if (values.reasoning && !levels.includes(values.reasoning)) fail(`--reasoning must be one of ${levels.join(", ")}`);
    const client = await clientFromEnv("MIKE_SIM");
    const state = await runReplay(client, {
        thread,
        seed: values.seed ? readJson<SeedMap>(values.seed) : null,
        outDir,
        model: values.model ?? null,
        reasoning: values.reasoning ?? null,
        from: intOption(values.from, "--from"),
        until: intOption(values.until, "--until"),
        delayMs: intOption(values["delay-ms"], "--delay-ms") ?? 0,
        retry: values.retry ?? false,
        maxAskRounds: intOption(values["max-ask-rounds"], "--max-ask-rounds") ?? 5,
        timeZone: values["time-zone"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        autocompact: intOption(values.autocompact, "--autocompact") ?? null,
        chatId: values["chat-id"],
        dropUnmappedWorkflows: values["drop-unmapped-workflows"] ?? false,
        downloadDocs: !values["no-download-docs"],
        turnTimeoutMs: intOption(values["turn-timeout-ms"], "--turn-timeout-ms") ?? 60 * 60_000,
        log,
    });
    log(`done: ${state.completed.length} turn(s) run, ${state.failed.length} failed; chat ${state.chatId}`);
}

function readReplayDir(dir: string): { records: ReplayTurnRecord[]; state: RunState | null } {
    const records = readdirSync(dir)
        .filter((f) => /^turn-\d+\.json$/.test(f))
        .sort()
        .map((f) => readJson<ReplayTurnRecord>(path.join(dir, f)));
    const stateFile = path.join(dir, "state.json");
    return { records, state: existsSync(stateFile) ? readJson<RunState>(stateFile) : null };
}

function documentChecks(dir: string | undefined, side: "original" | "replay"): Report["documents"] {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => /\.(md|markdown|txt)$/i.test(f))
        .flatMap((f) => {
            const d = duplicateSections(readFileSync(path.join(dir, f), "utf8"));
            return d.headings.length + d.paragraphs.length > 0 ? [{ side, file: f, ...d }] : [];
        });
}

async function reportCommand(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            thread: { type: "string" },
            replay: { type: "string" },
            out: { type: "string" },
            "replay-entries": { type: "string" },
            "replay-convs": { type: "string" },
            "replay-conversations": { type: "string" },
            "original-tree": { type: "string" },
            "replay-tree": { type: "string" },
            "exclude-chat": { type: "string", multiple: true },
            "original-docs": { type: "string" },
            "tree-limit": { type: "string" },
        },
    });
    const thread = readJson<ExtractedThread>(need(values.thread, "--thread"));
    const replayDir = need(values.replay, "--replay");
    const outDir = values.out ?? replayDir;
    const { records, state } = readReplayDir(replayDir);
    let replayCalls: ReturnType<typeof callMetricsByWindow>["metrics"] | undefined;
    if (values["replay-entries"]) {
        const windows = records.map((r) => ({ start: Date.parse(r.startedAt), end: Date.parse(r.endedAt) + 1 }));
        const loaded = loadEntries(values["replay-entries"], values["replay-convs"], values["replay-conversations"]);
        replayCalls = callMetricsByWindow(loaded.entries, windows, loaded.subagents).metrics;
    }
    const tree =
        values["original-tree"] && values["replay-tree"]
            ? diffTrees(
                  parseListing(readFileSync(values["original-tree"], "utf8")),
                  parseListing(readFileSync(values["replay-tree"], "utf8")),
                  { allKernels: true, excludeChats: values["exclude-chat"] },
              )
            : null;
    const report = buildReport({
        thread,
        replay: records,
        replayCalls,
        run: { chatId: state?.chatId ?? null, model: state?.model ?? null, reasoning: state?.reasoning ?? null },
        tree,
        documents: [
            ...documentChecks(values["original-docs"], "original"),
            ...documentChecks(path.join(replayDir, "docs"), "replay"),
        ],
    });
    mkdirSync(outDir, { recursive: true });
    writeJson(path.join(outDir, "report.json"), report);
    writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report, { treeLimit: intOption(values["tree-limit"], "--tree-limit") }));
    log(`wrote ${path.join(outDir, "report.md")} and report.json: ${report.findings.length} finding(s)`);
}

async function planBaselineCommand(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            current: { type: "string" },
            snapshot: { type: "string" },
            t0: { type: "string" },
            "exclude-chat": { type: "string", multiple: true },
            "all-kernels": { type: "boolean", default: false },
        },
    });
    const t0 = Date.parse(need(values.t0, "--t0"));
    if (!Number.isFinite(t0)) fail("--t0 must be an ISO-8601 time");
    const plan = planBaseline(
        parseListing(readFileSync(need(values.current, "--current"), "utf8")),
        values.snapshot ? parseListing(readFileSync(values.snapshot, "utf8")) : null,
        t0 / 1000,
        { excludeChats: values["exclude-chat"], allKernels: values["all-kernels"] },
    );
    for (const c of plan.include) process.stdout.write(`${c.source}\t${c.size}\t${c.path}\n`);
    log(`include ${plan.include.length} (${plan.include.filter((c) => c.source === "snapshot").length} from snapshot), absent ${plan.absent.length}, excluded ${plan.excluded.length}`);
}

const commands: Record<string, (argv: string[]) => Promise<void>> = {
    extract: extractCommand,
    seed: seedCommand,
    run: runCommand,
    report: reportCommand,
    "plan-baseline": planBaselineCommand,
};

const [command, ...rest] = process.argv.slice(2);
const handler = command ? commands[command] : undefined;
if (!handler) {
    log(`usage: node scripts/replay/cli.mts <${Object.keys(commands).join("|")}> [options]; see scripts/replay/README.md`);
    process.exit(command ? 2 : 0);
}
handler(rest).catch((error: unknown) => {
    log(`replay ${command}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
