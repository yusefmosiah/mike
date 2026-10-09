// Spike benchmark: one Pi Durable Harness over the Postgres adapter, serving N
// conversations at once with a scripted streaming model and one tool round per
// run. Measures commit volume and latency on the single Session line.
//
//   PI_SPIKE_DATABASE_URL=postgres://... npx tsx src/durable/spike/bench.mts 1 10 25 50
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type Storage } from "@earendil-works/pi-durable";
import { PostgresStorage } from "@netzlabor/pi-durable-postgres";
import { nodePostgresDatabase } from "@netzlabor/pi-durable-postgres/node";
import pg from "pg";

const url = process.env.PI_SPIKE_DATABASE_URL;
if (!url) throw new Error("Set PI_SPIKE_DATABASE_URL");
const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const TOKENS_PER_SECOND = Number(process.env.TPS ?? 60);
const PARAGRAPH = "The indemnity clause survives termination and caps liability at fees paid. ".repeat(20);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Counts and times every Storage.commit without changing behavior. */
function instrument(storage: Storage) {
  const latencies: number[] = [];
  const wrapped = new Proxy(storage, {
    get(target, key, receiver) {
      if (key === "commit") {
        return async (...args: Parameters<Storage["commit"]>) => {
          const start = performance.now();
          try {
            return await target.commit(...args);
          } finally {
            latencies.push(performance.now() - start);
          }
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: wrapped, latencies };
}

async function run(n: number) {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const schema = `bench_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const base = await PostgresStorage.open(
    nodePostgresDatabase(new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })),
  );
  const { storage, latencies } = instrument(base);

  const faux = fauxProvider({ tokensPerSecond: TOKENS_PER_SECOND, tokenSize: { min: 3, max: 6 } });
  const models = createModels();
  models.setProvider(faux.provider);
  // Every request: answer after a tool result, otherwise think aloud and call the tool.
  const respond = (ctx: { messages: readonly { role: string }[] }) =>
    ctx.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage(PARAGRAPH)
      : fauxAssistantMessage([fauxText(PARAGRAPH.slice(0, 400)), fauxToolCall("lookup", { q: "indemnity" })], {
          stopReason: "toolUse",
        });
  faux.setResponses(Array.from({ length: n * 4 }, () => respond));

  const lookup = defineTool({
    name: "lookup",
    description: "Look something up",
    parameters: Type.Object({ q: Type.String() }),
    replay: "safe",
    execute: async (_args, api) => {
      for (let i = 0; i < 5; i++) {
        api.output(`${PARAGRAPH.slice(0, 400)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "bench", tools: [lookup] }));
  const harness = await Harness.open(storage, { models, registry }, context);
  const model = { provider: "faux", modelId: faux.getModel().id };

  const conversations = await Promise.all(
    Array.from({ length: n }, () =>
      harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context),
    ),
  );
  latencies.length = 0;
  const start = performance.now();
  const runTimes = await Promise.all(
    conversations.map(async (conversation, i) => {
      const t0 = performance.now();
      const submission = await conversation.submit({ type: "input", content: `Question ${i}` }, context);
      const settled = await submission.wait(context);
      if (settled.status !== "done") throw new Error(`run ${i} ${settled.status}: ${JSON.stringify(settled)}`);
      return performance.now() - t0;
    }),
  );
  const wall = performance.now() - start;
  await harness.close(context);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  return {
    conversations: n,
    wallMs: Math.round(wall),
    runP50Ms: Math.round(percentile(runTimes, 50)),
    runMaxMs: Math.round(Math.max(...runTimes)),
    commits: latencies.length,
    commitsPerSec: Math.round(latencies.length / (wall / 1000)),
    commitP50Ms: +percentile(latencies, 50).toFixed(2),
    commitP95Ms: +percentile(latencies, 95).toFixed(2),
    commitP99Ms: +percentile(latencies, 99).toFixed(2),
  };
}

for (const n of sizes.length ? sizes : [1, 10, 25, 50]) {
  console.log(JSON.stringify(await run(n)));
}
