// Deterministic extractive fallback for text-only models: no LLM call, no
// randomness, so the same history always produces byte-identical output.
//
// The summary keeps the anchors a resumed conversation needs — the original
// request verbatim, the first line of every later user request, error and
// recovery notes, active document handles — and spends whatever budget is
// left on the newest turns verbatim.

import {
  looksLikeErrorOrRecovery,
  MAX_SUMMARY_TOKENS,
  type CompactTurn,
} from "./policy";

const CHARS_PER_TOKEN = 4;
const FIRST_LINE_CAP = 200;
const MAX_USER_LINES = 30;
const MAX_ERROR_LINES = 20;
const MAX_DOC_IDS = 50;
const PREFIX_RESERVE = 96;
const TAIL_HEADER = "RECENT TURNS (VERBATIM)";
const DOC_ID_RE = /\bdoc-[a-z0-9]+\b/gi;

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.length > FIRST_LINE_CAP
      ? `${trimmed.slice(0, FIRST_LINE_CAP)}...`
      : trimmed;
  }
  return "";
}

function bulletLines(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

export function summarizeToText(
  turns: readonly CompactTurn[],
  budget: number = MAX_SUMMARY_TOKENS,
): string {
  const charBudget = Math.max(0, Math.floor(budget * CHARS_PER_TOKEN));
  if (charBudget === 0) return "";
  const sections: string[] = [];
  let spent = PREFIX_RESERVE;
  const add = (section: string): void => {
    const cost = section.length + 2;
    if (spent + cost > charBudget) return;
    sections.push(section);
    spent += cost;
  };

  const firstUserAt = turns.findIndex((turn) => turn.role === "user");
  if (firstUserAt >= 0) {
    const requestCap = Math.max(200, Math.floor(charBudget * 0.25));
    const body = turns[firstUserAt].text.trim();
    add(
      `ORIGINAL REQUEST\n${
        body.length > requestCap
          ? `${body.slice(0, requestCap)}\n[...truncated]`
          : body
      }`,
    );
  }

  const userLines: string[] = [];
  for (
    let index = firstUserAt + 1;
    index < turns.length && userLines.length < MAX_USER_LINES;
    index++
  ) {
    if (turns[index].role !== "user") continue;
    const line = firstLine(turns[index].text);
    if (line) userLines.push(line);
  }
  if (userLines.length > 0) {
    add(`LATER USER REQUESTS (FIRST LINES)\n${bulletLines(userLines)}`);
  }

  const errorLines: string[] = [];
  for (const turn of turns) {
    if (errorLines.length >= MAX_ERROR_LINES) break;
    if (!looksLikeErrorOrRecovery(turn.text)) continue;
    const line = firstLine(turn.text);
    if (line) errorLines.push(line);
  }
  if (errorLines.length > 0) {
    add(`ERRORS AND RECOVERY\n${bulletLines(errorLines)}`);
  }

  const docIds: string[] = [];
  const seenDocIds = new Set<string>();
  for (const turn of turns) {
    for (const raw of turn.text.match(DOC_ID_RE) ?? []) {
      const id = raw.toLowerCase();
      if (seenDocIds.has(id) || docIds.length >= MAX_DOC_IDS) continue;
      seenDocIds.add(id);
      docIds.push(id);
    }
  }
  if (docIds.length > 0) add(`ACTIVE DOCUMENTS\n${docIds.join(", ")}`);

  // Newest turns fill whatever budget is left, verbatim. A lone oversized
  // newest turn is truncated rather than dropped.
  let remaining = charBudget - spent - TAIL_HEADER.length - 2;
  const tail: string[] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const entry = `--- [${turn.role}] ---\n${turn.text}\n`;
    if (entry.length > remaining) break;
    tail.unshift(entry);
    remaining -= entry.length;
  }
  let kept = tail.length;
  if (kept === 0 && turns.length > 0) {
    const last = turns[turns.length - 1];
    const header = `--- [${last.role}] ---\n[...truncated]\n`;
    const room = Math.max(0, charBudget - spent - TAIL_HEADER.length - header.length - 4);
    if (room > 0) {
      tail.push(`${header}${last.text.slice(0, room)}\n`);
      kept = 1;
    }
  }
  if (kept > 0) sections.push(`${TAIL_HEADER}\n${tail.join("\n")}`);

  const dropped = Math.max(0, turns.length - kept);
  const prefix = `[Context compacted: ${dropped} older turns summarized, ${kept} recent turns verbatim]`;
  const result = [prefix, ...sections].join("\n\n");
  // The construction above stays inside the budget; this guards the
  // degenerate case where even the prefix does not fit.
  return result.length > charBudget ? result.slice(0, charBudget) : result;
}
