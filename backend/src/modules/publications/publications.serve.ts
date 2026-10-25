// The public side of the module: find the live publication a link names,
// check a password, and find the file a path asks for. Every refusal (an
// unknown, revoked or expired link) looks the same to the caller.

import type { Db } from "../../lib/db";
import {
    PUBLICATION_COLUMNS,
    hashToken,
    unlockCookieValid,
    unlockCookieValue,
    verifyPassword,
    type PublicationRow,
} from "./publications.shared";

export type LivePublication = Pick<
    PublicationRow,
    "id" | "kind" | "audience" | "title" | "password_hash" | "password_version"
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
    storage_path: string;
    content_type: string;
    size_bytes: number;
};

/**
 * The file a request path names. The root is index.html for a page, or the
 * one file of a single-file publication; a directory path gets its
 * index.html.
 */
export async function findPublicationFile(
    db: Db,
    row: Pick<LivePublication, "id" | "kind">,
    rawPath: string,
): Promise<PublicationFile | null> {
    let path: string;
    try {
        path = decodeURIComponent(rawPath);
    } catch {
        return null;
    }
    if (path.split("/").some((segment) => segment === "..")) return null;
    const columns = "path, storage_path, content_type, size_bytes";
    if (path === "" && row.kind === "file") {
        const { data } = await db
            .from("publication_files")
            .select(columns)
            .eq("publication_id", row.id)
            .limit(1);
        return ((data ?? []) as PublicationFile[])[0] ?? null;
    }
    if (path === "" || path.endsWith("/")) path += "index.html";
    const { data } = await db
        .from("publication_files")
        .select(columns)
        .eq("publication_id", row.id)
        .eq("path", path)
        .maybeSingle();
    return (data as PublicationFile | null) ?? null;
}
