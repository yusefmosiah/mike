/**
 * Automatic citation checks. Owner's direction (2026-10-10): checking runs
 * on its own, showing "Checking citations…", "when substantive changes to
 * docs relevant to citations are made", not on every edit.
 *
 * "Relevant to citations" is decided without a model: a paragraph that looks
 * like it cites something (a case, reporter, statute, neutral citation, URL,
 * "Id."/"supra", or a long quotation) is a citing paragraph, and a version's
 * fingerprint is the set of its citing paragraphs. A new version is checked
 * when that set differs from the last checked version's: a citation added,
 * removed or reworded, or the sentence that uses it changed. Edits elsewhere
 * leave the last check standing.
 *
 * Two ways in: `scheduleAutoCitationCheck` after the assistant edits a
 * document (a delayed, deduplicated job, so a turn's several edits make one
 * check of the final version), and `autoCheckCitations` when someone opens a
 * document whose current version has not been looked at.
 */
import type { Db } from "../../lib/db";
import type { DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { loadActiveVersion } from "../../lib/documentVersions";
import { failure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getDocument } from "../documents/documents.service";
import { paragraphs } from "./citations.extract";
import { cancelCitationCheck, readVersionText, startCitationCheck, type VerificationTask } from "./citations.tasks";
import { sha256 } from "./citations.verifier";

export const AUTO_CITATION_CHECK_JOB = "citations.auto_check";
/** How long after an edit the check starts, so a turn's edits collapse into one. */
const AUTO_DELAY_MS = 15_000;

const CITING = [
  /https?:\/\/\S+/i,
  // Case names: "Smith v. Jones", "R v Brown".
  /\b[A-Z][\w.&'’-]*(?: [\w.&'’-]+){0,6} v\.? [A-Z]/,
  // Reporters: 347 U.S. 483, 925 F.3d 1339, 2019 WL 123456, [2020] UKSC 5, [1990] 2 AC 605.
  /\b\d{1,4} (?:U\.S\.|S\. ?Ct\.|L\. ?Ed\.|F\.(?: ?Supp\.)?(?: ?\d(?:d|th))?|[A-Z][a-z]*\.? ?\d?d|WL|A\.C\.|Q\.B\.|K\.B\.|W\.L\.R\.|All E\.R\.) ?\d{1,6}\b/,
  /\[\d{4}\] (?:\d+ )?[A-Z][A-Za-z]{1,6} \d+/,
  // Statutes and rules.
  /§|\bU\.S\.C\.|\bC\.F\.R\.|\bStat\.\s*\d|\b(?:Section|Article|Rule|Regulation|Directive) \d+/,
  /\b(?:Id\.|Ibid\.?|supra|infra)(?=\W|$)/,
  // A quotation long enough to be quoting a source.
  /[“"][^”"]{40,}[”"]/,
];

/** Normalized texts of the paragraphs that cite something. */
export function citingParagraphs(content: string, blocks: Parameters<typeof paragraphs>[1]): string[] {
  return paragraphs(content, blocks)
    .map((paragraph) => paragraph.text)
    .filter((text) => CITING.some((pattern) => pattern.test(text)))
    .map((text) => text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** A version's citation fingerprint: the set of its citing paragraphs, hashed and sorted. */
export function citationFingerprint(content: string, blocks: Parameters<typeof paragraphs>[1]): string[] {
  return [...new Set(citingParagraphs(content, blocks).map((text) => sha256(text).slice(0, 24)))].sort();
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Fingerprints never change for a version; keep recent ones. */
const fingerprints = new Map<string, string[] | null>();

async function fingerprintOf(db: Db, documentId: string, versionId: string): Promise<string[] | null> {
  if (fingerprints.has(versionId)) return fingerprints.get(versionId)!;
  const read = await readVersionText(db, documentId, versionId);
  const value = read && read !== "gone" ? citationFingerprint(read.content, read.blockOffsets) : null;
  fingerprints.set(versionId, value);
  if (fingerprints.size > 500) fingerprints.delete(fingerprints.keys().next().value!);
  return value;
}

export type AutoCheck = {
  started: boolean;
  /** Why no check started: current version already checked, nothing cited, citations unchanged, unreadable. */
  reason: "started" | "current" | "no_citations" | "unchanged" | "unreadable";
  task: VerificationTask | null;
};

/** Check the current version if its citations changed since the last check. */
export async function autoCheckCitations(
  db: Db,
  args: { userId: string; userEmail?: string | null; documentId: string; model?: string | null },
): Promise<ServiceResult<AutoCheck>> {
  const access = await getDocument(args.documentId, args.userId, args.userEmail ?? undefined, db);
  if (!access.ok) return failure("not_found", "Document not found");
  const current = await loadActiveVersion(args.documentId, db, null);
  if (!current) return failure("not_found", "Document version not found");

  const { data: tasks } = await db
    .from("verification_tasks")
    .select("*")
    .eq("kind", "document_citation_check")
    .eq("document_id", args.documentId)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = ((tasks as VerificationTask[] | null) ?? [])[0] ?? null;
  if (latest?.document_version_id === current.id) return ok({ started: false, reason: "current", task: latest });

  const now = await fingerprintOf(db, args.documentId, current.id);
  if (now === null) return ok({ started: false, reason: "unreadable", task: latest });
  if (now.length === 0) return ok({ started: false, reason: "no_citations", task: latest });
  if (latest?.document_version_id && latest.status !== "failed" && latest.status !== "cancelled") {
    const before = await fingerprintOf(db, args.documentId, latest.document_version_id);
    if (before && sameSet(before, now)) return ok({ started: false, reason: "unchanged", task: latest });
  }
  // A check of an older version is superseded by this one.
  if (latest && (latest.status === "queued" || latest.status === "running")) {
    await cancelCitationCheck(db, { userId: args.userId, userEmail: args.userEmail ?? null, taskId: latest.id });
  }
  const started = await startCitationCheck(db, {
    userId: args.userId,
    userEmail: args.userEmail ?? null,
    documentId: args.documentId,
    versionId: current.id,
    model: args.model ?? null,
  });
  if (!started.ok) return started;
  console.info("[citations] automatic check started", { documentId: args.documentId, citingParagraphs: now.length });
  return ok({ started: true, reason: "started", task: started.data });
}

/** After an edit: check the document shortly, once, whatever further edits land meanwhile. */
export async function scheduleAutoCitationCheck(
  db: Db,
  args: { userId: string; documentId: string; model?: string | null },
): Promise<void> {
  await enqueueDbJob(db, {
    kind: AUTO_CITATION_CHECK_JOB,
    payload: { userId: args.userId, documentId: args.documentId, model: args.model ?? null },
    dedupeKey: `${AUTO_CITATION_CHECK_JOB}:${args.documentId}`,
    runAt: new Date(Date.now() + AUTO_DELAY_MS).toISOString(),
    maxAttempts: 2,
  });
}

/** Whether an automatic check is scheduled for the document but not started yet. */
export async function autoCheckPending(db: Db, documentId: string): Promise<boolean> {
  const { data } = await db
    .from("db_jobs")
    .select("id")
    .eq("dedupe_key", `${AUTO_CITATION_CHECK_JOB}:${documentId}`)
    .in("status", ["pending", "running"])
    .limit(1);
  return ((data as unknown[] | null) ?? []).length > 0;
}

export async function handleAutoCitationCheckJob(db: Db, job: DbJob): Promise<Record<string, unknown>> {
  const payload = (job.payload ?? {}) as { userId?: string; documentId?: string; model?: string | null };
  if (!payload.userId || !payload.documentId) return { outcome: "bad_payload" };
  const { data: profile } = await db.from("user_profiles").select("email").eq("user_id", payload.userId).maybeSingle();
  const result = await autoCheckCitations(db, {
    userId: payload.userId,
    userEmail: (profile?.email as string | null | undefined) ?? null,
    documentId: payload.documentId,
    model: payload.model ?? null,
  });
  return result.ok ? { outcome: result.data.reason } : { outcome: "refused" };
}
