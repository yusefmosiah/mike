// The Word-authored .docx corpus under src/__tests__/fixtures/docx (see its
// README for sources and licences).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DOCX_CORPUS_DIR = path.resolve(__dirname, "../fixtures/docx");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.toLowerCase().endsWith(".docx")) out.push(full);
  }
  return out.sort();
}

/** Every corpus file, as paths relative to the corpus root. */
export function corpusFiles(): string[] {
  return walk(DOCX_CORPUS_DIR).map((f) => path.relative(DOCX_CORPUS_DIR, f));
}

export function readCorpusFile(relative: string): Buffer {
  return readFileSync(path.join(DOCX_CORPUS_DIR, relative));
}
