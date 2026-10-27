// The public side of the module: find the live publication a link names,
// check a password, and find the file a path asks for. Every refusal (an
// unknown, revoked or expired link) looks the same to the caller.

import type { Db } from "../../lib/db";
import { loadActiveVersion } from "../../lib/documentVersions";
import { headFile } from "../../lib/storage";
import { buildBundle, type BundleFile } from "./publications.bundle";
import {
    PUBLICATION_COLUMNS,
    hashToken,
    memberCookieValid,
    memberCookieValue,
    signInGrantValid,
    unlockCookieValid,
    unlockCookieValue,
    verifyPassword,
    type PublicationRow,
} from "./publications.shared";

export type LivePublication = Pick<
    PublicationRow,
    | "id"
    | "kind"
    | "audience"
    | "title"
    | "password_hash"
    | "password_version"
    | "require_sign_in"
    | "document_id"
    | "created_by"
    | "follow_document"
>;

export async function findLivePublication(
    db: Db,
    token: string,
    now = Date.now(),
): Promise<LivePublication | null> {
    const { data } = await db
        .from("publications")
        .select(PUBLICATION_COLUMNS)
        .eq("token_hash", hashToken(token))
        .maybeSingle();
    const row = data as PublicationRow | null;
    if (!row || row.revoked_at) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= now) return null;
    return row;
}

export function publicationUnlocked(row: LivePublication, cookie: string | undefined): boolean {
    return row.audience === "public" || unlockCookieValid(row, cookie);
}

/** Signed-in-only links need the member cookie the app's grant set. */
export function publicationMemberOk(row: LivePublication, cookie: string | undefined): boolean {
    return !row.require_sign_in || memberCookieValid(row.id, cookie);
}

/** The member cookie for a valid grant, or null. */
export function redeemSignInGrant(row: LivePublication, grant: unknown): string | null {
    if (!row.require_sign_in || typeof grant !== "string") return null;
    return signInGrantValid(row.id, grant) ? memberCookieValue(row.id) : null;
}

/** The cookie to set when the password is right, or null. */
export async function unlockPublication(
    row: LivePublication,
    password: unknown,
): Promise<string | null> {
    if (row.audience !== "password" || !row.password_hash) return null;
    if (typeof password !== "string" || password.length === 0 || password.length > 1024) return null;
    if (!(await verifyPassword(password, row.password_hash))) return null;
    return unlockCookieValue(row);
}

export type PublicationFile = {
    path: string;
    content_type: string;
    size_bytes: number;
    /** The copied object of a frozen publication; null when `bytes` is set. */
    storage_path: string | null;
    /** A page a followed publication builds in memory. */
    bytes?: Buffer;
};

/**
 * The file a request path names. The root is index.html for a page, or the
 * one file of a single-file publication; a directory path gets its
 * index.html.
 *
 * A frozen publication reads its copied rows; a followed one builds the
 * document's current bundle per request, so edits (and the files its pages
 * refer to) are what visitors see. A followed publication whose document is
 * gone, or whose bundle no longer builds, has no file: the link 404s.
 */
export async function findPublicationFile(
    db: Db,
    row: Pick<LivePublication, "id" | "kind" | "document_id" | "created_by" | "follow_document">,
    rawPath: string,
): Promise<PublicationFile | null> {
    const path = decodePublicationPath(rawPath);
    if (path === null) return null;
    if (row.follow_document === true) return followPublicationFile(db, row, path);

    const columns = "path, storage_path, content_type, size_bytes";
    if (path === "" && row.kind === "file") {
        const { data } = await db
            .from("publication_files")
            .select(columns)
            .eq("publication_id", row.id)
            .limit(1);
        return ((data ?? []) as PublicationFile[])[0] ?? null;
    }
    const inner = path === "" || path.endsWith("/") ? `${path}index.html` : path;
    const { data } = await db
        .from("publication_files")
        .select(columns)
        .eq("publication_id", row.id)
        .eq("path", inner)
        .maybeSingle();
    return (data as PublicationFile | null) ?? null;
}

function decodePublicationPath(rawPath: string): string | null {
    let path: string;
    try {
        path = decodeURIComponent(rawPath);
    } catch {
        return null;
    }
    if (path.split("/").some((segment) => segment === "..")) return null;
    return path;
}

async function followPublicationFile(
    db: Db,
    row: Pick<LivePublication, "kind" | "document_id" | "created_by">,
    path: string,
): Promise<PublicationFile | null> {
    if (!row.document_id) return null;
    const version = await loadActiveVersion(row.document_id, db, null);
    if (!version) return null;
    const { data: document } = await db
        .from("documents")
        .select("project_id")
        .eq("id", row.document_id)
        .maybeSingle();
    const built = await buildBundle(db, {
        documentId: row.document_id,
        projectId: (document as { project_id: string | null } | null)?.project_id ?? null,
        userId: row.created_by ?? "",
        version,
    });
    if (!built.ok) return null;

    let match: BundleFile | undefined;
    if (path === "" && row.kind === "file") {
        match = built.bundle.files[0];
    } else {
        const inner = path === "" || path.endsWith("/") ? `${path}index.html` : path;
        match = built.bundle.files.find((file) => file.path === inner);
    }
    if (!match) return null;
    if ("bytes" in match) {
        return {
            path: match.path,
            content_type: match.contentType,
            size_bytes: match.bytes.length,
            storage_path: null,
            bytes: match.bytes,
        };
    }
    // A rendition's size is not recorded on the version; read it back, since
    // Range requests and Content-Length need it exact.
    const size = match.size > 0 ? match.size : ((await headFile(match.storagePath))?.size ?? 0);
    return {
        path: match.path,
        content_type: match.contentType,
        size_bytes: size,
        storage_path: match.storagePath,
    };
}
