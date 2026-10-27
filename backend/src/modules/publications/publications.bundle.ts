// What a publication serves: the files of a document version. A frozen
// publication copies them when it is made; a followed one builds them per
// request. An HTML page becomes index.html plus the files it refers to by
// relative path, found by name among the documents beside it (the same
// project, or the publisher's library); Markdown, plain text and images get a
// small page of their own, as does audio and video (with the browser's
// player); a PDF, or an Office file's PDF rendition, is served
// as itself.

import type { Db } from "../../lib/db";
import { downloadFile } from "../../lib/storage";
import {
    isAudioFileType,
    isImageFileType,
    isPresentationDocumentType,
    isVideoFileType,
    isWordDocumentType,
} from "../../lib/documentTypes";
import { contentTypeForPath, type PublicationKind } from "./publications.shared";

// linkedom ships no types for this entry point; lib/search/reader.ts reads it
// the same way.
const { parseHTML } = require("linkedom") as {
    parseHTML(html: string): { document: Document };
};

export type BundleFile = {
    path: string;
    contentType: string;
    size: number;
} & ({ storagePath: string } | { bytes: Buffer });

export type Bundle = { kind: PublicationKind; files: BundleFile[]; missing: string[] };

export type BundleSource = {
    documentId: string;
    projectId: string | null;
    userId: string;
    version: {
        storage_path: string;
        pdf_storage_path: string | null;
        filename: string | null;
        file_type: string | null;
        size_bytes: number | null;
    };
};

export type BundleResult =
    | { ok: true; title: string; bundle: Bundle }
    | { ok: false; code: "unsupported_type" | "no_rendition" | "too_large" | "unreadable" };

export const MAX_BUNDLE_FILES = 200;
// Room for a page with a few videos; each file is a server-side copy.
export const MAX_BUNDLE_BYTES = 500 * 1024 * 1024;

export type BundleShape =
    | { ok: true; title: string; kind: PublicationKind }
    | { ok: false; code: "unsupported_type" | "no_rendition" };

/**
 * What a publication of this version would be, and whether it can be one,
 * without reading or copying any file. A followed publication records its
 * kind and title with this; the files are resolved live at serve time.
 */
export function bundleShape(version: BundleSource["version"]): BundleShape {
    const fileType = (version.file_type ?? "").toLowerCase();
    const filename = version.filename?.trim() || "Untitled";
    const title = filename.replace(/\.[^.]+$/, "") || filename;
    if (fileType === "html" || fileType === "md" || fileType === "txt")
        return { ok: true, title, kind: "site" };
    if (isImageFileType(fileType) || isAudioFileType(fileType) || isVideoFileType(fileType))
        return { ok: true, title, kind: "site" };
    if (fileType === "pdf") return { ok: true, title, kind: "file" };
    if (isWordDocumentType(fileType) || isPresentationDocumentType(fileType)) {
        if (!version.pdf_storage_path) return { ok: false, code: "no_rendition" };
        return { ok: true, title, kind: "file" };
    }
    return { ok: false, code: "unsupported_type" };
}

export async function buildBundle(db: Db, source: BundleSource): Promise<BundleResult> {
    const { version } = source;
    const shape = bundleShape(version);
    if (!shape.ok) return shape;
    const fileType = (version.file_type ?? "").toLowerCase();
    const filename = version.filename?.trim() || "Untitled";
    const title = shape.title;

    if (fileType === "html") return htmlBundle(db, source, title);

    if (fileType === "md" || fileType === "txt") {
        const text = await readText(version.storage_path);
        if (text === null) return { ok: false, code: "unreadable" };
        const body =
            fileType === "md"
                ? await renderMarkdown(text)
                : `<pre>${escapeHtml(text)}</pre>`;
        return { ok: true, title, bundle: page(title, body) };
    }

    if (isImageFileType(fileType)) {
        const imagePath = safeFilename(filename);
        const bundle = page(
            title,
            `<figure><img src="${escapeHtml(encodeURI(imagePath))}" alt="${escapeHtml(title)}"></figure>`,
        );
        bundle.files.push({
            path: imagePath,
            storagePath: version.storage_path,
            contentType: contentTypeForPath(imagePath),
            size: version.size_bytes ?? 0,
        });
        return { ok: true, title, bundle };
    }

    if (isAudioFileType(fileType) || isVideoFileType(fileType)) {
        // A page with the browser's own player; the file is served beside
        // it with byte ranges, so it streams and seeks.
        const mediaPath = safeFilename(filename);
        const src = escapeHtml(encodeURI(mediaPath));
        const player = isVideoFileType(fileType)
            ? `<video controls playsinline preload="metadata" src="${src}"></video>`
            : `<audio controls preload="metadata" src="${src}"></audio>`;
        const bundle = page(
            title,
            `<figure>${player}<figcaption>${escapeHtml(title)}</figcaption></figure>`,
        );
        bundle.files.push({
            path: mediaPath,
            storagePath: version.storage_path,
            contentType: contentTypeForPath(mediaPath),
            size: version.size_bytes ?? 0,
        });
        return { ok: true, title, bundle };
    }

    if (fileType === "pdf") {
        return {
            ok: true,
            title,
            bundle: single(safeFilename(filename), version.storage_path, version.size_bytes ?? 0),
        };
    }

    if (isWordDocumentType(fileType) || isPresentationDocumentType(fileType)) {
        if (!version.pdf_storage_path) return { ok: false, code: "no_rendition" };
        return {
            ok: true,
            title,
            bundle: single(`${safeFilename(title)}.pdf`, version.pdf_storage_path, 0),
        };
    }

    return { ok: false, code: "unsupported_type" };
}

function single(path: string, storagePath: string, size: number): Bundle {
    return {
        kind: "file",
        files: [{ path, storagePath, contentType: contentTypeForPath(path), size }],
        missing: [],
    };
}

// ---------------------------------------------------------------------------
// HTML pages and the files they refer to
// ---------------------------------------------------------------------------

type Sibling = {
    storage_path: string;
    file_type: string | null;
    size_bytes: number | null;
};

async function htmlBundle(db: Db, source: BundleSource, fallbackTitle: string): Promise<BundleResult> {
    const root = await readText(source.version.storage_path);
    if (root === null) return { ok: false, code: "unreadable" };

    let siblings: Map<string, Sibling> | null = null;
    const files: BundleFile[] = [];
    const missing: string[] = [];
    const seen = new Set<string>(["index.html"]);
    let totalBytes = 0;
    const queue: { path: string; html: string }[] = [{ path: "index.html", html: root }];

    while (queue.length > 0) {
        const { path, html } = queue.shift()!;
        const bytes = Buffer.from(withEmbedReferrers(html), "utf8");
        files.push({ path, bytes, contentType: contentTypeForPath(path), size: bytes.length });
        totalBytes += bytes.length;

        for (const ref of relativeReferences(html, path)) {
            if (seen.has(ref)) continue;
            seen.add(ref);
            siblings ??= await siblingDocuments(db, source);
            const match = siblings.get(basename(ref).toLowerCase());
            if (!match) {
                missing.push(ref);
                continue;
            }
            if (files.length + queue.length >= MAX_BUNDLE_FILES) return { ok: false, code: "too_large" };
            if ((match.file_type ?? "").toLowerCase() === "html" && /\.html?$/i.test(ref)) {
                const text = await readText(match.storage_path);
                if (text === null) {
                    missing.push(ref);
                    continue;
                }
                queue.push({ path: ref, html: text });
                continue;
            }
            totalBytes += match.size_bytes ?? 0;
            files.push({
                path: ref,
                storagePath: match.storage_path,
                contentType: contentTypeForPath(ref),
                size: match.size_bytes ?? 0,
            });
        }
        if (totalBytes > MAX_BUNDLE_BYTES) return { ok: false, code: "too_large" };
    }

    const { document } = parseHTML(root);
    const title = document.querySelector("title")?.textContent?.trim() || fallbackTitle;
    return { ok: true, title: title.slice(0, 300), bundle: { kind: "site", files, missing } };
}

const REFERENCE_ATTRIBUTES: [string, string][] = [
    ["img", "src"],
    ["source", "src"],
    ["audio", "src"],
    ["video", "src"],
    ["video", "poster"],
    ["track", "src"],
    ["script", "src"],
    ["link", "href"],
    ["a", "href"],
    ["iframe", "src"],
    ["embed", "src"],
];

/**
 * The relative references in a page, resolved against the page's own path
 * inside the publication. Absolute URLs, fragments and anything that climbs
 * above the publication's root are left alone.
 */
export function relativeReferences(html: string, pagePath = "index.html"): string[] {
    const { document } = parseHTML(html);
    const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
    const refs = new Set<string>();
    for (const [tag, attr] of REFERENCE_ATTRIBUTES) {
        for (const el of Array.from(document.querySelectorAll(`${tag}[${attr}]`))) {
            const resolved = resolveReference(el.getAttribute(attr) ?? "", dir);
            if (resolved) refs.add(resolved);
        }
    }
    return [...refs];
}

function resolveReference(raw: string, dir: string): string | null {
    const value = raw.trim();
    if (!value || value.startsWith("#") || value.startsWith("//")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    let path = value.split(/[?#]/)[0];
    try {
        path = decodeURIComponent(path);
    } catch {
        return null;
    }
    const segments = (path.startsWith("/") ? path.slice(1) : dir + path).split("/");
    const out: string[] = [];
    for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            if (out.length === 0) return null;
            out.pop();
            continue;
        }
        out.push(segment);
    }
    if (out.length === 0) return null;
    return out.join("/");
}

/**
 * YouTube refuses to play an embed whose request carries no Referer, and
 * published pages send none by default. An embed gets the page's origin
 * (never its path) unless its author chose a policy.
 */
export function withEmbedReferrers(html: string): string {
    return html.replace(/<iframe\b[^>]*>/gi, (tag) =>
        /youtube(-nocookie)?\.com/i.test(tag) && !/\breferrerpolicy\s*=/i.test(tag)
            ? tag.replace(/^<iframe\b/i, '<iframe referrerpolicy="strict-origin-when-cross-origin"')
            : tag,
    );
}

/** The documents beside the page, by lowercased filename, newest first wins. */
async function siblingDocuments(db: Db, source: BundleSource): Promise<Map<string, Sibling>> {
    const query = db.from("documents").select("id, current_version_id");
    const { data: docs } = await (source.projectId
        ? query.eq("project_id", source.projectId)
        : query.eq("user_id", source.userId).is("project_id", null)
    ).order("created_at", { ascending: false });
    const versionIds = ((docs ?? []) as { id: string; current_version_id: string | null }[])
        .filter((d) => d.id !== source.documentId && d.current_version_id)
        .map((d) => d.current_version_id as string);
    const byName = new Map<string, Sibling>();
    if (versionIds.length === 0) return byName;
    const { data: versions } = await db
        .from("document_versions")
        .select("id, filename, storage_path, file_type, size_bytes")
        .in("id", versionIds)
        .is("deleted_at", null);
    const byId = new Map(
        ((versions ?? []) as (Sibling & { id: string; filename: string | null })[]).map((v) => [v.id, v]),
    );
    for (const id of versionIds) {
        const v = byId.get(id);
        if (!v?.filename || !v.storage_path) continue;
        const key = v.filename.toLowerCase();
        if (!byName.has(key)) byName.set(key, v);
    }
    return byName;
}

// ---------------------------------------------------------------------------
// Pages the service writes
// ---------------------------------------------------------------------------

const ARTICLE_STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#fbfbfd;--rule:#d2d2d7;--code:#f2f2f5}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#111113;--rule:#3a3a3c;--code:#1c1c1e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:3rem 1rem 4rem;overflow-wrap:anywhere}
h1,h2,h3{line-height:1.25}
a{color:inherit}
img,video{max-width:100%;height:auto}
audio{width:100%}
figure{margin:0;text-align:center}
pre{white-space:pre-wrap;background:var(--code);padding:1rem;border-radius:8px;font-size:15px}
code{background:var(--code);padding:.1em .3em;border-radius:4px}
pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto;margin:1.5rem 0}
th,td{border-bottom:1px solid var(--rule);padding:.5rem .75rem;text-align:left;vertical-align:top}
blockquote{margin:1.5rem 0;padding-left:1rem;border-left:3px solid var(--rule);color:var(--muted)}
hr{border:0;border-top:1px solid var(--rule);margin:2rem 0}
`;

function page(title: string, body: string): Bundle {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${ARTICLE_STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
    const bytes = Buffer.from(html, "utf8");
    return {
        kind: "site",
        files: [{ path: "index.html", bytes, contentType: contentTypeForPath("index.html"), size: bytes.length }],
        missing: [],
    };
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/** A filename safe as one path segment of a URL. */
function safeFilename(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, "-").trim();
    return cleaned || "file";
}

// marked is ESM-only; this CommonJS build reaches it with a dynamic import.
// Raw HTML in the Markdown is kept: it runs on the content origin, where an
// HTML publication could run the same.
async function renderMarkdown(text: string): Promise<string> {
    const { marked } = await import("marked");
    return marked.parse(text, { gfm: true, async: true });
}

async function readText(storagePath: string): Promise<string | null> {
    const raw = await downloadFile(storagePath);
    if (!raw) return null;
    return new TextDecoder("utf-8").decode(raw).replace(/^﻿/, "");
}
