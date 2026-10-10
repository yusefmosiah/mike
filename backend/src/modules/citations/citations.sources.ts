// Reading what a citation cites, for the verifier (citations.tasks.ts).
//
// Every read is done with the authority of the person who asked for the check,
// re-checked here; the verifier never reads more than they could. Web reads
// honour the project's egress policy and write an audit row before any byte
// leaves: a fetch whose audit row cannot be written does not happen.
import type { Db } from "../../lib/db";
import { downloadFile, extractedTextKey } from "../../lib/storage";
import { extractPdfText } from "../../lib/pdfText";
import { requiresLibreOfficeTextExtraction, documentSuffix } from "../../lib/documentTypes";
import { idSlots } from "../../lib/docx/blockIds";
import { insertAuditEvent } from "../../lib/audit";
import { assertSafeEgressUrl, EgressSecurityError } from "../../lib/search/egress";
import { stripHtmlToText } from "../../lib/search/engine";
import { docxViewForVersion, getDocument } from "../documents/documents.service";
import type { BlockOffset, CitationQuote, ResolvedSource } from "./citations.verifier";

const MAX_WEB_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const WEB_TIMEOUT_MS = 15_000;
const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "json", "html", "htm", "xml", "rtf"]);

/** A web response, reduced to what grading needs. */
export type WebResponse = { status: number; text: string; finalUrl: string };
export type WebFetch = (url: string) => Promise<WebResponse>;

export type SourceContext = {
    db: Db;
    actor: { userId: string; email: string | null };
    taskId: string;
    chatId: string;
    projectId: string | null;
    /** The project's egress policy; 'deny' means no outbound fetch at all. */
    egress: "allow" | "deny";
    fetchWeb?: WebFetch;
};

/**
 * One reader per task: each document version and URL is read once, however
 * many passages cite it.
 */
export function createSourceReader(ctx: SourceContext) {
    const cache = new Map<string, Promise<ResolvedSource>>();
    return (quote: CitationQuote): Promise<ResolvedSource> => {
        const key =
            quote.sourceKind === "web"
                ? `web:${quote.url}`
                : quote.sourceKind === "document"
                  ? `doc:${quote.documentId}:${quote.versionId}`
                  : `${quote.sourceKind}:${quote.citationRef}`;
        let pending = cache.get(key);
        if (!pending) {
            pending = readSource(ctx, quote).catch(
                (): ResolvedSource => ({
                    ok: false,
                    verdict: "unverifiable",
                    reason: "The source could not be read.",
                }),
            );
            cache.set(key, pending);
        }
        return pending;
    };
}

async function readSource(ctx: SourceContext, quote: CitationQuote): Promise<ResolvedSource> {
    if (quote.sourceKind === "document") return readDocument(ctx, quote);
    if (quote.sourceKind === "web") return readWeb(ctx, quote.url);
    return {
        ok: false,
        verdict: "unverifiable",
        reason:
            quote.sourceKind === "case"
                ? "Case-law citations are not yet re-read by the verifier."
                : "Connector citations are not yet re-read by the verifier.",
    };
}

async function readDocument(ctx: SourceContext, quote: CitationQuote): Promise<ResolvedSource> {
    if (!quote.documentId || !quote.versionId) {
        return {
            ok: false,
            verdict: "not-found",
            reason: "The citation names no document of this conversation.",
        };
    }
    const { data: version } = await ctx.db
        .from("document_versions")
        .select("id, document_id, storage_path, pdf_storage_path, file_type, filename, deleted_at")
        .eq("id", quote.versionId)
        .eq("document_id", quote.documentId)
        .maybeSingle();
    if (!version || version.deleted_at) {
        return { ok: false, verdict: "not-found", reason: "The cited document version does not exist." };
    }
    const access = await getDocument(quote.documentId, ctx.actor.userId, ctx.actor.email ?? undefined, ctx.db);
    if (!access.ok) {
        return {
            ok: false,
            verdict: "unverifiable",
            reason: "The person who asked for this check cannot read the cited document.",
        };
    }

    const fileType = ((version.file_type as string | null) ?? documentSuffix((version.filename as string | null) ?? ""))
        .toLowerCase()
        .replace(/^\./, "");
    const read = await documentText(ctx.db, {
        documentId: quote.documentId,
        versionId: quote.versionId,
        storagePath: version.storage_path as string | null,
        pdfStoragePath: version.pdf_storage_path as string | null,
        fileType,
    });
    if (!read) {
        return { ok: false, verdict: "unverifiable", reason: "The cited document's text could not be extracted." };
    }
    return {
        ok: true,
        snapshot: {
            sourceKind: "document",
            documentId: quote.documentId,
            versionId: quote.versionId,
            content: read.content,
            blockOffsets: read.blockOffsets,
        },
    };
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
        const offsets: BlockOffset[] = [];
        let content = "";
        for (const block of idSlots(view)) {
            if (block.kind !== "paragraph") continue;
            if (content) content += "\n";
            // A list number ("23.7.1", "(b)") is text a reader sees, and the
            // model's read of the document shows it, so quotes include it.
            const line = block.label && !block.isBullet ? `${block.label} ${block.text}` : block.text;
            offsets.push({ id: block.id, start: content.length, end: content.length + line.length });
            content += line;
        }
        return { content, blockOffsets: offsets };
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

async function readWeb(ctx: SourceContext, url: string | null): Promise<ResolvedSource> {
    if (!url) return { ok: false, verdict: "not-found", reason: "The citation has no URL." };
    if (ctx.egress === "deny") {
        return {
            ok: false,
            verdict: "unverifiable",
            reason: "This project does not allow the web to be contacted.",
        };
    }
    try {
        await insertAuditEvent(ctx.db, {
            userId: ctx.actor.userId,
            userEmail: ctx.actor.email,
            action: "egress.fetch",
            surface: "citation_check",
            projectId: ctx.projectId,
            chatId: ctx.chatId,
            detail: { url, purpose: "citation_check", task_id: ctx.taskId },
        });
    } catch {
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
    if (response.status < 200 || response.status >= 300) {
        return { ok: false, verdict: "unverifiable", reason: `The page answered HTTP ${response.status}.` };
    }
    return {
        ok: true,
        snapshot: { sourceKind: "web", url: response.finalUrl, content: response.text },
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
            const bytes = Buffer.from(await res.arrayBuffer());
            const body = bytes.subarray(0, MAX_WEB_BYTES).toString("utf8");
            const html = (res.headers.get("content-type") ?? "").includes("html") || /<html[\s>]/i.test(body);
            return { status: res.status, text: html ? stripHtmlToText(body) : body, finalUrl: safe.toString() };
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error("Too many redirects");
}
