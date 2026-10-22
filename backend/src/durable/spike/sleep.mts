// Spike: a durable sleep on the Postgres adapter survives a real SIGKILL.
//
// Pi Durable 1.4 waits out a generation retry backoff as a `sleeping` task
// instead of inside a running phase. A child opens a Harness with Pi's retry
// on, the model's first answer fails with a retryable error, and once the
// sleeping task is stored the parent SIGKILLs the child, reopens the schema,
// and checks that the task wakes and the answer completes. (Mike's own chat
// turns run with Pi's retry off; compaction backoffs still sleep.)
//
//   PI_SPIKE_DATABASE_URL=postgres://... npx tsx src/durable/spike/sleep.mts
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ConversationId, type EntryRecord } from "@earendil-works/pi-durable";
import pg from "pg";
import { nodePostgresDatabase } from "../../lib/llm/pi/postgres/node.mjs";
import { PostgresStorage } from "../../lib/llm/pi/postgres/storage.mjs";

const url = process.env.PI_SPIKE_DATABASE_URL;
if (!url) throw new Error("PI_SPIKE_DATABASE_URL is required");
const role = process.env.SPIKE_ROLE ?? "parent";
const schema = process.env.SPIKE_SCHEMA ?? `sleep_${randomUUID().replaceAll("-", "")}`;
const BACKOFF_MS = 4_000;

async function openHarness(stage: "child" | "parent") {
  const storage = await PostgresStorage.open(
    nodePostgresDatabase(new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })),
  );
  const faux = fauxProvider({ tokensPerSecond: 0 });
  faux.setResponses(
    stage === "child"
      ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 The service is temporarily unavailable" })]
      : [fauxAssistantMessage("Answered after the backoff.")],
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = { retry: { enabled: true, maxRetries: 3, baseDelayMs: BACKOFF_MS } };
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings }, context);
  return { harness, model: { provider: "faux", modelId: faux.getModel().id } };
}

if (role === "child") {
  const { harness, model } = await openHarness("child");
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  process.send?.(`conversation:${conversation.id}`);
  await conversation.submit({ type: "input", content: "Hello", requestId: "req-sleep" }, context);
  await new Promise(() => undefined); // wait to be killed
} else {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  let id: ConversationId | undefined;
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, SPIKE_ROLE: "child", SPIKE_SCHEMA: schema },
    execArgv: process.execArgv,
  });
  child.on("message", (msg: string) => {
    if (msg.startsWith("conversation:")) id = Number(msg.slice("conversation:".length)) as ConversationId;
  });
  const deadline = Date.now() + 30_000;
  let sleeping: { kind: string; until: number } | undefined;
  while (!sleeping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await admin
      .query(`SELECT kind, record FROM "${schema}".tasks WHERE status = 'sleeping'`)
      .catch(() => ({ rows: [] as { kind: string; record: string }[] }));
    const row = rows.rows[0];
    if (row) sleeping = { kind: JSON.parse(row.kind), until: JSON.parse(row.record).state.until };
  }
  if (!sleeping || id === undefined) throw new Error("no sleeping task was stored");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  console.log(JSON.stringify({ sleepingTask: sleeping.kind, wakesInMs: sleeping.until - Date.now() }));

  const t0 = performance.now();
  const { harness } = await openHarness("parent");
  harness.resume();
  const conversation = (await harness.conversation(id, context))!;
  const submission = await conversation.submit({ type: "input", content: "Hello", requestId: "req-sleep" }, context);
  const settled = await submission.wait(context);
  const entries = (await conversation.entries({ order: "ascending" }, 50, undefined, context)).items as EntryRecord[];
  const transcript = entries.map((entry) => {
    const message: any = entry.model?.[0];
    return entry.kind === "pi.assistant" ? `assistant(${message?.stopReason})` : entry.kind;
  });
  const left = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".tasks WHERE status = 'sleeping'`);
  console.log(JSON.stringify({
    settled: settled.status,
    msAfterReopen: Math.round(performance.now() - t0),
    transcript,
    sleepingLeft: left.rows[0].n,
  }));
  await harness.close(context);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
