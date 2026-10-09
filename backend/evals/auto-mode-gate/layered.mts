/**
 * Runs the layered gate (src/lib/guardrails/layered.ts) over the eval sets and
 * appends one JSON line per case and model: the Layer 2 rule for cases the
 * table settles, and the raw Layer 3 answers for the rest, so
 * `layered-report.mts` can replay any threshold without calling a model again.
 *
 *   npx tsx --env-file=.env evals/auto-mode-gate/layered.mts \
 *     --models liquid/d1,jaredpalmer/kev-4b,cloudflare/clef-flash --repeats 1 --out layered.jsonl \
 *     [--questions harm|proof|phrased] [--history]
 *
 * --questions picks the Layer 3 wording (LAYER3_QUESTION_SETS), or "phrased":
 * each question type in three phrasings (QUESTION_PHRASINGS); --history adds
 * each thread's earlier user messages from corpus/history.json (a twin shares
 * its source case's thread).
 *
 * Sets: corpus/allow.json (legitimate calls with their context), corpus/twins.json
 * (a harmful near-twin of each), and the hand-written cases in cases.mts with
 * the contexts in contexts.mts. Needs OPENROUTER_API_KEY.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { askDecisionQuestions } from "../../src/lib/guardrails/decisions.ts";
import { LAYER3_QUESTION_SETS, phrasedQuestions, planCall, type Layer3QuestionId, type Layer3QuestionSet } from "../../src/lib/guardrails/layered.ts";
import type { ContextEntry } from "../../src/lib/guardrails/facts.ts";
import { CASES } from "./cases.mts";
import { CONTEXTS } from "./contexts.mts";

export type EvalCase = {
  id: string;
  set: "allow" | "twin" | "hand";
  /** allow = should run unattended; stop = should be denied or confirmed first. */
  label: "allow" | "stop";
  /** The independent checker's verdict, when one ran (gpt-6-luna). */
  check?: string;
  family: string;
  user_request: string;
  context: ContextEntry[];
  /** The user's earlier messages in the thread (corpus/history.json), oldest first. */
  earlier?: string[];
  tool: string;
  arguments: Record<string, unknown>;
};

const here = new URL(".", import.meta.url).pathname;

export function loadCases(withHistory = false): EvalCase[] {
  const cases: EvalCase[] = [];
  const history: Record<string, string[]> = withHistory ? JSON.parse(readFileSync(`${here}corpus/history.json`, "utf8")).history : {};
  const allow = JSON.parse(readFileSync(`${here}corpus/allow.json`, "utf8")).cases;
  for (const c of allow) cases.push({ ...c, set: "allow", label: "allow", earlier: history[c.id] });
  const twins = JSON.parse(readFileSync(`${here}corpus/twins.json`, "utf8")).cases;
  // A twin shares its source case's thread.
  for (const c of twins) cases.push({ ...c, set: "twin", label: "stop", earlier: history[c.twin_of] });
  for (const c of CASES) {
    cases.push({
      id: `H:${c.id}`,
      set: "hand",
      label: c.label === "allow" ? "allow" : "stop",
      family: `H:${c.family}`,
      user_request: c.user_request,
      context: CONTEXTS[c.id] ?? [],
      tool: c.tool,
      arguments: c.arguments,
    });
  }
  return cases;
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

async function main() {
  const models = flag("models", "liquid/d1,jaredpalmer/kev-4b,cloudflare/clef-flash").split(",");
  const repeats = Number(flag("repeats", "1"));
  const concurrency = Number(flag("concurrency", "8"));
  const timeoutMs = Number(flag("timeout", "8000"));
  const out = flag("out", "layered.jsonl");
  const only = flag("cases", "");
  const questionSet = flag("questions", "harm") as Layer3QuestionSet;
  const withHistory = process.argv.includes("--history");
  const cases = loadCases(withHistory).filter((c) => !only || only.split(",").includes(c.id));

  const done = new Set<string>();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (!row.error) done.add(`${row.id}|${row.model}|${row.repeat}`);
    }
  }

  type Job = () => Promise<void>;
  const jobs: Job[] = [];
  let cost = 0;
  for (const c of cases) {
    const plan = planCall({ userRequest: c.user_request, tool: c.tool, args: c.arguments, context: c.context, earlierRequests: c.earlier });
    const base = { id: c.id, set: c.set, label: c.label, family: c.family, check: c.check ?? null };
    if (plan.decided) {
      if (!done.has(`${c.id}|null|0`)) {
        appendFileSync(out, JSON.stringify({ ...base, model: null, repeat: 0, rule: plan.rule, outcome: plan.outcome }) + "\n");
      }
      continue;
    }
    for (const model of models) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        if (done.has(`${c.id}|${model}|${repeat}`)) continue;
        jobs.push(async () => {
          const questions = questionSet === ("phrased" as string)
            ? phrasedQuestions(plan.questions)
            : (Object.fromEntries(plan.questions.map((id) => [id, LAYER3_QUESTION_SETS[questionSet][id]])) as Record<string, (typeof LAYER3_QUESTION_SETS)["harm"][Layer3QuestionId]>);
          const asked = await askDecisionQuestions({ model, state: plan.state as never, timeoutMs }, questions);
          cost += asked.usage?.cost ?? 0;
          appendFileSync(
            out,
            JSON.stringify({
              ...base,
              model,
              repeat,
              rule: "layer3",
              questions: plan.questions,
              answers: asked.ok ? asked.answers : undefined,
              error: asked.ok ? undefined : asked.reason,
              latencyMs: asked.latencyMs,
            }) + "\n",
          );
        });
      }
    }
  }
  console.log(`${cases.length} cases, ${jobs.length} model calls`);
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
        if (++finished % 100 === 0) console.log(`${finished}/${jobs.length} ($${cost.toFixed(4)})`);
      }
    }),
  );
  console.log(`done: ${finished} calls, $${cost.toFixed(4)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) await main();
