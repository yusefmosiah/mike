// The check an edited .docx must pass before it becomes a version.
//
// Every XML part must scan, the document must load as a view, and the
// linter may report no error the original did not already have, so an
// untidy original never blocks an edit but an edit never makes it worse.

import { lintDocx, type LintIssue } from "../docxLinter";
import { DocxPackage } from "./package";
import { DocxDocument } from "./view";
import { scanXml } from "./xmlSource";

export type GateResult = { ok: true } | { ok: false; problems: string[] };

export async function checkEditedDocx(original: Buffer, edited: Buffer): Promise<GateResult> {
  const problems: string[] = [];
  try {
    const pkg = await DocxPackage.load(edited);
    for (const part of pkg.partNames()) {
      if (/\.(xml|rels)$/i.test(part)) scanXml(pkg.text(part)!);
    }
    DocxDocument.fromPackage(pkg);
  } catch (err) {
    problems.push(`The edited document does not load: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, problems };
  }
  const key = (i: LintIssue) => `${i.category}:${i.message}`;
  const before = new Map<string, number>();
  for (const i of (await lintDocx(original)).issues) {
    if (i.severity === "error") before.set(key(i), (before.get(key(i)) ?? 0) + 1);
  }
  for (const i of (await lintDocx(edited)).issues) {
    if (i.severity !== "error") continue;
    const left = before.get(key(i)) ?? 0;
    if (left > 0) before.set(key(i), left - 1);
    else problems.push(i.message);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
