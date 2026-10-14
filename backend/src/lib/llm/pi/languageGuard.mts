// The answer-language check: an answer in another writing system than the
// person's message is caught after the fact and written again. Models drift
// (GLM-5.3 slid into Chinese mid-answer in long English threads) even with the
// response-language rule in the system prompt.
import { dominantScript, scriptOf } from "./compaction.mjs";

/** Answers shorter than this, in letters, are not judged: too little to tell. */
const MIN_LETTERS = 120;
/** The share of an answer's text in another script that counts as drift. */
const DRIFT_SHARE = 0.25;
/** One CJK character carries about as much text as three Latin letters. */
const CJK_WEIGHT = 3;

/** What is the answer's own prose: code and quoted lines may be in any language. */
function prose(answer: string): string {
  return answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .replace(/https?:\/\/\S+/g, " ");
}

/**
 * True when a large share of the answer is in another writing system than the
 * person's message. Unknown (no letters in the message, a short answer) is false.
 */
export function answerLanguageDrift(person: string, answer: string): boolean {
  const want = dominantScript(person);
  if (!want) return false;
  let total = 0;
  let foreign = 0;
  for (const char of prose(answer)) {
    const script = scriptOf(char);
    if (!script) continue;
    const weight = script === "cjk" ? CJK_WEIGHT : 1;
    total += weight;
    if (script !== want) foreign += weight;
  }
  return total >= MIN_LETTERS && foreign / total >= DRIFT_SHARE;
}

/** The note that asks for the answer again, sent as the next input of the same turn. */
export const LANGUAGE_DRIFT_NOTE = `<harness>
The answer above is not in the language of the person's latest message. Unless the person asked for that language, write the whole answer again now, in their language, as your complete reply. If they did ask for it, reply with one short sentence in their language saying so.
</harness>`;
