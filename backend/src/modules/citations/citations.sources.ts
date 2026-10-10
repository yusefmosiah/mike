// Finding and reading what a citation cites, for the verifier (citations.tasks.ts).
//
// Every outbound request (a page, a case lookup, a web search) honours the
// project's egress policy and writes an audit row before any byte leaves: a
// request whose audit row cannot be written does not happen. Reading the
// checked document itself re-checks the asking person's authority.
import type { Db } from "../../lib/db";
import { downloadFile, extractedTextKey } from "../../lib/storage";
import { extractPdfText } from "../../lib/pdfText";
import { requiresLibreOfficeTextExtraction } from "../../lib/documentTypes";
import { docxReadingText } from "../../lib/docx/readingText";
import { insertAuditEvent } from "../../lib/audit";
import { assertSafeEgressUrl, EgressSecurityError } from "../../lib/search/egress";
import { search, stripHtmlToText } from "../../lib/search/engine";
import { getCourtlistenerCaseOpinions, verifyCourtlistenerCitations } from "../../lib/courtlistener";
import { docxViewForVersion } from "../documents/documents.service";
import type { ExtractedCitation } from "./citations.extract";
import type { BlockOffset, SnapshotInput } from "./citations.verifier";

const MAX_WEB_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const WEB_TIMEOUT_MS = 15_000;
const CASE_TEXT_CHARS = 50_000;
const SEARCH_CANDIDATES = 2;
const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "json", "html", "htm", "xml", "rtf"]);

/** A web response, reduced to what grading needs. */
export type WebResponse = { status: number; text: string; finalUrl: string };
export type WebFetch = (url: string) => Promise<WebResponse>;
export type WebSearch = (query: string) => Promise<Array<{ url: string; title: string }>>;
export type CaseLookup = (
    citation: string,
) => Promise<
    | { status: "found"; url: string; caseName: string | null; text: string }
    | { status: "not-found" }
    | { status: "error"; reason: string }
>;

export type SourceContext = {
    db: Db;
    actor: { userId: string; email: string | null };
    taskId: string;
    projectId: string | null;
    documentId: string;
    /** The project's egress policy; 'deny' means no outbound request at all. */
    egress: "allow" | "deny";
    courtlistenerToken?: string | null;
    fetchWeb?: WebFetch;
    searchWeb?: WebSearch;
    lookupCase?: CaseLookup;
};

/** A source text worth judging, and how to label it. */
export type Candidate = { snapshot: SnapshotInput; label: string };

/** Where a citation's source was looked for, and what was found. */
export type Located =
    | { ok: true; candidates: Candidate[]; searched: boolean }
    | { ok: false; verdict: "not-found" | "unverifiable"; reason: string };

/**
 * Find the source a citation names: its URL if it gives one; a case through
 * CourtListener, falling back to a web search (CourtListener is mostly US
 * law); anything else through a web search, whose top results are only
 * candidates the judge must recognise as the cited authority.
 */
export async function locateSource(ctx: SourceContext, citation: ExtractedCitation): Promise<Located> {
    if (ctx.egress === "deny") {
        return { ok: false, verdict: "unverifiable", reason: "This project does not allow the web to be contacted." };
    }
    if (citation.url) {
        const read = await readWeb(ctx, citation.url, "citation_check");
        return read.ok ? { ok: true, candidates: [read.candidate], searched: false } : read;
    }
    if (citation.kind === "case") {
        const found = await lookupCase(ctx, citation.citation);
        if (found.status === "found") {
            return {
                ok: true,
                searched: false,
                candidates: [
                    {
                        label: `court opinion${found.caseName ? `, ${found.caseName}` : ""}, ${found.url}`,
                        snapshot: { sourceKind: "case", url: found.url, content: found.text },
                    },
                ],
            };
        }
    }
    const candidates = await searchCandidates(ctx, citation.citation);
    if (candidates.length) return { ok: true, candidates, searched: true };
    return citation.kind === "case"
        ? { ok: false, verdict: "not-found", reason: "No such case was found in CourtListener or by a web search." }
        : { ok: false, verdict: "unverifiable", reason: "The source could not be located." };
}

async function audited(ctx: SourceContext, detail: Record<string, unknown>): Promise<boolean> {
    try {
        await insertAuditEvent(ctx.db, {
            userId: ctx.actor.userId,
            userEmail: ctx.actor.email,
            action: "egress.fetch",
            surface: "citation_check",
            projectId: ctx.projectId,
            documentId: ctx.documentId,
            detail: { ...detail, purpose: "citation_check", task_id: ctx.taskId },
        });
        return true;
    } catch {
        return false;
    }
}

async function lookupCase(ctx: SourceContext, citation: string): ReturnType<CaseLookup> {
    if (!(await audited(ctx, { url: "https://www.courtlistener.com/", citation }))) {
        return { status: "error", reason: "not audited" };
    }
    try {
        return await (ctx.lookupCase ?? courtlistenerLookup(ctx))(citation);
    } catch {
        return { status: "error", reason: "lookup failed" };
    }
}

function courtlistenerLookup(ctx: SourceContext): CaseLookup {
    return async (citation) => {
        const lookup = (await verifyCourtlistenerCitations({
            citations: [citation],
            db: ctx.db,
            apiToken: ctx.courtlistenerToken,
        })) as { results?: Array<{ status: string; clusters: Array<{ id: number | null; caseName: string | null }> }> };
        const cluster = (lookup.results ?? []).flatMap((row) => row.clusters).find((c) => c.id);
        if (!cluster?.id) return { status: "not-found" };
        const opinions = (await getCourtlistenerCaseOpinions({
            clusterId: cluster.id,
            includeFullText: true,
            maxChars: CASE_TEXT_CHARS,
            db: ctx.db,
            apiToken: ctx.courtlistenerToken,
        })) as { url?: string | null; opinions?: Array<{ text?: string | null }>; error?: string };
        const text = (opinions.opinions ?? []).map((o) => o.text ?? "").join("\n\n").trim();
        if (!text) return { status: "error", reason: "no opinion text" };
        return {
            status: "found",
            url: opinions.url ?? `https://www.courtlistener.com/opinion/${cluster.id}/`,
            caseName: cluster.caseName,
            text,
        };
    };
}

async function searchCandidates(ctx: SourceContext, query: string): Promise<Candidate[]> {
    if (!(await audited(ctx, { url: "web-search", query }))) return [];
    let results: Array<{ url: string; title: string }>;
    try {
        results = await (ctx.searchWeb ?? ((q: string) => search(q, { limit: 5 })))(query);
    } catch {
        return [];
    }
    const candidates: Candidate[] = [];
    for (const result of results) {
        if (candidates.length >= SEARCH_CANDIDATES) break;
        const read = await readWeb(ctx, result.url, "citation_check_search");
        if (read.ok) candidates.push({ ...read.candidate, label: `web search result "${result.title}", ${result.url}` });
    }
    return candidates;
}

/** A version's text; a .docx also yields its block ids and their offsets. */
export async function documentText(
    db: Db,
    args: {
        documentId: string;
        versionId: string;
        storagePath: string | null;
        pdfStoragePath: string | null;
        fileType: string;
    },
): Promise<{ content: string; blockOffsets: BlockOffset[] | null } | null> {
    if (requiresLibreOfficeTextExtraction(args.fileType)) {
        const cached = await downloadFile(extractedTextKey(args.versionId));
        return cached ? { content: Buffer.from(cached).toString("utf8"), blockOffsets: null } : null;
    }
    if (!args.storagePath) return null;
    const raw = await downloadFile(args.storagePath);
    if (!raw) return null;
    if (args.fileType === "docx") {
        const view = await docxViewForVersion(db, args.documentId, args.versionId, Buffer.from(raw));
        const { content, blocks } = docxReadingText(view);
        return { content, blockOffsets: blocks };
    }
    if (args.fileType === "pdf") {
        return { content: await extractPdfText(raw), blockOffsets: null };
    }
    if (args.pdfStoragePath) {
        const pdf = await downloadFile(args.pdfStoragePath);
        if (pdf) return { content: await extractPdfText(pdf), blockOffsets: null };
    }
    if (TEXT_TYPES.has(args.fileType)) {
        const body = Buffer.from(raw).toString("utf8");
        return { content: args.fileType.startsWith("htm") ? stripHtmlToText(body) : body, blockOffsets: null };
    }
    return null;
}

async function readWeb(
    ctx: SourceContext,
    url: string,
    purpose: string,
): Promise<{ ok: true; candidate: Candidate } | { ok: false; verdict: "not-found" | "unverifiable"; reason: string }> {
    if (!(await audited(ctx, { url, step: purpose }))) {
        return { ok: false, verdict: "unverifiable", reason: "The fetch could not be audited, so it was not made." };
    }
    let response: WebResponse;
    try {
        response = await (ctx.fetchWeb ?? fetchWebPage)(url);
    } catch (error) {
        return {
            ok: false,
            verdict: "unverifiable",
            reason:
                error instanceof EgressSecurityError
                    ? "The address is not allowed to be contacted."
                    : "The page could not be reached.",
        };
    }
    if (response.status === 404 || response.status === 410) {
        return { ok: false, verdict: "not-found", reason: `The page does not exist (HTTP ${response.status}).` };
    }
    if (response.status < 200 || response.status >= 300 || !response.text.trim()) {
        return { ok: false, verdict: "unverifiable", reason: `The page answered HTTP ${response.status}.` };
    }
    return {
        ok: true,
        candidate: { label: `web page ${response.finalUrl}`, snapshot: { sourceKind: "web", url: response.finalUrl, content: response.text } },
    };
}

/**
 * GET a page under the search egress policy, re-checking every redirect hop
 * (a redirect must not reach an address the first URL could not), with a
 * size cap. HTML is reduced to its readable text.
 */
export async function fetchWebPage(rawUrl: string): Promise<WebResponse> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const safe = await assertSafeEgressUrl(current);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
        try {
            const res = await fetch(safe.toString(), {
                redirect: "manual",
                signal: controller.signal,
                headers: {
                    "User-Agent": "MikeLegalAssistant/1.0 citation-check",
                    Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.8",
                },
            });
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                await res.body?.cancel().catch(() => {});
                current = new URL(location, safe).toString();
                continue;
            }
            const bytes = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_WEB_BYTES);
            const type = res.headers.get("content-type") ?? "";
            if (type.includes("pdf") || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
                // Court opinions and statutes are often PDFs; their bytes read
                // as text are noise a judge cannot quote.
                const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                return { status: res.status, text: await extractPdfText(buffer), finalUrl: safe.toString() };
            }
            const body = bytes.toString("utf8");
            const html = type.includes("html") || /<html[\s>]/i.test(body);
            return { status: res.status, text: html ? stripHtmlToText(body) : body, finalUrl: safe.toString() };
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error("Too many redirects");
}
