// Spike: crash recovery on the Postgres adapter with a real SIGKILL.
//
// The parent creates a schema, then forks a child that opens a Harness, submits
// one input per scenario and signals when it reaches the crash point. The parent
// SIGKILLs the child there, reopens the same schema in-process, resumes, and
// reports what each conversation's transcript and submission look like.
//
//   PI_SPIKE_DATABASE_URL=postgres://... npx tsx src/durable/spike/crash.mts
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type ConversationId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { PostgresStorage } from "@netzlabor/pi-durable-postgres";
import { nodePostgresDatabase } from "@netzlabor/pi-durable-postgres/node";
import pg from "pg";

const url = process.env.PI_SPIKE_DATABASE_URL!;
const role = process.env.SPIKE_ROLE ?? "parent";
const schema = process.env.SPIKE_SCHEMA ?? `crash_${randomUUID().replaceAll("-", "")}`;
const LONG = "Clause 14.2 limits recovery to direct damages. ".repeat(60);

let executions = { safe: 0, unsafe: 0 };

function setup(stage: "child" | "parent") {
  const faux = fauxProvider({ tokensPerSecond: stage === "child" ? 40 : 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const toolNameFor = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
    const first = ctx.messages.find((m) => m.role === "user");
    const text = JSON.stringify(first?.content ?? "");
    return text.includes("unsafe-tool") ? "write_unsafe" : text.includes("safe-tool") ? "read_safe" : undefined;
  };
  const respond = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
    const last = ctx.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage(`Done after: ${JSON.stringify(last.content).slice(0, 120)}`);
    const tool = toolNameFor(ctx);
    if (tool) return fauxAssistantMessage([fauxToolCall(tool, { q: "x" })], { stopReason: "toolUse" });
    return fauxAssistantMessage(LONG);
  };
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const signal = (msg: string) => process.send?.(msg);
  const slowTool = (name: string, replay: "safe" | "unsafe") =>
    defineTool({
      name,
      description: name,
      parameters: Type.Object({ q: Type.String() }),
      replay,
      execute: async (_args, api) => {
        executions[replay === "safe" ? "safe" : "unsafe"]++;
        api.output(`started ${name} in ${stage}\n`);
        if (stage === "child") {
          signal(`tool:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
        return { content: [{ type: "text", text: `${name} finished in ${stage}` }] };
      },
    });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "spike", tools: [slowTool("read_safe", "safe"), slowTool("write_unsafe", "unsafe")] }));
  return { models, registry, faux };
}

async function openHarness(stage: "child" | "parent") {
  const storage = await PostgresStorage.open(
    nodePostgresDatabase(new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })),
  );
  const { models, registry, faux } = setup(stage);
  const harness = await Harness.open(storage, { models, registry }, context);
  return { harness, model: { provider: "faux", modelId: faux.getModel().id } };
}

const scenarios = ["mid-generation", "safe-tool", "unsafe-tool"] as const;

if (role === "child") {
  const { harness, model } = await openHarness("child");
  const seen = new Set<string>();
  for (const name of scenarios) {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    process.send?.(`conversation:${name}:${conversation.id}`);
    await conversation.submit({ type: "input", content: `Scenario ${name}`, requestId: `req-${name}` }, context);
    if (name === "mid-generation") {
      // Signal once a partial answer is durably committed in pi.live.
      const view = await conversation.viewState(context);
      view.subscribe((value: any) => {
        const partial = value.docs?.["pi.live"]?.generation?.message;
        const text = JSON.stringify(partial ?? "");
        if (text.length > 400 && !seen.has(name)) {
          seen.add(name);
          process.send?.("partial:mid-generation");
        }
      });
    }
  }
  await new Promise(() => undefined); // wait to be killed
} else {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const ids = new Map<string, ConversationId>();
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, SPIKE_ROLE: "child", SPIKE_SCHEMA: schema },
    execArgv: process.execArgv,
  });
  const waiting = new Set(["partial:mid-generation", "tool:read_safe", "tool:write_unsafe"]);
  await new Promise<void>((resolve, reject) => {
    child.on("message", (msg: string) => {
      const [kind, name, id] = msg.split(":");
      if (kind === "conversation") ids.set(name!, Number(id) as ConversationId);
      waiting.delete(msg);
      if (waiting.size === 0) resolve();
    });
    child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
    setTimeout(() => reject(new Error(`timeout; still waiting for ${[...waiting]}`)), 60_000);
  });
  child.removeAllListeners("exit");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  console.log("child SIGKILLed at: partial answer streaming, safe tool running, unsafe tool running");

  // The killed child's session advisory lock is released when Postgres notices the dead connection.
  const t0 = performance.now();
  const { harness } = await openHarness("parent");
  console.log(`reopened in ${Math.round(performance.now() - t0)} ms`);
  harness.resume();
  for (const name of scenarios) {
    const conversation = (await harness.conversation(ids.get(name)!, context))!;
    const submission = (await conversation.submit({ type: "input", content: `Scenario ${name}`, requestId: `req-${name}` }, context));
    const settled = await submission.wait(context);
    const entries = (await conversation.entries({ order: "ascending" }, 50, undefined, context)).items as EntryRecord[];
    const summary = entries.map((entry) => {
      const message: any = entry.model?.[0];
      if (entry.kind === "pi.assistant") return `assistant(${message?.stopReason})`;
      if (entry.kind === "pi.tool-result") {
        const diagnostics = (entry.data as any)?.diagnostics?.map((d: any) => d.code).join(",");
        return `tool-result(${message?.isError ? "error" : "ok"}${diagnostics ? ":" + diagnostics : ""}: ${JSON.stringify(message?.content).slice(0, 60)})`;
      }
      return entry.kind;
    });
    console.log(JSON.stringify({ scenario: name, settled: settled.status, sameSubmission: submission.id, transcript: summary }));
  }
  console.log(JSON.stringify({ toolExecutionsAfterRestart: executions }));
  await harness.close(context);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
