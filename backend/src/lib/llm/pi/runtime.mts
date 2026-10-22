// Mike's model loop, on Pi Durable and pi-ai.
//
// One Harness per process over the Postgres adapter, in its own schema of
// Mike's database. Each Mike chat maps to a lineage of Pi conversations, keyed
// by stored message ids: a turn continues its parent answer's conversation, and
// a second prompt version or a regenerated answer forks at the parent. Chats
// begun before this runtime fall back to matching history text. A turn submits
// only the new input; Pi's transcript, with every tool call and result, is what
// the model sees. Calls without a chat (memory curator, extraction) run on a
// throwaway in-memory Harness.
//
// Every Mike model id resolves through ./providers.mts to pi-ai. This sits
// behind `streamChatWithTools`; everything above it (prompt building,
// guardrails, client tools, the dispatcher, citations, persistence of
// chat_messages) is Mike's. Tools execute through the live request's
// `runTools`. A chat turn records how to drive it again, so after a restart
// its run resumes into a new request; reads replay, writes are answered as
// interrupted. Pi's own retry is off: a generation that stops partway (an
// error, the output limit, a restart) is asked for again when nothing was
// shown, or continued from the text already shown when something was
// (continuation.mts), so an answer that has started is never started over.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, Message, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { isParallelSafeTool, tierForTool } from "../../guardrails/policy.js";
import { databaseUrl } from "../../runtimeConfig.js";
import { safeError } from "../../safeError.js";
import { getConfiguredModel, tolerateTextToolCalls } from "../registry.js";
import {
  createMikeModels,
  lightestThinkingLevel,
  providerError,
  SIDE_SESSION_MARK,
  tolerantMessage,
  useRequestKeys,
  type MikeModels,
} from "./providers.mjs";
import {
  AgentDoc,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
  ProviderDoc,
  UsageDoc,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type SettledSubmissionRecord,
  type Storage,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  isBrokenStop,
  isRecoverableFailure,
  JOIN_HOLD_CHARS,
  MAX_ATTEMPTS,
  noteFor,
  OVERLAP_WINDOW_CHARS,
  recoveryDelayMs,
  trimOverlap,
  type Interruption,
} from "./continuation.mjs";
import { answerLanguageDrift, LANGUAGE_DRIFT_NOTE } from "./languageGuard.mjs";
import { COMPACTION_SETTINGS, compactionExtension, setAutocompactThreshold } from "./compactionHooks.mjs";
import { PostgresStorage } from "./postgres/storage.mjs";
import { nodePostgresDatabase } from "./postgres/node.mjs";
import pg from "pg";
import { escapeTurnContextMarkup, planTurnContext, replayTurnContext, withoutTurnContext } from "../turnContext.js";
import type {
  LlmMessage,
  LlmUserContent,
  NormalizedToolCall,
  OpenAIToolSchema,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  SubagentEnvelope,
  SubagentHost,
  SubagentOutcome,
  SubagentTranscript,
  TurnIdentity,
  UserApiKeys,
} from "../types.js";

const SCHEMA = process.env.PI_DURABLE_SCHEMA ?? "pi_durable";

/** Where a stored Mike message lives in Pi: its conversation and entry. */
type MessagePlace = { conversation: number; entry: number };

/**
 * A Mike chat's Pi lineage: the conversations holding its branches, oldest
 * first, and where each stored Mike message (user prompt or answer) landed.
 */
type LineageState = { conversations: number[]; messages: Record<string, MessagePlace> };

const ChatLineage = defineDocFamily<LineageState, null>({
  kind: "mike.chat",
  version: 2,
  scope: "session",
  // Changes stay deltas (Pi's behaviour before 1.4 made the policy required);
  // the same on every document here.
  checkpointWhen: () => false,
  family: true,
  initial: () => ({ conversations: [], messages: {} }),
  migrate: (value) => ({
    conversations: (value.conversations as number[] | undefined) ?? [],
    messages: {},
  }),
});

/**
 * Every Mike tool schema the runtime has offered, by name. The tool registry
 * lives in memory, so after a restart it is rebuilt from here before Pi resumes
 * the tool calls a crash interrupted.
 */
/** A tool schema as stored: the same JSON, typed for the document store. */
type StoredToolSchema = JsonValue & { type: "function"; function: { name: string } };

const ToolSchemas = defineDoc<Record<string, StoredToolSchema>>({
  kind: "mike.tools",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({}),
});

/**
 * A chat turn in flight, by its reserved answer id: where it runs, the first
 * entry it can write, and the caller's opaque context for driving it again. A
 * turn that ends in this process removes its record; one that outlives the
 * process (a crash, a deploy) is still here when the next process starts.
 */
export type DurableTurnRecord = {
  conversation: number;
  chatKey: string;
  firstEntry: number;
  context: JsonValue;
  startedAt: number;
  /** The conversation's spend when the turn began; absent on records from before it was kept. */
  usageAtStart?: TurnUsage;
};

type TurnUsage = { input: number; output: number; cost: number };

const DurableTurns = defineDoc<Record<string, DurableTurnRecord>>({
  kind: "mike.turns",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({}),
});

/** How long a resumed tool call waits for its turn to be driven again before it gives up. */
const RESUME_BINDING_WAIT_MS = 120_000;

type TurnBinding = {
  runTools: NonNullable<StreamChatParams["runTools"]>;
  onToolCallStart?: (call: NormalizedToolCall) => void;
  /** Tool rounds the turn may run; past it, tools answer "finish now". */
  maxRounds: number;
  /** The first entry this turn can write; rounds are counted from here. */
  firstEntry: EntryId;
  /**
   * End the turn with this error: a failing runTools (the ask_inputs pause
   * among them) stops the run before another model request, and the turn
   * rejects with the error, as Mike's dispatcher expects.
   */
  halt: (error: unknown) => void;
  /** Output tokens the conversation may spend; past it, tools answer "report now". A subagent's budget. */
  maxOutputTokens?: number;
  /** A parent turn's delegation, when its code may start subagents. A child never has one. */
  subagents?: {
    host: SubagentHost;
    /** Where the turn's children are recorded and addressed. */
    chatKey: string;
    turnKey: string | null;
    /** Children counted against the per-turn cap, including ones being prepared. */
    started: number;
    /** The last child number given out; addresses use it. */
    ordinal: number;
    /** Children running, or being prepared, in this process. */
    running: number;
  };
};

/**
 * Live requests by conversation. A tool task finds its request's runTools here;
 * after a restart a resumed call waits for the turn's new request to bind.
 */
class Bindings {
  private readonly live = new Map<number, TurnBinding>();
  private readonly waiting = new Map<number, Array<(binding: TurnBinding) => void>>();
  /** Conversations with a turn from a previous process that may still be driven again. */
  readonly resumable = new Set<number>();

  get(conversation: number): TurnBinding | undefined {
    return this.live.get(conversation);
  }

  set(conversation: number, binding: TurnBinding): void {
    this.live.set(conversation, binding);
    const waiters = this.waiting.get(conversation) ?? [];
    this.waiting.delete(conversation);
    for (const resolve of waiters) resolve(binding);
  }

  delete(conversation: number): void {
    this.live.delete(conversation);
    this.resumable.delete(conversation);
  }

  /** The live binding, or, for a turn awaiting resumption, the one it gets within the wait. */
  async wait(conversation: number, signal: AbortSignal | undefined): Promise<TurnBinding | undefined> {
    const live = this.live.get(conversation);
    if (live || !this.resumable.has(conversation)) return live;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), RESUME_BINDING_WAIT_MS);
      const done = (binding: TurnBinding | undefined) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(binding);
      };
      const onAbort = () => done(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      const list = this.waiting.get(conversation) ?? [];
      list.push(done);
      this.waiting.set(conversation, list);
    });
  }
}

type Runtime = {
  harness: Harness;
  installTools: (schemas: readonly OpenAIToolSchema[]) => void;
  /** Install the delegate tool with this description (global: the same for every user). */
  resolve: MikeModels["resolve"];
  bindings: Bindings;
  /**
   * Conversations whose answer a restart cut off while it was writing text,
   * with their generation stopped before it could start the message over:
   * their turn continues it (see `stopCutOffAnswers`).
   */
  cutOff: Set<number>;
};

/**
 * Mike's default tool-round budget for a turn: a backstop against a runaway
 * loop, not a working limit. A long task should finish, not be cut off.
 */
const DEFAULT_MAX_ROUNDS = 1_000;

let opening: Promise<Runtime> | undefined;
/** The Harness `opening` resolved to, so a report from an older one changes nothing. */
let live: Harness | undefined;

/** What a test substitutes for the deployment's storage and model catalog. */
export type RuntimeOverrides = { storage?: Storage; models?: MikeModels };
let overrides: RuntimeOverrides | undefined;

export function piRuntime(): Promise<Runtime> {
  opening ??= openRuntime().catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/** Tests: close the open runtime and open the next one with these overrides. */
export async function resetPiRuntime(next?: RuntimeOverrides): Promise<void> {
  const current = opening;
  opening = undefined;
  live = undefined;
  overrides = next;
  catalog = undefined;
  if (current) await (await current.catch(() => undefined))?.harness.close(background);
}

async function openStorage(): Promise<Storage> {
  if (overrides?.storage) return overrides.storage;
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  } finally {
    await admin.end();
  }
  return PostgresStorage.open(
    nodePostgresDatabase(new pg.Pool({ connectionString, options: `-c search_path=${SCHEMA}`, max: 1 })),
  );
}

/** One model catalog per process, shared by the durable Harness and one-shot runs. */
let catalog: MikeModels | undefined;
function openModels(): MikeModels {
  return (catalog ??= overrides?.models ?? createMikeModels());
}

/**
 * Whether the model a turn would run can take image parts: the catalog entry
 * the turn itself uses, so the answer and the turn never disagree. A model the
 * catalog cannot resolve cannot see.
 */
export function modelSeesImagesOnPi(mikeModel: string): boolean {
  try {
    const models = openModels();
    const ref = models.resolve(mikeModel);
    return models.models.getModel(ref.provider, ref.modelId)?.input.includes("image") ?? false;
  } catch {
    return false;
  }
}

async function openRuntime(storage?: Storage): Promise<Runtime> {
  storage ??= await openStorage();
  const catalog = openModels();
  const bindings = new Bindings();
  let persistTools: (schemas: OpenAIToolSchema[]) => void = () => undefined;

  const registry = createRegistry();
  const tools = new Map<string, ToolRegistration>();
  const installTools = (schemas: readonly OpenAIToolSchema[]) => {
    let changed = false;
    for (const schema of schemas) {
      const name = schema.function.name;
      const existing = tools.get(name);
      if (existing && JSON.stringify(existing.parameters) === JSON.stringify(schema.function.parameters)) continue;
      tools.set(name, mikeTool(schema, bindings, catalog.resolve));
      changed = true;
    }
    if (changed) {
      registry.install(defineExtension({ name: "mike-tools", tools: [...tools.values()] }));
      persistTools([...schemas]);
    }
  };
  registry.install(defineExtension({ name: "mike-tools", tools: [] }));

  // Every declared model is in the catalog before the Harness opens: a turn or
  // compaction the last process left running resumes with its model at once,
  // instead of failing `no_model` because nothing has resolved it yet.
  try {
    catalog.registerConfigured();
  } catch (error) {
    console.error("[pi] failed to register the configured models", safeError(error));
  }

  let opened: Harness | undefined;
  registry.install(compactionExtension(() => opened));

  const harness = await Harness.open(
    storage,
    {
      models: catalog.models,
      registry,
      settings: {
        // Mike writes the summary (compactionHooks.mts) and usually compacts at
        // the owner's auto-compact threshold, well before these.
        compaction: COMPACTION_SETTINGS,
        // A failed generation reaches `runTurn`, which retries it or continues
        // the answer from the text already shown (continuation.mts). Pi's own
        // retry would regenerate the whole message after the reader has
        // seen part of it.
        retry: { enabled: false },
        // Lookups in one round run at once; a tool that changes something
        // declares `executionMode: "sequential"` (see mikeTool), which runs
        // its whole round in call order.
        toolExecution: "parallel",
        progress: { partialIntervalMs: 100, outputIntervalMs: 250 },
      },
      // Since Pi 1.2 any Storage error (a dropped Postgres connection) closes
      // the Session for good; the next turn opens the runtime again.
      onReport: (error, info) => {
        console.error(`[pi] ${info.type}`, safeError(error));
        if (info.type === "session_failed" && opened !== undefined && live === opened) {
          live = undefined;
          opening = undefined;
        }
      },
    },
    background,
  );
  opened = harness;
  live = harness;
  // Rebuild what the previous process offered before resuming its work: the
  // tools a resumed call needs, and the turns that may be driven again.
  installTools(
    Object.values((await harness.snapshot(ToolSchemas, background)) ?? {}) as unknown as OpenAIToolSchema[],
  );
  const turnConversations: number[] = [];
  for (const record of Object.values((await harness.snapshot(DurableTurns, background)) ?? {})) {
    bindings.resumable.add(record.conversation);
    turnConversations.push(record.conversation);
    // A resumed parent runs its delegate call again, which finds its child
    // and binds it; until then the child's own tool calls wait like the parent's.
    const children = await harness.snapshot(SubagentChildren, String(record.conversation), background);
    for (const child of children?.children ?? []) bindings.resumable.add(child);
  }
  persistTools = (schemas) => {
    void harness
      .commit(async (tx) => {
        const known = await tx.doc(ToolSchemas);
        // Mike's schemas are built in code and may hold `undefined` fields;
        // the stored copy must be plain JSON.
        for (const schema of schemas) {
          known[schema.function.name] = JSON.parse(JSON.stringify(schema)) as StoredToolSchema;
        }
      }, background)
      .catch((error: unknown) => console.error("[pi] failed to persist tool schemas", error));
  };
  // Work no recorded turn will drive again (a local Word chat's turn, or one
  // started without a durable context) would otherwise run on for no one.
  const orphans = new Set(
    (await harness.inspect(background)).tasks
      .map((task) => task.record.conversationId as number)
      .filter((conversation) => !bindings.resumable.has(conversation)),
  );
  const cutOff = await stopCutOffAnswers(harness, turnConversations);
  harness.resume();
  for (const id of orphans) {
    void harness
      .conversation(id as ConversationId, background)
      .then((conversation) => conversation?.abort(background))
      .catch((error: unknown) => console.error("[pi] failed to stop an orphaned run", error));
  }
  return { harness, installTools, resolve: catalog.resolve, bindings, cutOff };
}

/** The text of an assistant message, or of a stored partial of one. */
function textOfMessage(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/**
 * A restart can cut a message off while it is writing text the reader has
 * already seen (progress is committed every 100 ms). Left alone, Pi writes the
 * message again from its start on resuming. Stop that generation before the
 * scheduler resumes: Pi keeps the text it had as an aborted message, the run
 * settles `aborted`, and the turn's driver continues the answer from it. Only
 * a generation that is writing text, not running tools, is stopped.
 */
async function stopCutOffAnswers(harness: Harness, conversations: readonly number[]): Promise<Set<number>> {
  const stopped = new Set<number>();
  if (!conversations.length) return stopped;
  try {
    const generations = (await harness.inspect(background)).tasks.filter((task) => task.record.kind === "pi.generation");
    for (const conversation of new Set(conversations)) {
      const task = generations.find((candidate) => candidate.record.conversationId === conversation);
      if (!task) continue;
      const live = await harness.snapshot(LiveDoc, conversation as ConversationId, background);
      if (live?.tools?.length || !textOfMessage(live?.generation?.message as never).trim()) continue;
      await harness.abortTask(task.record.id, background);
      stopped.add(conversation);
    }
  } catch (error) {
    console.error("[pi] failed to stop cut-off answers", safeError(error));
  }
  return stopped;
}

/** Wait `ms`, or less if `signal` aborts. */
function pauseFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Settle with `work`, or reject as soon as the call is aborted (a stop, or the run ending). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error("The tool call was stopped."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("The tool call was stopped."));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Tool rounds a conversation has started since `first`: its assistant entries that call tools. */
async function roundsSince(api: { commit: Conversation["commit"]; conversationId: ConversationId }, first: EntryId) {
  return api.commit(async (tx) => {
    let rounds = 0;
    let cursor: Parameters<Tx["scanEntries"]>[2];
    do {
      const page = await tx.scanEntries({ conversationId: api.conversationId, minEntryId: first, order: "ascending" }, 200, cursor);
      for (const entry of page.items) {
        const message = entry.kind === "pi.assistant" ? entry.model?.[0] : undefined;
        if (message?.role === "assistant" && message.content.some((block) => block.type === "toolCall")) rounds += 1;
      }
      cursor = page.next;
    } while (cursor);
    return rounds;
  }, background);
}

/** A Mike tool: its schema as declared, executed by the live request that offered it. */
function mikeTool(schema: OpenAIToolSchema, bindings: Bindings, resolve: MikeModels["resolve"]): ToolRegistration {
  const name = schema.function.name;
  return defineTool({
    name,
    description: schema.function.description,
    parameters: schema.function.parameters as never,
    // A read can run again after a crash; anything with effects is answered
    // as interrupted instead, so a write never happens twice unseen.
    replay: tierForTool(name) === 1 ? "safe" : "unsafe",
    // Writes, connector calls and client tools act on shared state whose
    // order the model chose; one of them in a round makes the round sequential.
    executionMode: isParallelSafeTool(name) ? "parallel" : "sequential",
    execute: async (args, api, context) => {
      const binding = await bindings.wait(api.conversationId, context.abortSignal);
      if (!binding) throw new Error("The request that asked for this tool has ended; it did not run.");
      if ((await roundsSince(api, binding.firstEntry)) > binding.maxRounds) {
        return {
          output: [{ type: "text", text: `Not run: this turn has used its ${binding.maxRounds} tool rounds. Answer now with what you have, and say what is left undone.` }],
          isError: true,
        };
      }
      if (binding.maxOutputTokens !== undefined && (await usageOf(api, api.conversationId)).output >= binding.maxOutputTokens) {
        return {
          output: [{ type: "text", text: `Not run: you have used your ${binding.maxOutputTokens} output tokens. Report now with what you have, and say what is left undone.` }],
          isError: true,
        };
      }
      // Code a parent turn runs may start subagents: each one is a child of
      // this call, numbered within it.
      let delegated = 0;
      const subagents = binding.subagents;
      const call: NormalizedToolCall = {
        id: api.callId,
        name,
        input: args as Record<string, unknown>,
        ...(subagents
          ? {
              delegate: (input: Record<string, unknown>) =>
                delegateFrom({ api, context, bindings, delegation: subagents, resolve, input, callId: `${api.callId}.d${++delegated}` }),
            }
          : {}),
      };
      binding.onToolCallStart?.(call);
      let result;
      try {
        [result] = await untilAborted(binding.runTools([call]), context.abortSignal);
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        binding.halt(error);
        return { output: [{ type: "text", text: "The turn ended here." }], isError: true, control: { terminate: true } };
      }
      return { output: [{ type: "text", text: result?.content ?? "" }] };
    },
  });
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------
//
// Code calling `tools.delegate` starts a child conversation owned by the
// calling tool's task (Pi Durable's subagent pattern: aborting the call
// aborts the child, and the parent is idle only once the child is). The
// parent turn's host (Mike's module side) checks the request and supplies the
// child's model, instructions, read-only tools and budgets; the child runs on
// its own binding, so its tool calls reach only its own runner. A child
// cannot delegate (depth 1).

/** Children one parent turn may start. */
export const MAX_SUBAGENTS_PER_TURN = 8;
/** Children one parent turn may have running at once. */
export const MAX_CONCURRENT_SUBAGENTS = 4;

type SubagentRecord = {
  /** 0 until the record is written: a doc family has no "absent". */
  parentConversation: number;
  chatKey: string;
  turnKey: string | null;
  callId: string;
  /** turn/<assistantMessageId>/<type>-<n> */
  address: string;
  type: string;
  model: string;
  status: SubagentOutcome["status"] | "running";
  startedAt: number;
  finishedAt: number | null;
  usage: SubagentOutcome["usage"] | null;
  envelopes: SubagentEnvelope[];
};

const Subagents = defineDocFamily<SubagentRecord, null>({
  kind: "mike.subagent",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: () => ({
    parentConversation: 0,
    chatKey: "",
    turnKey: null,
    callId: "",
    address: "",
    type: "",
    model: "",
    status: "running",
    startedAt: 0,
    finishedAt: null,
    usage: null,
    envelopes: [],
  }),
});

/** The children each parent conversation started, for recovery after a restart. */
const SubagentChildren = defineDocFamily<{ children: number[] }, null>({
  kind: "mike.subagent-children",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: () => ({ children: [] }),
});

/** Tokens and cost a conversation has spent on model responses. */
async function usageOf(
  api: { commit: <T>(change: (tx: Tx) => T | Promise<T>, context: typeof background) => Promise<T> },
  conversationId: ConversationId,
): Promise<TurnUsage> {
  const ledger = await api.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(UsageDoc, conversationId))), background);
  const total = { input: 0, output: 0, cost: 0 };
  for (const usage of Object.values((ledger?.models ?? {}) as Record<string, { input?: number; output?: number; cost?: { total?: number } }>)) {
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}

/** The text of a conversation's last assistant entry, if any. */
async function lastAssistantText(harness: Pick<Harness, "conversation">, conversationId: ConversationId): Promise<string> {
  const conversation = await harness.conversation(conversationId, background);
  if (!conversation) return "";
  const page = await conversation.entries({ order: "descending" }, 20, undefined, background);
  for (const entry of page.items) {
    const message = entry.kind === "pi.assistant" ? entry.model?.[0] : undefined;
    if (message?.role !== "assistant") continue;
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
    if (text) return text;
  }
  return "";
}

type ToolApi = Parameters<Parameters<typeof defineTool>[0]["execute"]>[1];
type ToolContext = Parameters<Parameters<typeof defineTool>[0]["execute"]>[2];

/**
 * Start one subagent from a tool call (code calling `tools.delegate`), wait
 * for it, and return its report. The child is a conversation owned by the
 * calling tool's task, so stopping the call stops the child. A call that is
 * interrupted by a restart is answered as interrupted and never re-run, so a
 * child is never started twice.
 */
async function delegateFrom(args: {
  api: ToolApi;
  context: ToolContext;
  bindings: Bindings;
  delegation: NonNullable<TurnBinding["subagents"]>;
  resolve: MikeModels["resolve"];
  input: Record<string, unknown>;
  /** This child's id within the turn: the calling tool call's, numbered. */
  callId: string;
}): Promise<{ content: string; isError: boolean }> {
  const { api, context, bindings, delegation, resolve, input } = args;
  const refuse = (content: string) => ({ content, isError: true });
  if (delegation.started >= MAX_SUBAGENTS_PER_TURN) {
    return refuse(`Not run: this turn has already started ${MAX_SUBAGENTS_PER_TURN} subagents. Answer with what you have.`);
  }
  if (delegation.running >= MAX_CONCURRENT_SUBAGENTS) {
    return refuse(`Not run: ${MAX_CONCURRENT_SUBAGENTS} subagents are already running. Wait for their reports.`);
  }
  // Take both slots before the next await: delegate calls gathered in one
  // cell would otherwise pass the checks above together.
  delegation.started += 1;
  delegation.running += 1;
  let boundChild: ConversationId | undefined;
  let releaseKeys = () => {};
  let cleanup: (() => void) | undefined;
  try {
    const spec = await delegation.host.prepare(input);
    if (typeof spec === "string") {
      delegation.started -= 1;
      return refuse(spec);
    }
    cleanup = spec.cleanup;
    // Numbered when it is certain to start, so a refused call leaves no gap.
    const ordinal = ++delegation.ordinal;
    const ref = resolve(spec.model);

    let session = "";
    let address = "";
    const childId = await api.commit(async (tx) => {
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, created.id, {
        model: ref,
        thinkingLevel: thinkingLevel(spec.reasoning, spec.model),
        instructions: spec.instructions,
        tools: spec.tools.map((name) => ({ name }) as ToolRegistration),
      });
      session = (await tx.doc(ProviderDoc, created.id)).sessionId;
      address = `turn/${delegation.turnKey ?? "unsaved"}/${spec.type}-${ordinal}`;
      const record = await tx.doc(Subagents, String(created.id), null);
      Object.assign(record, {
        parentConversation: api.conversationId,
        chatKey: delegation.chatKey,
        turnKey: delegation.turnKey,
        callId: args.callId,
        address,
        type: spec.type,
        model: spec.model,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        usage: null,
        envelopes: [
          {
            id: randomUUID(),
            from: `turn/${delegation.turnKey ?? "unsaved"}`,
            to: address,
            kind: "task",
            correlationId: args.callId,
            body: spec.task,
            artifactRefs: [],
            at: Date.now(),
          },
        ],
      });
      (await tx.doc(SubagentChildren, String(api.conversationId), null)).children.push(created.id);
      return created.id;
    }, context);

    const child = await api.conversation(childId, context);
    if (!child) throw new Error("The subagent's conversation is missing.");
    let childHalted: unknown;
    boundChild = childId;
    bindings.set(childId, {
      runTools: spec.runTools,
      maxRounds: spec.maxRounds,
      maxOutputTokens: spec.maxOutputTokens,
      // A child's first entry: it has no history of its own.
      firstEntry: 1 as EntryId,
      halt: (error) => {
        childHalted ??= error;
        void child.abort(background).catch(() => undefined);
      },
    });
    releaseKeys = useRequestKeys(session, spec.apiKeys);
    delegation.host.started?.({
      callId: args.callId,
      childId: String(childId),
      address,
      type: spec.type,
      model: spec.model,
      task: spec.task,
    });
    let status: SubagentOutcome["status"] = "done";
    let report = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void child.abort(background).catch(() => undefined);
    }, spec.timeoutMs);
    try {
      const submission = await child.submit(
        { type: "input", content: spec.task, requestId: `subagent:${args.callId}`, whenBusy: "reject" },
        context,
      );
      let settled = await submission.wait(context);
      // Pi's own retry is off (see the Harness settings): a transient
      // failure asks the child again, as it did before.
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const failure = settled.status === "unanswered" && settled.reason === "model_error" ? settled.detail : undefined;
        if (typeof failure !== "string" || !isRecoverableFailure(failure) || timedOut || context.abortSignal?.aborted) break;
        console.warn("[pi] subagent interrupted; trying again", { attempt, of: MAX_ATTEMPTS, ...safeError(new Error(failure)) });
        await pauseFor(recoveryDelayMs(attempt - 1, failure), context.abortSignal);
        const again = await child.submit(
          { type: "input", content: noteFor({ kind: "retry", error: failure }), requestId: `subagent:${args.callId}:attempt:${attempt}`, whenBusy: "reject" },
          context,
        );
        settled = await again.wait(context);
      }
      if (settled.status === "done" && settled.type === "input") {
        const answer = await api.commit((tx) => tx.entry(settled.answer), context);
        const message = answer?.model?.[0];
        report = message?.role === "assistant"
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim()
          : "";
      } else {
        status = timedOut ? "timed_out" : context.abortSignal?.aborted ? "stopped" : "failed";
      }
    } catch (error) {
      if (context.abortSignal?.aborted && !timedOut) throw error;
      status = timedOut ? "timed_out" : "failed";
    } finally {
      clearTimeout(timer);
    }
    if (status !== "done") {
      const partial = await lastAssistantText(api as unknown as Pick<Harness, "conversation">, childId).catch(() => "");
      const why =
        status === "timed_out"
          ? `The subagent ran out of time (${Math.round(spec.timeoutMs / 1000)} s).`
          : `The subagent could not finish${childHalted instanceof Error ? `: ${childHalted.message}` : "."}`;
      report = partial ? `${why} Its last words:\n\n${partial}` : why;
    }
    const usage = await usageOf(api, childId);
    await api.commit(async (tx) => {
      const record = await tx.doc(Subagents, String(childId), null);
      record.status = status;
      record.finishedAt = Date.now();
      record.usage = usage;
      record.envelopes.push({
        id: randomUUID(),
        from: record.address,
        to: `turn/${record.turnKey ?? "unsaved"}`,
        kind: "report",
        correlationId: args.callId,
        body: report,
        artifactRefs: [],
        at: Date.now(),
      });
    }, context);
    delegation.host.finished?.({ callId: args.callId, childId: String(childId), status, report, usage });
    return {
      content: `Report from the ${spec.type} subagent (${spec.model}, ${status}):\n\n${report || "(empty report)"}`,
      isError: status !== "done",
    };
  } finally {
    delegation.running -= 1;
    releaseKeys();
    if (boundChild !== undefined) bindings.delete(boundChild);
    cleanup?.();
  }
}

const TRANSCRIPT_TOOL_RESULT_CHARS = 2_000;

/** A child's record and work, or null when no subagent has this id. */
export async function subagentTranscriptOnPi(childId: string): Promise<SubagentTranscript | null> {
  if (!/^\d+$/.test(childId)) return null;
  const { harness } = await piRuntime();
  const record = await harness.snapshot(Subagents, childId, background);
  if (!record?.parentConversation) return null;
  const conversation = await harness.conversation(Number(childId) as ConversationId, background);
  const entries: SubagentTranscript["entries"] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    if (!conversation) break;
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, background);
    for (const entry of page.items) {
      const message = entry.model?.[0];
      if (!message) continue;
      if (message.role === "user") {
        entries.push({ kind: "task", text: userText(message.content) });
      } else if (message.role === "assistant") {
        entries.push({
          kind: "assistant",
          text: message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim(),
          toolCalls: message.content.flatMap((part) => (part.type === "toolCall" ? [{ name: part.name, input: part.arguments }] : [])),
        });
      } else if (message.role === "toolResult") {
        const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        entries.push({
          kind: "tool_result",
          name: message.toolName,
          text: text.length > TRANSCRIPT_TOOL_RESULT_CHARS ? `${text.slice(0, TRANSCRIPT_TOOL_RESULT_CHARS)}…` : text,
          isError: Boolean(message.isError),
        });
      }
    }
    cursor = page.next;
  } while (cursor);
  return {
    childId,
    chatKey: record.chatKey,
    turnKey: record.turnKey,
    callId: record.callId,
    address: record.address,
    type: record.type,
    model: record.model,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    usage: record.usage,
    envelopes: record.envelopes,
    entries,
  };
}

// ---------------------------------------------------------------------------
// History: Mike messages <-> Pi entries
// ---------------------------------------------------------------------------

function userText(content: LlmUserContent | Message["content"] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

// A thread's memory is snapshotted once, into its first user message, and never
// re-sent: the prefix stays byte-stable for the provider cache and forks inherit
// it with the history. Comparisons with the client's history ignore it.
const THREAD_MEMORY_OPEN = "<thread-memory>";
const THREAD_MEMORY_CLOSE = "</thread-memory>";

function withoutThreadMemory(text: string): string {
  if (!text.startsWith(THREAD_MEMORY_OPEN)) return text;
  const end = text.indexOf(THREAD_MEMORY_CLOSE);
  return end < 0 ? text : text.slice(end + THREAD_MEMORY_CLOSE.length).trim();
}

// Mike stamps user messages with their send time when it builds a request, and
// re-derives older stamps every turn (positionally, so a branched chat can shift
// them). Pi keeps each message exactly as first sent; matching ignores stamps.
const STAMP = /^\[(?:Sent|Answered): [^\]\n]*\]\n/;

function comparable(text: string): string {
  return escapeTurnContextMarkup(withoutTurnContext(withoutThreadMemory(text)).replace(STAMP, "").trim());
}

/**
 * The turn context the model has not seen yet, in front of the user's own
 * words (lib/llm/turnContext.ts). What it has seen is read from the
 * conversation's model context, so a fork inherits it and a compaction that
 * summarised a block away makes this turn send its sections again. Markup the
 * user typed that looks like the block is neutralised first, so only the
 * runtime's own blocks count.
 */
async function withTurnContext(
  conversation: Conversation,
  content: string | (TextContent | ImageContent)[],
  sections: StreamChatParams["turnContext"],
): Promise<string | (TextContent | ImageContent)[]> {
  const escaped =
    typeof content === "string"
      ? escapeTurnContextMarkup(content)
      : content.map((part) => (part.type === "text" ? { ...part, text: escapeTurnContextMarkup(part.text) } : part));
  if (!sections?.length) return escaped;
  const view = await conversation.context(background);
  const shown = replayTurnContext(
    view.messages.filter((message) => message.role === "user").map((message) => userText(message.content)),
  );
  const block = planTurnContext(shown, sections);
  if (!block) return escaped;
  if (typeof escaped === "string") return `${block}\n\n${escaped}`;
  return [{ type: "text" as const, text: block }, ...escaped];
}

function withThreadMemory(content: string | (TextContent | ImageContent)[], memory: string) {
  const block = `${THREAD_MEMORY_OPEN}\n${memory}\n${THREAD_MEMORY_CLOSE}\n\n`;
  if (typeof content === "string") return block + content;
  return [{ type: "text" as const, text: block.trimEnd() }, ...content];
}

/**
 * Mike content as a Pi user message. An image goes in as its fallback text when
 * the turn's model cannot see images: for a rendered page that text is the page
 * itself, which pi-ai's own "(image omitted)" placeholder would lose.
 */
function piUserContent(content: LlmUserContent, vision: boolean): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return content;
  return content.map((part): TextContent | ImageContent => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (!vision || typeof part.image === "string" || part.image instanceof URL) return { type: "text", text: part.fallbackText };
    return { type: "image", data: Buffer.from(part.image).toString("base64"), mimeType: part.mimeType ?? "image/png" };
  });
}

function seedEntries(messages: readonly LlmMessage[], ref: { provider: string; modelId: string }, vision: boolean): EntryDraft[] {
  const timestamp = Date.now();
  return messages.map((message): EntryDraft =>
    message.role === "user"
      ? { kind: "pi.user", model: [{ role: "user", content: piUserContent(message.content, vision), timestamp }] }
      : {
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: message.content }],
              api: "openai-completions",
              provider: ref.provider,
              model: ref.modelId,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp,
            } as Message,
          ],
        },
  );
}

/** The id the conversation's next entry will have at least. */
async function nextEntryId(conversation: Conversation): Promise<EntryId> {
  const latest = await conversation.commit(
    async (tx) => (await tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 1)).items[0],
    background,
  );
  return ((latest?.id ?? 0) + 1) as EntryId;
}

/** A note Mike sent the model itself (to retry, continue or rewrite an answer), not something the person wrote. */
function isHarnessNote(entry: EntryRecord): boolean {
  const message = entry.model?.[0];
  return message?.role === "user" && userText(message.content).startsWith("<harness>");
}

async function userEntries(conversation: Conversation): Promise<EntryRecord[]> {
  const found: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, background);
    for (const entry of page.items) if (entry.kind === "pi.user" && !isHarnessNote(entry)) found.push(entry);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** How many of the client's earlier user inputs this conversation's inputs match, in order. */
function commonPrefix(piUsers: readonly EntryRecord[], clientUsers: readonly string[]): number {
  let k = 0;
  while (k < piUsers.length && k < clientUsers.length) {
    const message = piUsers[k]!.model?.[0];
    if (message?.role !== "user" || comparable(userText(message.content)) !== clientUsers[k]) break;
    k++;
  }
  return k;
}

/**
 * The conversation a stored turn belongs on, from its tree parent: the parent
 * answer's conversation when nothing was asked after it there, else a fork at
 * that answer (an edited prompt, a regenerated answer, an older branch). A chat's
 * first message starts a root conversation. Undefined when the parent was never
 * mapped (history from before this runtime), for the text fallback.
 */
async function conversationForTurn(
  harness: Harness,
  chatKey: string,
  turn: TurnIdentity,
  agentModel: { provider: string; modelId: string },
): Promise<Conversation | undefined> {
  const remember = async (tx: Tx, id: ConversationId) => {
    (await tx.doc(ChatLineage, chatKey, null)).conversations.push(id);
  };
  if (turn.parentMessageId === null) {
    return harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: agentModel }, init: remember },
      background,
    );
  }
  if (turn.parentHeard !== undefined) {
    const heard = await conversationAfterHeard(harness, chatKey, turn.parentMessageId, turn.parentHeard, agentModel);
    if (heard) return heard;
  }
  return conversationAfter(harness, chatKey, turn.parentMessageId);
}

/**
 * The conversation after an answer the person interrupted while it was read
 * aloud, with that answer as the person heard it.
 *
 * What they heard (`heard`: the spoken prefix and a marker) is the whole
 * answer's speakable text, not a prefix of any one entry: the app strips
 * markdown and citations and expands abbreviations before speaking, so it
 * cannot be lined up with the model's own text character by character. So
 * the answer is rebuilt rather than trimmed: a fork at the turn's user input,
 * then the answer's entries copied in order with every text part removed
 * (tool calls, their results and reasoning stay, so what the turn read is
 * still known), entries left empty dropped, and `heard` appended once as the
 * answer's text. Text written before a mid-answer tool call is therefore
 * neither kept nor repeated. The stored answer and the parent's own
 * conversation are unchanged. Undefined when the answer was never mapped or
 * its entries cannot be copied faithfully (compaction inside the answer), for
 * the caller to continue from the whole answer.
 */
async function conversationAfterHeard(
  harness: Harness,
  chatKey: string,
  messageId: string,
  heard: string,
  agentModel: { provider: string; modelId: string },
): Promise<Conversation | undefined> {
  const lineage = await harness.snapshot(ChatLineage, chatKey, background);
  const place = lineage?.messages?.[messageId];
  if (!place) return undefined;
  const base = await harness.conversation(place.conversation as ConversationId, background);
  if (!base) return undefined;
  // The answer's entries, newest first, back to the person's input it answers.
  const answer: EntryRecord[] = [];
  let input: EntryRecord | undefined;
  let cursor: Parameters<Conversation["entries"]>[2];
  search: do {
    const page = await base.entries({ maxEntryId: place.entry as EntryId, order: "descending" }, 50, cursor, background);
    for (const entry of page.items) {
      if (entry.kind === "pi.user" && !isHarnessNote(entry)) {
        input = entry;
        break search;
      }
      answer.push(entry);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  if (!input || answer.some((entry) => entry.head !== undefined || entry.edits?.length)) return undefined;
  const copies: EntryDraft[] = [];
  for (const entry of answer.reverse()) {
    if (isHarnessNote(entry)) continue;
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const kept = message.content.filter((part) => part.type !== "text");
      if (!kept.some((part) => part.type === "toolCall")) continue;
      copies.push({ kind: entry.kind, model: [{ ...message, content: kept }], ...(entry.data !== undefined ? { data: entry.data } : {}) });
      continue;
    }
    copies.push({ kind: entry.kind, ...(entry.model ? { model: entry.model } : {}), ...(entry.data !== undefined ? { data: entry.data } : {}) });
  }
  copies.push(...seedEntries([{ role: "assistant", content: heard }], agentModel, false));
  const remember = async (tx: Tx, id: ConversationId) => {
    (await tx.doc(ChatLineage, chatKey, null)).conversations.push(id);
  };
  return base.fork(
    input.id,
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        for (const entry of copies) await tx.appendEntry(id, entry);
        await remember(tx, id);
      },
    },
    background,
  );
}

/**
 * The conversation that continues after a stored answer: the answer's own
 * conversation when nothing was asked after it there, else a fork at it.
 * Undefined when the answer was never mapped, for the text fallback.
 */
async function conversationAfter(harness: Harness, chatKey: string, messageId: string): Promise<Conversation | undefined> {
  const remember = async (tx: Tx, id: ConversationId) => {
    (await tx.doc(ChatLineage, chatKey, null)).conversations.push(id);
  };
  const lineage = await harness.snapshot(ChatLineage, chatKey, background);
  const place = lineage?.messages?.[messageId];
  if (!place) return undefined;
  const base = await harness.conversation(place.conversation as ConversationId, background);
  if (!base) return undefined;
  // Continue only this chat's own conversation, and only at its tail. A place
  // inherited from a forked-from chat is always forked, so two chats never
  // append to one conversation.
  if (lineage!.conversations.includes(base.id)) {
    const later = await base.entries({ minEntryId: (place.entry + 1) as EntryId, order: "ascending" }, 200, undefined, background);
    if (!later.items.some((entry) => entry.kind === "pi.user")) return base;
  }
  return base.fork(place.entry as EntryId, { ownership: { kind: "ownerless" }, init: remember }, background);
}

/** The visible text of a stored answer entry. */
async function answerTextOf(conversation: Conversation, entry: EntryId): Promise<string> {
  const stored = await conversation.commit((tx) => tx.entry(entry), background);
  const message = stored?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Move a stored answer's place to the conversation's newest entry: a turn that
 * paused to ask, and the continuation that answered it, both end there.
 */
async function recordAnswerAtTail(conversation: Conversation, chatKey: string, assistantMessageId: string): Promise<void> {
  const last = (await conversation.entries({ order: "descending" }, 1, undefined, background)).items[0];
  if (!last) return;
  await conversation.commit(async (tx) => {
    const lineage = await tx.doc(ChatLineage, chatKey, null);
    if (!lineage.conversations.includes(conversation.id)) lineage.conversations.push(conversation.id);
    lineage.messages[assistantMessageId] = { conversation: conversation.id, entry: last.id };
  }, background);
}

/** Record where this turn's stored user prompt and answer landed. */
async function recordTurn(
  conversation: Conversation,
  chatKey: string,
  turn: TurnIdentity,
  userEntry: EntryId,
  answerEntry: EntryId,
): Promise<void> {
  await conversation.commit(async (tx) => {
    const lineage = await tx.doc(ChatLineage, chatKey, null);
    if (!lineage.conversations.includes(conversation.id)) lineage.conversations.push(conversation.id);
    if (turn.userMessageId) lineage.messages[turn.userMessageId] = { conversation: conversation.id, entry: userEntry };
    lineage.messages[turn.assistantMessageId] = { conversation: conversation.id, entry: answerEntry };
  }, background);
}

/**
 * Fallback for history this runtime never stored (chats begun before it, or
 * surfaces without a message tree): the conversation to continue for this history: an exact match in the chat's
 * lineage, else a fork of the best match before its first difference, seeded
 * with the client's turns Pi has not seen.
 */
async function conversationFor(
  harness: Harness,
  chatKey: string,
  history: readonly LlmMessage[],
  agentModel: { provider: string; modelId: string },
  vision: boolean,
): Promise<Conversation> {
  const lineage = (await harness.snapshot(ChatLineage, chatKey, background))?.conversations ?? [];
  const clientUsers = history.filter((m) => m.role === "user").map((m) => comparable(userText(m.content)));

  let best: { conversation: Conversation; users: EntryRecord[]; k: number } | undefined;
  for (const id of [...lineage].reverse()) {
    const conversation = await harness.conversation(id as ConversationId, background);
    if (!conversation) continue;
    const users = await userEntries(conversation);
    const k = commonPrefix(users, clientUsers);
    if (k === users.length && k === clientUsers.length) return conversation;
    if (!best || k > best.k) best = { conversation, users, k };
  }

  // Seed from the client's history after the shared prefix. With no prefix, a new root conversation.
  const unseen = (k: number) => {
    let seen = 0;
    const index = history.findIndex((m) => m.role === "user" && seen++ === k);
    return index < 0 ? [] : history.slice(index);
  };
  const remember = async (tx: Parameters<NonNullable<Parameters<Harness["createConversation"]>[0]["init"]>>[0], id: ConversationId) => {
    (await tx.doc(ChatLineage, chatKey, null)).conversations.push(id);
  };

  if (!best || best.k === 0) {
    const seeded = seedEntries(history, agentModel, vision);
    return harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: agentModel },
        init: async (tx, id) => {
          for (const entry of seeded) await tx.appendEntry(id, entry);
          await remember(tx, id);
        },
      },
      background,
    );
  }

  // Fork just before the first user input that differs (or after the last shared one).
  const forkBefore = best.users[best.k];
  let at: EntryRecord | undefined;
  if (forkBefore) {
    at = (await best.conversation.entries({ maxEntryId: (forkBefore.id - 1) as never }, 1, undefined, background)).items[0];
  } else {
    at = (await best.conversation.entries({}, 1, undefined, background)).items[0];
  }
  if (!at) throw new Error("Nothing to fork from");
  const seeded = seedEntries(unseen(best.k), agentModel, vision);
  return best.conversation.fork(
    at.id,
    {
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        for (const entry of seeded) await tx.appendEntry(id, entry);
        await remember(tx, id);
      },
    },
    background,
  );
}

/**
 * The effort a turn asks of its model. "Off" reaches a model that cannot turn
 * reasoning off as its lightest effort (providers.mts), never as "off".
 */
export function thinkingLevel(level: ReasoningLevel | undefined, mikeModel: string): ModelThinkingLevel {
  switch (level) {
    case "none":
      return "off";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
    default:
      // Omitted: bulk work (extraction, the memory curator) saves the tokens
      // and latency. Interactive chat always passes its level. A configured
      // reasoning model runs at the effort its declaration names instead.
      return getConfiguredModel(mikeModel)?.reasoning?.default ?? "off";
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export async function streamChatWithToolsOnPi(params: StreamChatParams): Promise<StreamChatResult> {
  if (params.conversationId) return runTurn(await piRuntime(), params);
  // A one-shot loop (memory curator, extraction) has no chat to come back to:
  // run it on an in-memory Harness that disappears with the call.
  const runtime = await openRuntime(new MemoryStorage());
  try {
    return await runTurn(runtime, params);
  } finally {
    await runtime.harness.close(background);
  }
}

async function runTurn(runtime: Runtime, params: StreamChatParams): Promise<StreamChatResult> {
  const { harness, installTools, resolve, bindings } = runtime;
  const ref = resolve(params.model);
  const vision = modelSeesImagesOnPi(params.model);
  const memory = params.memoryMessage && params.messages[0] === params.memoryMessage ? params.memoryMessage : undefined;
  const conversationMessages = memory ? params.messages.slice(1) : params.messages;
  const history = conversationMessages.slice(0, -1);
  const input = conversationMessages.at(-1);
  if (input?.role !== "user") throw new Error("The last message must be the user's input");

  const tools = params.tools ?? [];
  installTools(tools);
  const chatKey = params.conversationId ?? `ephemeral:${randomUUID()}`;
  // A durable turn is keyed by its reserved answer; resuming one attaches to
  // the conversation it was already running in.
  const turnKey = params.durableTurn && params.turn && params.conversationId ? params.turn.assistantMessageId : undefined;
  const resumed = turnKey && params.durableTurn?.resume
    ? (await harness.snapshot(DurableTurns, background))?.[turnKey]
    : undefined;
  if (params.durableTurn?.resume && !resumed) throw new Error("This answer is no longer in progress.");
  const resumedConversation = resumed
    ? await harness.conversation(resumed.conversation as ConversationId, background)
    : undefined;
  if (resumed && !resumedConversation) throw new Error("This answer is no longer in progress.");
  const conversation =
    resumedConversation ??
    (params.turn && params.conversationId
      ? await conversationForTurn(harness, chatKey, params.turn, ref)
      : undefined) ??
    (params.continuesAnswer && params.conversationId
      ? await conversationAfter(harness, chatKey, params.continuesAnswer)
      : undefined) ??
    (await conversationFor(harness, chatKey, history, ref, vision));

  // One commit fixes this turn's agent: model, effort, Mike's system prompt, and
  // the offered tools. A resumed turn keeps the agent it started with.
  let providerSession = "";
  await conversation.commit(async (tx) => {
    providerSession = (await tx.doc(ProviderDoc, conversation.id)).sessionId;
    if (resumed) return;
    await configure(tx, conversation.id, {
      model: ref,
      thinkingLevel: thinkingLevel(params.reasoning, params.model),
      instructions: params.systemPrompt || null,
      tools: tools.map((tool: OpenAIToolSchema) => ({ name: tool.function.name }) as ToolRegistration),
    });
  }, background);

  const callbacks = params.callbacks ?? {};
  const firstEntry = resumed ? (resumed.firstEntry as EntryId) : await nextEntryId(conversation);
  // What the conversation had spent before this turn: a turn runs alone in
  // its conversation, so the growth is the turn's own (children keep theirs).
  const usageAtStart = resumed ? resumed.usageAtStart : await usageOf(conversation, conversation.id);
  if (turnKey && !resumed) {
    // Written before the input is sent, so a crash at any later point leaves a
    // turn the next process can drive again.
    await conversation.commit(async (tx) => {
      (await tx.doc(DurableTurns))[turnKey] = {
        conversation: conversation.id,
        chatKey,
        firstEntry,
        context: params.durableTurn!.context as JsonValue,
        startedAt: Date.now(),
        ...(usageAtStart ? { usageAtStart } : {}),
      };
    }, background);
  }
  let halted: { error: unknown } | undefined;
  setAutocompactThreshold(conversation.id, params.autocompactTokens);
  if (params.runTools) {
    bindings.set(conversation.id, {
      runTools: params.runTools,
      onToolCallStart: callbacks.onToolCallStart,
      maxRounds: params.maxIterations ?? DEFAULT_MAX_ROUNDS,
      firstEntry,
      halt: (error) => {
        if (halted) return;
        halted = { error };
        // Not awaited: the abort waits for this very tool to return.
        void conversation.abort(background).catch(() => undefined);
      },
      ...(params.subagents
        ? { subagents: { host: params.subagents, chatKey, turnKey: params.turn?.assistantMessageId ?? null, started: 0, ordinal: 0, running: 0 } }
        : {}),
    });
  }
  let fullText = "";
  // Commits are throttled, so one batch can start a message with text already in
  // it, or replace a block outright. Track the in-flight assistant message and
  // emit what each event adds beyond what was already sent, block by block.
  type Block = { type: string; text?: string; thinking?: string };
  let blocks: Block[] = [];
  let sent: number[] = [];
  let thinkingOpen = false;
  // Entries a resumed turn already replayed; their message_end is not emitted twice.
  let replayedThrough = 0;

  // A message that ended broken after showing text (an error, a restart, the
  // output limit) is continued by the next one, not rewritten: the text the
  // reader has is the start of one answer. The continuation's first
  // JOIN_HOLD_CHARS are held back, then shown without any repetition of the
  // end of what was shown. No segment boundary is crossed between the two, so
  // a `<cite>` tag cut in half is completed by the continuation.
  let chain = ""; // the text shown by the current run of broken messages, ending in the latest
  let joinNext = false; // the last message ended broken after showing text
  let joining: { held: string } | undefined;
  let recovered = false;
  const releaseJoin = () => {
    if (!joining) return;
    const { held } = joining;
    joining = undefined;
    const text = trimOverlap(chain.slice(-OVERLAP_WINDOW_CHARS), held);
    if (!text) return;
    chain += text;
    fullText += text;
    callbacks.onContentDelta?.(text);
  };
  const deliver = (delta: string) => {
    if (joining) {
      joining.held += delta;
      if (joining.held.length >= JOIN_HOLD_CHARS) releaseJoin();
      return;
    }
    chain += delta;
    fullText += delta;
    callbacks.onContentDelta?.(delta);
  };
  const beginMessage = () => {
    releaseJoin();
    if (joinNext) joining = { held: "" };
    else chain = "";
    joinNext = false;
  };
  const endMessage = (message: Message | undefined) => {
    if (message?.role !== "assistant") return;
    releaseJoin();
    joinNext = isBrokenStop(message.stopReason) && chain.length > 0;
  };
  /** The newest assistant entry whose end has been handled, for waiting out the event stream. */
  let endedThrough = 0;
  let ended: Array<() => void> = [];
  const noteEnded = (id: number) => {
    endedThrough = Math.max(endedThrough, id);
    const waiting = ended;
    ended = [];
    for (const wake of waiting) wake();
  };
  /** Resolve once the stream has handled `entry`'s end, or after a short wait if it never does. */
  const streamReached = (entry: number) =>
    new Promise<void>((resolve) => {
      if (endedThrough >= entry) return resolve();
      const timer = setTimeout(resolve, 3_000);
      const check = () => {
        if (endedThrough < entry) return void ended.push(check);
        clearTimeout(timer);
        resolve();
      };
      ended.push(check);
    });

  const emit = () => {
    blocks.forEach((block, index) => {
      const value = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined;
      if (value === undefined) {
        if (block.type === "toolCall") releaseJoin();
        if (block.type === "toolCall" && thinkingOpen) {
          thinkingOpen = false;
          callbacks.onReasoningBlockEnd?.();
        }
        return;
      }
      const delta = value.slice(sent[index] ?? 0);
      if (!delta) return;
      sent[index] = value.length;
      if (block.type === "thinking") {
        thinkingOpen = true;
        callbacks.onReasoningDelta?.(delta);
      } else {
        if (thinkingOpen) {
          thinkingOpen = false;
          callbacks.onReasoningBlockEnd?.();
        }
        deliver(delta);
      }
    });
  };
  const adopt = (message: Message | undefined) => {
    if (message?.role !== "assistant") return false;
    blocks = message.content.map((block) => ({ ...block }) as Block);
    return true;
  };
  // A resumed turn replays what it committed before the restart first; the
  // stream waits for that, so the replay and the live events never interleave.
  let replayed: () => void = () => undefined;
  const replay = new Promise<void>((resolve) => (replayed = resolve));
  const stream = await watchEvents(harness, conversation.id, background);
  stream.start(async (events: readonly AgentEvent[]) => {
    await replay;
    for (const event of events) {
      if (event.type === "message_start") {
        if (adopt(event.message)) {
          sent = [];
          beginMessage();
          emit();
        }
      } else if (event.type === "message_update") {
        for (const change of event.changes) {
          if (change.type === "text_delta" || change.type === "thinking_delta") {
            const block = blocks[change.contentIndex];
            if (block?.type === "text") block.text = (block.text ?? "") + change.delta;
            else if (block?.type === "thinking") block.thinking = (block.thinking ?? "") + change.delta;
          } else if (change.type === "message") {
            adopt(change.message);
          } else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") {
            blocks[change.contentIndex] = { ...change.block } as Block;
          }
        }
        emit();
      } else if (event.type === "message_end") {
        if (event.entry.id > replayedThrough) {
          const message = event.entry.model?.[0];
          if (adopt(message)) emit();
          endMessage(message);
          blocks = [];
          sent = [];
        }
        noteEnded(event.entry.id);
      }
    }
  });

  const onAbort = () => void conversation.abort(background);
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const releaseKeys = useRequestKeys(providerSession, params.apiKeys);
  let answered = false;
  // The answer this turn writes to: its own, or the paused one it continues.
  const answerId = params.conversationId ? (params.turn?.assistantMessageId ?? params.continuesAnswer) : undefined;
  let userEntry = firstEntry;
  try {
    if (resumed) {
      // What the turn committed before the restart reaches the caller first,
      // as if it had streamed: answers so far, and the tools they started. A
      // message the crash cut off after it showed text is shown too, as the
      // start of the answer its continuation completes.
      try {
        const earlier = await conversation.entries({ minEntryId: firstEntry, order: "ascending" }, 500, undefined, background);
        for (const entry of earlier.items) {
          const message = entry.kind === "pi.assistant" ? entry.model?.[0] : undefined;
          replayedThrough = Math.max(replayedThrough, entry.id);
          noteEnded(entry.id);
          if (message?.role !== "assistant") continue;
          adopt(message);
          sent = [];
          beginMessage();
          emit();
          endMessage(message);
          if (message.stopReason !== "error" && message.stopReason !== "aborted") {
            for (const block of message.content) {
              if (block.type === "toolCall") {
                callbacks.onToolCallStart?.({ id: block.id, name: block.name, input: block.arguments as Record<string, unknown> });
              }
            }
          }
          blocks = [];
          sent = [];
        }
      } finally {
        replayed();
      }
    } else {
      replayed();
    }
    const freshThread = !resumed && history.length === 0 && (await userEntries(conversation)).length === 0;
    const content = await withTurnContext(conversation, piUserContent(input.content, vision), params.turnContext);
    // The same request id returns the submission already admitted, so driving
    // a resumed turn again never sends its input twice.
    const submission = await conversation.submit(
      {
        type: "input",
        ...(turnKey ? { requestId: `turn:${turnKey}` } : {}),
        content: freshThread && memory ? withThreadMemory(content, userText(memory.content)) : content,
        whenBusy: "reject",
      },
      background,
    );
    const settled = await submission.wait(background);
    userEntry = settled.entry ?? firstEntry;

    // Generations asked for so far, the first included. A generation that
    // stops partway is asked for again, or its answer continued from the text
    // already shown, at most MAX_ATTEMPTS in all (continuation.mts).
    let attempts = 1;
    // This turn's answer was cut off by a restart that Pi was stopped from rewriting.
    let cutOffByRestart = !!resumed && runtime.cutOff.delete(conversation.id);
    const newestAssistantEntry = async () => {
      const page = await conversation.entries({ order: "descending" }, 20, undefined, background);
      return page.items.find((entry) => entry.kind === "pi.assistant" && entry.model?.[0]?.role === "assistant")?.id ?? 0;
    };
    /** The answer a settled submission produced, or why it stopped short of one. */
    const examine = async (
      record: SettledSubmissionRecord,
    ): Promise<{ answer: EntryId } | { interruption: Interruption; error: string; restart: boolean }> => {
      if (halted) throw halted.error;
      const stopped = params.abortSignal?.aborted === true;
      if (record.status === "done" && record.type === "input") {
        if (attempts >= MAX_ATTEMPTS || stopped) return { answer: record.answer };
        const message = (await conversation.commit((tx) => tx.entry(record.answer), background))?.model?.[0];
        const cutAtLimit =
          message?.role === "assistant" &&
          message.stopReason === "length" &&
          !message.content.some((part) => part.type === "toolCall") &&
          textOfMessage(message).trim() !== "";
        if (!cutAtLimit) return { answer: record.answer };
        await streamReached(record.answer);
        return { interruption: { kind: "length" }, error: "output limit", restart: false };
      }
      const error =
        record.reason === "model_error" && record.detail !== undefined
          ? typeof record.detail === "string"
            ? record.detail
            : JSON.stringify(record.detail)
          : undefined;
      const restart = error === undefined && record.reason === "aborted" && cutOffByRestart && !stopped;
      if (restart) cutOffByRestart = false;
      if (error === undefined && !restart) throw new Error(`The answer could not be completed (${record.reason ?? "unanswered"})`);
      const recoverable = restart || (error !== undefined && isRecoverableFailure(error));
      if (stopped || !recoverable || attempts >= MAX_ATTEMPTS) {
        if (recoverable && !stopped) {
          console.warn("[pi] answer interrupted; no attempts left", { attempt: attempts, of: MAX_ATTEMPTS, shown_chars: chain.length });
        }
        if (error === undefined) throw new Error(`The answer could not be completed (${record.reason ?? "unanswered"})`);
        throw providerError(params.model, error);
      }
      // Everything the failed message showed has reached the caller by now.
      const newest = await newestAssistantEntry();
      if (newest >= firstEntry) await streamReached(newest);
      const reason = error ?? "cut off by a restart";
      return {
        interruption: joinNext && chain ? { kind: "interrupted", error: reason, written: chain } : { kind: "retry", error: reason },
        error: reason,
        restart,
      };
    };
    const answerOf = async (first: SettledSubmissionRecord): Promise<EntryId> => {
      let current = first;
      for (;;) {
        const step = await examine(current);
        if ("answer" in step) return step.answer;
        attempts += 1;
        recovered = true;
        console.warn("[pi] answer interrupted; trying again", {
          attempt: attempts,
          of: MAX_ATTEMPTS,
          reason: step.restart ? "restart" : step.interruption.kind,
          shown_chars: chain.length,
          ...safeError(new Error(step.error)),
        });
        // A restart already cost the wait (a resumed turn replays attempts that
        // were made before it), and the output limit is not a fault.
        const wait = resumed || step.restart || step.interruption.kind === "length" ? 0 : recoveryDelayMs(attempts - 1, step.error);
        if (wait > 0) await pauseFor(wait, params.abortSignal);
        if (params.abortSignal?.aborted) throw new Error("The answer could not be completed (aborted)");
        const next = await conversation.submit(
          {
            type: "input",
            ...(turnKey ? { requestId: `turn:${turnKey}:attempt:${attempts}` } : {}),
            content: noteFor(step.interruption),
            whenBusy: "reject",
          },
          background,
        );
        current = await next.wait(background);
      }
    };
    let answerEntry = await answerOf(settled);
    // An answer in another script than the person's message is asked for
    // again, once, in the same turn. A continuation's input is the client's
    // own wording of the person's answers, not their language, so it is not
    // judged. Nor is an answer finished by a continuation: only its end is in
    // the last message.
    if (
      !params.continuesAnswer &&
      attempts === 1 &&
      answerLanguageDrift(userText(input.content), await answerTextOf(conversation, answerEntry))
    ) {
      attempts += 1;
      const again = await conversation.submit(
        {
          type: "input",
          ...(turnKey ? { requestId: `turn:${turnKey}:language` } : {}),
          content: LANGUAGE_DRIFT_NOTE,
          whenBusy: "reject",
        },
        background,
      );
      answerEntry = await answerOf(await again.wait(background));
    }
    if (params.turn && params.conversationId) {
      await recordTurn(conversation, chatKey, params.turn, userEntry, answerEntry);
    } else if (answerId) {
      await recordAnswerAtTail(conversation, chatKey, answerId);
    }
    // The committed answer is authoritative; deltas may have been coalesced into a snapshot.
    const answer = await conversation.commit((tx) => tx.entry(answerEntry), background);
    const message = answer?.model?.[0];
    if (recovered) {
      // The answer is the text shown, joined across the interruptions.
      await streamReached(answerEntry);
    } else if (message?.role === "assistant") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (!fullText.endsWith(text)) fullText = text;
    }
    answered = true;
    const spent = usageAtStart ? await usageOf(conversation, conversation.id) : undefined;
    return {
      fullText,
      ...(usageAtStart && spent
        ? {
            usage: {
              input: spent.input - usageAtStart.input,
              output: spent.output - usageAtStart.output,
              cost: spent.cost - usageAtStart.cost,
            },
          }
        : {}),
    };
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
    releaseKeys();
    bindings.delete(conversation.id);
    replayed();
    await stream.stop();
    // Text held back while joining a continuation was written: show it.
    releaseJoin();
    // A failed or stopped turn has nothing to resume. An answered one stays
    // recorded until the caller has stored it (`finishTurnOnPi`): a crash in
    // between drives it again, and the resubmission returns the same answer.
    if (turnKey && !answered) await forgetTurn(harness, turnKey).catch(() => undefined);
    // A turn that paused to ask, failed or was stopped is still a place in the
    // chat: the continuation that answers it, a retry, and any turn after it
    // must find this conversation, not fall back to matching text.
    if (!answered && answerId) {
      await (async () => {
        if (params.turn?.userMessageId) await recordTurn(conversation, chatKey, params.turn, userEntry, userEntry);
        await recordAnswerAtTail(conversation, chatKey, answerId);
      })().catch(() => undefined);
    }
  }
}

async function forgetTurn(harness: Harness, turnKey: string): Promise<void> {
  await harness.commit(async (tx) => {
    const turns = await tx.doc(DurableTurns);
    delete turns[turnKey];
  }, background);
}

/**
 * Turns a previous process left in flight, oldest first. The caller drives
 * each again with `durableTurn.resume`, or gives it up with `abandonTurnOnPi`.
 */
export async function interruptedTurnsOnPi(): Promise<Array<DurableTurnRecord & { assistantMessageId: string }>> {
  const { harness } = await piRuntime();
  const turns = (await harness.snapshot(DurableTurns, background)) ?? {};
  return Object.entries(turns)
    .map(([assistantMessageId, record]) => ({ ...record, assistantMessageId }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The caller has stored a durable turn's outcome: it no longer needs resuming. */
export async function finishTurnOnPi(assistantMessageId: string): Promise<void> {
  const { harness } = await piRuntime();
  await forgetTurn(harness, assistantMessageId);
}

/** Stop an interrupted turn's run and forget it. */
export async function abandonTurnOnPi(assistantMessageId: string): Promise<void> {
  const { harness, bindings } = await piRuntime();
  const record = (await harness.snapshot(DurableTurns, background))?.[assistantMessageId];
  if (record) {
    bindings.resumable.delete(record.conversation);
    const conversation = await harness.conversation(record.conversation as ConversationId, background);
    await conversation?.abort(background).catch(() => undefined);
  }
  await forgetTurn(harness, assistantMessageId);
}

/**
 * Fork a chat's model transcript into a new chat at one stored answer. The
 * new chat's lineage starts with a fork of the answer's conversation (the
 * copied answer maps there, so the first turn continues it), and every other
 * copied message keeps its original place, which a later edit forks from.
 */
export async function forkChatLineageOnPi(params: {
  fromChatId: string;
  toChatId: string;
  atMessageId: string;
  messageIds: Record<string, string>;
}): Promise<void> {
  const { harness } = await piRuntime();
  const source = await harness.snapshot(ChatLineage, params.fromChatId, background);
  const at = source?.messages?.[params.atMessageId];
  if (!source || !at) return;
  const base = await harness.conversation(at.conversation as ConversationId, background);
  if (!base) return;
  await base.fork(
    at.entry as EntryId,
    {
      ownership: { kind: "ownerless" },
      init: async (tx: Tx, id: ConversationId) => {
        const lineage = await tx.doc(ChatLineage, params.toChatId, null);
        lineage.conversations.push(id);
        for (const [from, to] of Object.entries(params.messageIds)) {
          const place = source.messages[from];
          if (place) lineage.messages[to] = place;
        }
        lineage.messages[params.messageIds[params.atMessageId]] = { conversation: id, entry: at.entry };
      },
    },
    background,
  );
}

/** How far one person's memory reviews of a chat have looked: its newest reviewed entry. */
const MemoryReviewed = defineDocFamily<{ through: number }, null>({
  kind: "mike.memory-reviewed",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: () => ({ through: 0 }),
});

/** Compactions a review looks back past at most, oldest dropped first. */
const MAX_COMPACTION_POINTS = 2;

/** One place a memory review forks from, and the first entry its context holds verbatim. */
export type MemoryReviewPoint = { conversation: number; entry: number; contextStart: number };

/**
 * Where a memory review of a chat should look from, through the answer
 * `atMessageId`: just before each compaction since the last review (the
 * context that compaction replaced), then the answer itself. `places` maps
 * each of `messageIds` to its entry, or null when it has none. Null when the
 * answer has no place in Pi.
 */
export async function memoryReviewPointsOnPi(params: {
  chatId: string;
  reviewer: string;
  atMessageId: string;
  messageIds: readonly string[];
}): Promise<{ points: MemoryReviewPoint[]; places: Record<string, number | null> } | null> {
  const { harness } = await piRuntime();
  const lineage = await harness.snapshot(ChatLineage, params.chatId, background);
  const at = lineage?.messages?.[params.atMessageId];
  if (!lineage || !at) return null;
  const conversation = await harness.conversation(at.conversation as ConversationId, background);
  if (!conversation) return null;
  const reviewed = await harness.snapshot(MemoryReviewed, `${params.chatId}:${params.reviewer}`, background);
  const after = reviewed?.through ?? 0;

  const compactions: EntryId[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: (after + 1) as EntryId, maxEntryId: at.entry as EntryId },
      200,
      cursor,
      background,
    );
    for (const entry of page.items) if (entry.head !== undefined && entry.id > after) compactions.push(entry.id);
    cursor = page.next;
  } while (cursor);

  const entries: number[] = [];
  for (const marker of compactions.slice(-MAX_COMPACTION_POINTS)) {
    const before = await conversation.entries({ order: "descending", maxEntryId: (marker - 1) as EntryId }, 1, undefined, background);
    const entry = before.items[0]?.id;
    if (entry !== undefined && entry > after) entries.push(entry);
  }
  entries.push(at.entry);

  const points: MemoryReviewPoint[] = [];
  for (const entry of entries) {
    const view = await conversation.context(background, { at: entry as EntryId });
    const contextStart = view.head?.head ?? view.entries[0]?.id ?? entry;
    points.push({ conversation: at.conversation, entry, contextStart });
  }
  const places: Record<string, number | null> = {};
  for (const id of params.messageIds) places[id] = lineage.messages[id]?.entry ?? null;
  return { points, places };
}

/** Record that one person's memory reviews of a chat have looked through `through`. */
export async function markMemoryReviewedOnPi(params: { chatId: string; reviewer: string; through: number }): Promise<void> {
  const { harness } = await piRuntime();
  const lineage = await harness.snapshot(ChatLineage, params.chatId, background);
  const conversationId = lineage?.conversations.at(-1);
  if (conversationId === undefined) return;
  const conversation = await harness.conversation(conversationId as ConversationId, background);
  if (!conversation) return;
  await conversation.commit(async (tx) => {
    const reviewed = await tx.doc(MemoryReviewed, `${params.chatId}:${params.reviewer}`, null);
    reviewed.through = Math.max(reviewed.through, params.through);
  }, background);
}

export type MemoryReviewResult = {
  status: "done" | "failed";
  /** The model's closing words. */
  reply: string;
  usage: TurnUsage;
};

/**
 * A memory review: one turn on a fork of a conversation at `point`, so the
 * request repeats the conversation's own prefix (model, instructions, tools,
 * messages) and the provider serves it from cache, followed by `prompt`. The
 * fork keeps the conversation's tools and adds any of `tools` it lacks; the
 * calls reach `runTools`, which decides what may run. Nothing is written to
 * the conversation itself.
 */
export async function reviewMemoryOnPi(params: {
  point: { conversation: number; entry: number };
  prompt: string;
  tools: readonly OpenAIToolSchema[];
  runTools: NonNullable<StreamChatParams["runTools"]>;
  apiKeys?: UserApiKeys;
  /** A model other than the conversation's, when its own is not usable here (no cache then). */
  model?: string;
  maxRounds: number;
  signal?: AbortSignal;
}): Promise<MemoryReviewResult> {
  const { harness, installTools, resolve, bindings } = await piRuntime();
  installTools(params.tools);
  const base = await harness.conversation(params.point.conversation as ConversationId, background);
  if (!base) throw new Error("The conversation to review is missing.");
  const parentSession = (await harness.snapshot(ProviderDoc, params.point.conversation as ConversationId, background))?.sessionId;
  const session = `${parentSession ?? randomUUID()}${SIDE_SESSION_MARK}review-${randomUUID()}`;
  const fork = await base.fork(
    params.point.entry as EntryId,
    {
      ownership: { kind: "ownerless" },
      init: async (tx: Tx, id: ConversationId) => {
        (await tx.doc(ProviderDoc, id)).sessionId = session;
        // A tool the conversation already offers keeps the request's prefix,
        // and so its cache; one it lacks is appended (the prefix then differs).
        const agent = await tx.doc(AgentDoc, id);
        const offered = Array.isArray(agent.tools) ? agent.tools : null;
        const missing = params.tools.map((tool) => tool.function.name).filter((name) => offered && !offered.includes(name));
        if (offered && missing.length) {
          await configure(tx, id, { tools: [...offered, ...missing].map((name) => ({ name }) as ToolRegistration) });
        }
        if (params.model) await configure(tx, id, { model: resolve(params.model) });
      },
    },
    background,
  );
  let halted: unknown;
  bindings.set(fork.id, {
    runTools: params.runTools,
    maxRounds: params.maxRounds,
    firstEntry: await nextEntryId(fork),
    halt: (error) => {
      halted ??= error;
      void fork.abort(background).catch(() => undefined);
    },
  });
  const releaseKeys = useRequestKeys(session, params.apiKeys);
  const onAbort = () => void fork.abort(background).catch(() => undefined);
  params.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let settled = await (
      await fork.submit({ type: "input", content: params.prompt, whenBusy: "reject" }, background)
    ).wait(background);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const failure = settled.status === "unanswered" && settled.reason === "model_error" ? settled.detail : undefined;
      if (typeof failure !== "string" || !isRecoverableFailure(failure) || params.signal?.aborted || halted) break;
      await pauseFor(recoveryDelayMs(attempt - 1, failure), params.signal);
      settled = await (
        await fork.submit({ type: "input", content: noteFor({ kind: "retry", error: failure }), whenBusy: "reject" }, background)
      ).wait(background);
    }
    if (halted) throw halted;
    const usage = await usageOf(fork, fork.id);
    if (settled.status !== "done" || settled.type !== "input") {
      return { status: "failed", reply: await lastAssistantText(harness, fork.id).catch(() => ""), usage };
    }
    const answer = await fork.commit((tx) => tx.entry(settled.answer), background);
    const message = answer?.model?.[0];
    const reply = message?.role === "assistant"
      ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim()
      : "";
    return { status: "done", reply, usage };
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    releaseKeys();
    bindings.delete(fork.id);
  }
}

/** Output tokens added for a model's reasoning when it cannot turn thinking off. */
const THINKING_HEADROOM = 4096;

/**
 * One prompt, one answer, no tools and no transcript: titles, extraction, the
 * guardrail classifier. Reasoning stays off where the model allows it.
 */
export async function completeTextOnPi(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  const catalog = openModels();
  const ref = catalog.resolve(params.model);
  const model = catalog.models.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error(`Unknown model id: ${params.model}`);
  const sessionId = randomUUID();
  const releaseKeys = useRequestKeys(sessionId, params.apiKeys);
  // Some models cannot stop thinking. Give them their lightest effort and room
  // to think on top of the answer budget, or a 64-token title comes back empty.
  const lightest = lightestThinkingLevel(model);
  const alwaysThinks = lightest !== undefined;
  const maxTokens = params.maxTokens ?? 512;
  try {
    let message = await catalog.models.completeSimple(
      model,
      {
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        messages: [{ role: "user", content: params.user, timestamp: Date.now() }],
      },
      {
        maxTokens: alwaysThinks ? maxTokens + THINKING_HEADROOM : maxTokens,
        ...(lightest ? { reasoning: lightest } : {}),
        sessionId,
      },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw message.errorMessage ? providerError(params.model, message.errorMessage) : new Error("The model request failed.");
    }
    const configured = getConfiguredModel(params.model);
    if (configured && tolerateTextToolCalls(configured)) message = tolerantMessage(message);
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  } finally {
    releaseKeys();
  }
}

/** The context window, in tokens, of the catalog entry `mikeModel` runs on; undefined when it does not resolve. */
export async function contextWindowOnPi(mikeModel: string): Promise<number | undefined> {
  try {
    const catalog = openModels();
    const ref = catalog.resolve(mikeModel);
    const window = catalog.models.getModel(ref.provider, ref.modelId)?.contextWindow;
    return typeof window === "number" && window > 0 ? window : undefined;
  } catch {
    return undefined;
  }
}
