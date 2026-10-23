/**
 * Planted facts across a compaction: how many the model still gets right
 * after the messages that held them were summarized, with and without the
 * history functions (src/lib/llm/pi/history.mts), and how often it reaches
 * for them.
 *
 *   npx tsx --env-file=.env evals/compaction-recall/run.mts \
 *     --model opencode-go/deepseek-v4.1-flash [--out compaction-recall.jsonl]
 *
 * One synthetic matter is built turn by turn on the real Pi runtime (in
 * memory storage), with eight facts planted in its early messages, in the
 * middle of long document excerpts: where the summary's word-for-word record
 * of the person's messages (head and tail of each) does not reach, so only
 * the summary's own choice or a lookup can bring a fact back. `--planted
 * notes` marks each as the lawyer's note, which the summary is asked to keep;
 * `--planted clauses` (the default) makes it one more line of the draft.
 * Each row says whether the summary still held the answer. The owner's auto-compact threshold is set low, so the
 * early turns are compacted. Each question is then asked on its own branch
 * from the last answer, once with no tools and once with history_search and
 * history_read offered as tools (the functions code mode gives run_python;
 * offered directly here, so no kernel is needed), and once more with them
 * offered and the tool index's lines for them, which say when to reach for
 * them, in the system prompt as a chat has them. Prints a table and appends
 * one JSON line per question and arm to --out.
 *
 * Needs the model's provider key in the environment. A run costs a few cents
 * on a flash model: about a dozen requests of 30k to 80k tokens.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { defineDocFamily, MemoryStorage } from "@earendil-works/pi-durable";

import { piRuntime, resetPiRuntime, streamChatWithToolsOnPi } from "../../src/lib/llm/pi/runtime.mts";
import type { LlmMessage, NormalizedToolCall, OpenAIToolSchema } from "../../src/lib/llm/types.ts";
import { HISTORY_TOOLS } from "../../src/modules/chat/engine/tools/toolSchemas.ts";
import { pythonToolIndex, pythonToolSpecs } from "../../src/lib/codemode/python.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "opencode-go/deepseek-v4.1-flash" },
    out: { type: "string" },
    // Characters of document excerpt per setup turn (about 4 per token).
    excerpt: { type: "string", default: "48000" },
    planted: { type: "string", default: "clauses" },
  },
});
const MODEL = values.model!;
const EXCERPT_CHARS = Number(values.excerpt);

type Fact = { said: string; clause: string; question: string; answer: RegExp };

/** Facts the person states in passing, each with a question and what a right answer must contain. */
const FACTS: Fact[] = [
  { said: "For the record, the escrow agent is Halvorsen & Pike LLP.", clause: "The Escrow Agent shall be Halvorsen & Pike LLP.", question: "Who is the escrow agent?", answer: /halvorsen/i },
  { said: "The liability cap we agreed with them is EUR 4.2 million.", clause: "The Cap shall be EUR 4,200,000.", question: "What is the liability cap?", answer: /4[.,]2\s*(m|million)|4,200,000/i },
  { said: "Their counsel is Ines Okafor, ines.okafor@brightwater-legal.example.", clause: "Notices to the Seller's counsel shall be sent to ines.okafor@brightwater-legal.example.", question: "What email address do notices to the Seller's counsel go to?", answer: /ines\.okafor@brightwater-legal\.example/i },
  { said: "Remember that the notice period for termination is 47 days, not the usual 30.", clause: "Either party may terminate on not less than 47 days' notice.", question: "How long is the notice period for termination?", answer: /\b47\b/ },
  { said: "We call the target group the 'Meridian Entities' throughout.", clause: "In this Agreement the Target and its Subsidiaries are together the \"Meridian Entities\".", question: "What is the defined term for the target and its subsidiaries?", answer: /meridian entities/i },
  { said: "Signing is set for 14 March 2027.", clause: "The Long Stop Date shall be 14 March 2027.", question: "What is the long stop date?", answer: /14\s*(th\s*)?march\s*2027|2027-03-14|march\s*14(th)?,?\s*2027/i },
  { said: "The non-compete must stay at clause 11.3, the client insists.", clause: "The Restricted Period for the non-compete shall be 31 months.", question: "How long is the restricted period for the non-compete?", answer: /\b31\b/ },
  { said: "Governing law is the law of Ontario, with arbitration seated in Toronto.", clause: "The seat of any arbitration shall be Toronto.", question: "Where is the arbitration seated?", answer: /toronto/i },
];
const PLANTED = values.planted === "notes" ? "notes" : "clauses";

const CLAUSES = [
  "The Seller shall procure that each Group Company carries on its business in the ordinary course consistent with past practice.",
  "No party shall make any announcement concerning this Agreement without the prior written consent of the other parties.",
  "Each Warranty is to be construed independently and is not limited by reference to any other Warranty.",
  "The Purchaser acknowledges that it has not relied on any representation not expressly set out in this Agreement.",
  "Any notice under this Agreement shall be in writing and delivered by hand or by recorded delivery.",
  "The aggregate liability of the Seller in respect of all Claims shall not exceed the amount set out in Schedule 4.",
];

/** A long excerpt of a draft agreement, different for each turn, with `notes` halfway through. */
function excerpt(turn: number, notes: string[]): string {
  const parts: string[] = [];
  let length = 0;
  let noted = notes.length === 0;
  for (let n = 1; length < EXCERPT_CHARS; n += 1) {
    if (!noted && length >= EXCERPT_CHARS / 2) {
      parts.push(...notes.map((note, i) => (PLANTED === "notes" ? `[Note from the lawyer: ${note}]` : `${turn}.${n}${String.fromCharCode(97 + i)} ${note}`)));
      noted = true;
    }
    const clause = `${turn}.${n} ${CLAUSES[(turn * 7 + n) % CLAUSES.length]}`;
    parts.push(clause);
    length += clause.length + 1;
  }
  return parts.join("\n");
}

const SYSTEM = "You are a legal assistant helping a lawyer with a share purchase. Answer briefly. During document review, reply with one sentence acknowledging the excerpt.";

const historyTools = HISTORY_TOOLS as unknown as OpenAIToolSchema[];
const ARMS = ["none", "history", "index"] as const;
type Arm = (typeof ARMS)[number];
/** The index lines a chat shows for the history functions, without its Python preamble. */
const HISTORY_INDEX = `Your tools:\n${pythonToolIndex(pythonToolSpecs(historyTools)).split("\n").filter((line) => line.startsWith("- ")).join("\n")}`;

async function turn(
  messages: LlmMessage[],
  identity: { user: string; parent: string | null; assistant: string },
  options: { tools?: OpenAIToolSchema[]; lookups?: string[]; autocompactTokens?: number; index?: boolean } = {},
) {
  return streamChatWithToolsOnPi({
    conversationId: "recall-eval",
    model: MODEL,
    systemPrompt: options.index ? `${SYSTEM}\n\n${HISTORY_INDEX}` : SYSTEM,
    messages,
    tools: options.tools ?? [],
    turn: { userMessageId: identity.user, parentMessageId: identity.parent, assistantMessageId: identity.assistant },
    autocompactTokens: options.autocompactTokens ?? 20_000,
    runTools: async (calls: NormalizedToolCall[]) =>
      Promise.all(
        calls.map(async (call) => {
          options.lookups?.push(call.name);
          const reply = call.name === "history_search"
            ? await call.history!.search(call.input)
            : call.name === "history_read"
              ? await call.history!.read(call.input)
              : { content: `No tool named ${call.name}.`, isError: true };
          return { tool_use_id: call.id, content: reply.content };
        }),
      ),
  });
}

await resetPiRuntime({ storage: new MemoryStorage() });

// The matter: facts planted in the first turns, then excerpts that push them
// out of the kept context.
const history: LlmMessage[] = [];
let parent: string | null = null;
const SETUP_TURNS = 7;
for (let index = 1; index <= SETUP_TURNS; index += 1) {
  const facts = FACTS.filter((_, i) => i % 3 === index - 1).map((fact) => (PLANTED === "notes" ? fact.said : fact.clause));
  const content = [`Here is part ${index} of the draft SPA for review, with my notes in it:`, excerpt(index, facts)].join("\n\n");
  history.push({ role: "user", content });
  const answer = await turn(history, { user: `u${index}`, parent, assistant: `a${index}` });
  history.push({ role: "assistant", content: answer.fullText });
  parent = `a${index}`;
  process.stderr.write(`setup turn ${index}/${SETUP_TURNS}\n`);
}
const { harness } = await piRuntime();
await harness.waitForIdle(background);

// What the base conversation's context holds now: its summary, and anything still verbatim.
const lineage = defineDocFamily<{ messages: Record<string, { conversation: number }> }, null>({
  kind: "mike.chat",
  version: 2,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: () => ({ messages: {} }),
});
const base = (await harness.snapshot(lineage, "recall-eval", background))!.messages[parent!]!.conversation;
const view = await (await harness.conversation(base as never, background))!.context(background);
const shown = view.messages
  .filter((message) => message.role === "user")
  .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : "")).join("")));
const summary = shown.filter((text) => text.startsWith("The conversation history before this point was compacted")).join("\n");
const verbatim = shown.filter((text) => !text.startsWith("The conversation history before this point was compacted")).join("\n");
process.stderr.write(`summary: ${summary.length} characters\n`);

type Row = {
  model: string;
  planted: string;
  arm: Arm;
  fact: string;
  /** Where the answer still was before the question: in the summary, still verbatim, or gone. */
  held: "summary" | "verbatim" | "gone";
  right: boolean;
  lookups: string[];
  answer: string;
};
const rows: Row[] = [];
for (const [index, fact] of FACTS.entries()) {
  for (const arm of ARMS) {
    const lookups: string[] = [];
    const id = `${arm}-${index}`;
    const result = await turn(
      [...history, { role: "user", content: fact.question }],
      { user: `q-${id}`, parent, assistant: `r-${id}` },
      // A question's branch does not compact again after it answers.
      { autocompactTokens: 10_000_000, ...(arm === "none" ? {} : { tools: historyTools, lookups, index: arm === "index" }) },
    );
    const held = fact.answer.test(verbatim) ? "verbatim" : fact.answer.test(summary) ? "summary" : "gone";
    const row: Row = { model: MODEL, planted: PLANTED, arm, fact: fact.question, held, right: fact.answer.test(result.fullText), lookups, answer: result.fullText.slice(0, 300) };
    rows.push(row);
    if (values.out) appendFileSync(values.out, `${JSON.stringify(row)}\n`);
    process.stderr.write(`${arm.padEnd(7)} ${row.right ? "right" : "wrong"} ${lookups.length} lookups  held: ${held.padEnd(8)}  ${fact.question}\n`);
  }
}

for (const arm of ARMS) {
  const mine = rows.filter((row) => row.arm === arm);
  const right = mine.filter((row) => row.right).length;
  const looked = mine.filter((row) => row.lookups.length > 0).length;
  const gone = mine.filter((row) => row.held === "gone");
  const recovered = gone.filter((row) => row.right).length;
  console.log(`${MODEL}  ${PLANTED}  ${arm.padEnd(7)}  recall ${right}/${mine.length}  looked up ${looked}/${mine.length}  right where the summary lost it ${recovered}/${gone.length}`);
}
await resetPiRuntime();
