// Spike: cost of reopening a Harness and deriving a long conversation's model
// context (1,000 and 5,000 entries) on the Postgres adapter.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, UserEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { PostgresStorage } from "@netzlabor/pi-durable-postgres";
import { nodePostgresDatabase } from "@netzlabor/pi-durable-postgres/node";
import pg from "pg";

const url = process.env.PI_SPIKE_DATABASE_URL!;
const TEXT = "The parties agree that the governing law is New York. ".repeat(12);
for (const total of [1000, 5000]) {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const schema = `hydrate_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const open = async () =>
    Harness.open(
      await PostgresStorage.open(nodePostgresDatabase(new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 }))),
      { models: createModels(), registry: createRegistry() },
      context,
    );
  let harness = await open();
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  for (let i = 0; i < total; i += 100) {
    await conversation.commit(async (tx) => {
      for (let j = 0; j < 100; j += 2) {
        await tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: `Q${i + j} ${TEXT}`, timestamp: 0 }] });
        await tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: `A${i + j} ${TEXT}` }], api: "faux", provider: "faux", model: "faux-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as any] });
      }
    }, context);
  }
  await harness.close(context);
  const t0 = performance.now();
  harness = await open();
  const t1 = performance.now();
  const reopened = (await harness.conversation(conversation.id, context))!;
  const view = await reopened.context(context);
  const t2 = performance.now();
  const again = await reopened.context(context);
  const t3 = performance.now();
  const state = await reopened.viewState(context);
  const t4 = performance.now();
  state.dispose();
  console.log(JSON.stringify({ entries: total, openMs: Math.round(t1 - t0), firstContextMs: Math.round(t2 - t1), cachedContextMs: Math.round(t3 - t2), viewStateMs: Math.round(t4 - t3), messages: view.messages.length, again: again.messages.length }));
  await harness.close(context);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
void UserEntry; void AssistantEntry;
