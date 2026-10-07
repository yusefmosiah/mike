// Block ids that survive new versions of a document.
//
// A view assigns default ids (Word's w14:paraId, otherwise ordinals), and
// ordinals shift whenever paragraphs come and go. To keep the ids a reader
// already has valid, a new version inherits ids from the previous one: the
// two versions' blocks are aligned and every block that is the same block
// keeps its id. Blocks the alignment cannot place get new ids that never
// reuse an id the previous version had.

import type { Block, DocxDocument, TableBlock } from "./view";

/** Blocks that carry an addressable id, in document order: body paragraphs, tables, and their cells' paragraphs. */
export function idSlots(doc: DocxDocument): Block[] {
  const out: Block[] = [];
  const visit = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.kind === "paragraph") out.push(b);
      else if (b.kind === "table") {
        out.push(b);
        for (const row of b.rows) for (const cell of row.cells) visit(cell.blocks);
      }
    }
  };
  visit(doc.blocks);
  return out;
}

export function blockIds(doc: DocxDocument): string[] {
  return idSlots(doc).map((b) => b.id);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function tableText(t: TableBlock): string {
  return t.rows.map((r) => r.cells.map((c) => c.blocks.map((b) => (b.kind === "paragraph" ? b.text : "")).join(" ")).join(" | ")).join(" / ");
}

function signature(b: Block): string {
  if (b.kind === "paragraph") return `p|${b.cell ? "c" : ""}|${b.styleId ?? ""}|${norm(b.text)}`;
  if (b.kind === "table") return `t|${norm(tableText(b)).slice(0, 400)}`;
  return `x|${b.name}`;
}

function words(b: Block): Set<string> {
  const text = b.kind === "paragraph" ? b.text : b.kind === "table" ? tableText(b) : "";
  return new Set(norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Dice similarity of two blocks' word sets; two empty blocks are alike. */
function similarity(a: Block, b: Block): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return (2 * common) / (x.size + y.size);
}

/**
 * Align two signature sequences: common prefix and suffix, then anchors on
 * signatures unique to both sides (in increasing order), recursing between
 * anchors; small leftovers use an exact LCS. `match[j]` is the index in `a`
 * paired with `b[j]`, or -1.
 */
function align(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, match: Int32Array): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) match[b0++] = a0++;
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) match[--b1] = --a1;
  if (a0 >= a1 || b0 >= b1) return;

  const countA = new Map<string, number>();
  const posA = new Map<string, number>();
  for (let i = a0; i < a1; i++) {
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    posA.set(a[i], i);
  }
  const countB = new Map<string, number>();
  for (let j = b0; j < b1; j++) countB.set(b[j], (countB.get(b[j]) ?? 0) + 1);
  const candidates: [number, number][] = [];
  for (let j = b0; j < b1; j++) {
    if (countB.get(b[j]) === 1 && countA.get(b[j]) === 1) candidates.push([posA.get(b[j])!, j]);
  }

  if (candidates.length === 0) {
    lcs(a, b, a0, a1, b0, b1, match);
    return;
  }
  // Longest increasing subsequence of a-positions keeps the anchors in order.
  const tails: number[] = [];
  const prev = new Int32Array(candidates.length).fill(-1);
  const tailIdx: number[] = [];
  candidates.forEach(([ai], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < ai) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = ai;
    tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const anchors: [number, number][] = [];
  for (let k = tailIdx[tails.length - 1]; k !== -1; k = prev[k]) anchors.unshift(candidates[k]);

  let pa = a0;
  let pb = b0;
  for (const [ai, bj] of anchors) {
    align(a, b, pa, ai, pb, bj, match);
    match[bj] = ai;
    pa = ai + 1;
    pb = bj + 1;
  }
  align(a, b, pa, a1, pb, b1, match);
}

function lcs(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, match: Int32Array): void {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n * m > 1_000_000) return; // left to the gap pass
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[a0 + i] === b[b0 + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      match[b0 + j] = a0 + i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
}

/**
 * Ids for `next`'s blocks, inherited from `prev` (whose blocks carry the ids
 * readers have). Same block, same id; edited blocks are paired by position
 * and similarity between the unchanged ones; new blocks are named after the
 * block before them ("p12+1"), never with an id `prev` had.
 */
export function carryBlockIds(prev: DocxDocument, next: DocxDocument): string[] {
  const A = idSlots(prev);
  const B = idSlots(next);
  const sa = A.map(signature);
  const sb = B.map(signature);
  const match = new Int32Array(B.length).fill(-1);
  align(sa, sb, 0, A.length, 0, B.length, match);

  // Gaps between aligned blocks: pair the leftovers.
  const usedA = new Set<number>();
  for (const m of match) if (m >= 0) usedA.add(m);
  let j = 0;
  while (j < B.length) {
    if (match[j] >= 0) {
      j++;
      continue;
    }
    const gapStart = j;
    while (j < B.length && match[j] < 0) j++;
    const before = gapStart > 0 ? match[gapStart - 1] : -1;
    const after = j < B.length ? match[j] : A.length;
    const olds: number[] = [];
    for (let i = before + 1; i < after; i++) if (!usedA.has(i)) olds.push(i);
    const news: number[] = [];
    for (let k = gapStart; k < j; k++) news.push(k);
    const sameShape = olds.length === news.length && olds.every((i, k) => A[i].kind === B[news[k]].kind);
    if (sameShape) {
      olds.forEach((i, k) => {
        match[news[k]] = i;
        usedA.add(i);
      });
      continue;
    }
    let p = 0;
    for (const k of news) {
      for (let q = p; q < olds.length; q++) {
        const i = olds[q];
        if (A[i].kind === B[k].kind && similarity(A[i], B[k]) >= 0.5) {
          match[k] = i;
          usedA.add(i);
          p = q + 1;
          break;
        }
      }
    }
  }

  const prevIds = new Set(A.map((b) => b.id));
  const used = new Set<string>();
  const ids: string[] = new Array(B.length);
  B.forEach((_, k) => {
    if (match[k] >= 0) {
      ids[k] = A[match[k]].id;
      used.add(ids[k]);
    }
  });
  const free = (id: string) => !used.has(id) && !prevIds.has(id);
  let last = "p0";
  B.forEach((b, k) => {
    if (ids[k] !== undefined) {
      if (b.kind === "paragraph") last = ids[k];
      return;
    }
    let id: string | undefined;
    if (b.kind === "table") {
      id = free(b.id) ? b.id : undefined;
      for (let n = 1; !id; n++) if (free(`t${n}`)) id = `t${n}`;
    } else {
      // A Word paraId is kept when it is new; otherwise name after the previous block.
      if (/^[0-9A-F]{8}$/.test(b.id) && free(b.id)) id = b.id;
      const base = last.replace(/\+\d+$/, "");
      for (let n = 1; !id; n++) if (free(`${base}+${n}`)) id = `${base}+${n}`;
      last = id;
    }
    ids[k] = id;
    used.add(id);
  });
  return ids;
}

