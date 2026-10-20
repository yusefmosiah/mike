// Continuing an answer that stopped partway, instead of starting it over.
//
// Pi Durable regenerates a failed message whole, which shows the reader the
// failed attempt's text and then the retry's from its start. Mike's runtime owns
// the retry instead (runtime.mts): when text has already been shown, the model is
// asked, in a hidden note, to carry on from the next character, and its first
// words are joined to the text the reader has (`trimOverlap`). When nothing has
// been shown, the attempt is simply made again.

import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Generations one turn may ask for, the first included. */
export const MAX_ATTEMPTS = 3;
/** The text of the answer so far that a continuation note carries. */
export const CONTINUATION_TAIL_CHARS = 1_500;
/** How much of a continuation is held back until its start can be compared with the shown text. */
export const JOIN_HOLD_CHARS = 200;
/** The shortest repeated run (whitespace collapsed) that is trimmed from a continuation's start. */
export const MIN_OVERLAP_CHARS = 12;
/** How much of the shown text a continuation's start is compared with. */
export const OVERLAP_WINDOW_CHARS = 2_000;
/** The longest wait a provider's own retry hint may ask for. */
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;

/** Tests shorten the backoff; production leaves it at 2 s, doubling. */
export const recoveryTiming = { baseDelayMs: 2_000 };

/** Why a generation ended before it finished the answer. */
export type Interruption =
  /** Failed with a transient error before any text was shown: ask again. */
  | { kind: "retry"; error: string }
  /** Failed, or was cut off by a restart, after text was shown: carry on from it. */
  | { kind: "interrupted"; error: string; written: string }
  /** Stopped at the output limit; its text is in the model's context. */
  | { kind: "length" };

export const isBrokenStop = (stopReason: string | undefined) =>
  stopReason === "error" || stopReason === "aborted" || stopReason === "length";

/**
 * Whether a failed generation is worth another attempt: pi-ai's judgement of a
 * transient provider or transport error. A context overflow is left to Pi's
 * compaction, and quota, billing and authentication errors are final.
 */
export function isRecoverableFailure(errorMessage: string): boolean {
  const failed = { role: "assistant", stopReason: "error", errorMessage } as AssistantMessage;
  return !isContextOverflow(failed) && isRetryableAssistantError(failed);
}

/**
 * The wait before recovery number `recovery` (1 for the first): 2 s, 4 s, 8 s,
 * or longer when the provider's own text says how long (a Retry-After value).
 */
export function recoveryDelayMs(recovery: number, errorMessage = ""): number {
  const backoff = Math.min(recoveryTiming.baseDelayMs * 2 ** Math.max(0, recovery - 1), MAX_BACKOFF_MS);
  return Math.max(backoff, Math.min(retryAfterMs(errorMessage) ?? 0, MAX_RETRY_AFTER_MS));
}

/** The delay a provider's error text asks for ("retry-after: 7", "try again in 1.5s"), if it says. */
export function retryAfterMs(text: string): number | undefined {
  const match =
    /retry[- ]?after(?:-ms)?["':=\s]*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?/i.exec(text) ??
    /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?/i.exec(text);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return undefined;
  return /^ms$/i.test(match[2] ?? "") || /retry[- ]?after-ms/i.test(match[0]) ? value : value * 1_000;
}

/** The note that asks for the rest of an answer cut off by an error or a restart. */
export function interruptedNote(written: string): string {
  const tail = written.slice(-CONTINUATION_TAIL_CHARS).replaceAll("</written-so-far>", "<\\/written-so-far>");
  const omitted = written.length > tail.length ? " The start of the reply is not shown here." : "";
  return `<harness>
Your reply was cut off by a connection problem. The person has already read what you had written, which is no longer in your context.${omitted} Its last part:

<written-so-far>
${tail}
</written-so-far>

Continue from the very next character, as the rest of that same reply: do not repeat anything already written, do not start over or greet again, and do not mention the interruption or this note.
</harness>`;
}

/** The note that asks for the rest of an answer that stopped at the output limit. */
export const LENGTH_NOTE = `<harness>
Your reply above stopped at the output limit, partway through. The person has already read it. Continue from the very next character, as the rest of that same reply: do not repeat anything already written, do not start over, and do not mention the limit or this note.
</harness>`;

/** The note that asks again after an attempt failed before anything was written. */
export const RETRY_NOTE = `<harness>
The last attempt to reply failed before anything was written. Reply to the person's latest message now, in full.
</harness>`;

export function noteFor(interruption: Interruption): string {
  switch (interruption.kind) {
    case "interrupted":
      return interruptedNote(interruption.written);
    case "length":
      return LENGTH_NOTE;
    case "retry":
      return RETRY_NOTE;
  }
}

/** Collapse each run of whitespace to one space, remembering where each kept character came from. */
function collapse(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (out.endsWith(" ")) continue;
      out += " ";
    } else {
      out += char;
    }
    at.push(index);
  }
  return { text: out, at };
}

/**
 * `held`, the start of a continuation, without the part that repeats the end of
 * `shown`: the longest suffix of `shown` that is also a prefix of `held`, with
 * whitespace collapsed on both sides, when it is at least MIN_OVERLAP_CHARS long.
 * Anything shorter is taken for coincidence and `held` is returned whole.
 */
export function trimOverlap(shown: string, held: string): string {
  const tail = collapse(shown.slice(-OVERLAP_WINDOW_CHARS)).text;
  const start = collapse(held);
  const longest = Math.min(tail.length, start.text.length);
  for (let length = longest; length >= MIN_OVERLAP_CHARS; length -= 1) {
    if (!tail.endsWith(start.text.slice(0, length))) continue;
    // The repeated run ends at the last of `length` collapsed characters of `held`.
    return held.slice((start.at[length - 1] ?? held.length - 1) + 1);
  }
  return held;
}
