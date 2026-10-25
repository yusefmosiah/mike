// Making, listing and revoking publications: the signed-in side of the
// module. Publishing needs the document's owner role (access.manage) because
// a link reaches people the document's own sharing never named.

import crypto from "node:crypto";
import type { Db } from "../../lib/db";
import { recordAudit } from "../../lib/audit";
import { loadActiveVersion } from "../../lib/documentVersions";
import { can } from "../../lib/permissions";
import { copyFile, deleteFilesBestEffort, headFile, uploadFile } from "../../lib/storage";
import { internalFailure, type ServiceResult } from "../../lib/serviceResult";
import { ensureDocumentAccess } from "../documents/documents.service";
import { buildBundle } from "./publications.bundle";
import {
    EXPIRY_DAYS,
    MIN_PASSWORD_LENGTH,
    PUBLICATION_COLUMNS,
    hashPassword,
    hashToken,
    newToken,
    publicationUrl,
    publishingConfig,
    safeInnerPath,
    sealToken,
    signInGrant,
    unsealToken,
    type PublicationAudience,
    type PublicationKind,
    type PublicationRow,
    type PublishingConfig,
} from "./publications.shared";

export type PublicationView = {
    id: string;
    document_id: string | null;
    version_id: string | null;
    title: string;
    kind: PublicationKind;
    audience: PublicationAudience;
    require_sign_in: boolean;
    url: string | null;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    file_count: number;
};

export type PublishingConfigView = {
    enabled: boolean;
    audiences: PublicationAudience[];
    reason?: "off" | "strict_private" | "no_content_origin" | "no_secret";
};

export function publishingConfigView(env: NodeJS.ProcessEnv = process.env): PublishingConfigView {
    const config = publishingConfig(env);
    if (config.enabled) return { enabled: true, audiences: config.audiences };
    return { enabled: false, audiences: [], reason: config.reason };
}

export type PublishFailure =
    | "publishing_off"
    | "password_too_short"
    | "bad_audience"
    | "bad_expiry"
    | "not_found"
    | "not_owner"
    | "unsupported_type"
    | "no_rendition"
    | "too_large"
    | "unreadable";

export type CreatePublicationInput = {
    userId: string;
    userEmail?: string;
    documentId: string;
    versionId?: string | null;
    audience: unknown;
    password?: unknown;
    requireSignIn?: unknown;
    expiresInDays?: unknown;
};

export async function createPublication(
    db: Db,
    input: CreatePublicationInput,
    env: NodeJS.ProcessEnv = process.env,
): Promise<
    | { ok: true; publication: PublicationView; missingFiles: string[] }
    | { ok: false; code: PublishFailure }
    | { ok: false; code: "error"; error: unknown }
> {
    const config = publishingConfig(env);
    if (!config.enabled) return { ok: false, code: "publishing_off" };

    const audience = input.audience;
    if (audience !== "public" && audience !== "password") return { ok: false, code: "bad_audience" };
    if (!config.audiences.includes(audience)) return { ok: false, code: "publishing_off" };
    let password: string | null = null;
    if (audience === "password") {
        if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH)
            return { ok: false, code: "password_too_short" };
        password = input.password;
    }
    const expiresInDays = input.expiresInDays ?? null;
    if (expiresInDays !== null && !EXPIRY_DAYS.includes(expiresInDays as (typeof EXPIRY_DAYS)[number]))
        return { ok: false, code: "bad_expiry" };

    const access = await ensureDocumentAccess(input.documentId, input.userId, input.userEmail, db);
    if (!access.ok) return { ok: false, code: "not_found" };
    if (!can(access.projectRole, "access.manage")) return { ok: false, code: "not_owner" };
    const version = await loadActiveVersion(input.documentId, db, input.versionId ?? null);
    if (!version) return { ok: false, code: "not_found" };

    const built = await buildBundle(db, {
        documentId: input.documentId,
        projectId: access.doc.project_id ?? null,
        userId: input.userId,
        version,
    });
    if (!built.ok) return { ok: false, code: built.code };

    const id = crypto.randomUUID();
    const token = newToken();
    const copied: string[] = [];
    try {
        const files = [];
        for (const file of built.bundle.files) {
            const storagePath = `publications/${id}/${file.path}`;
            if ("bytes" in file) {
                await uploadFile(
                    storagePath,
                    file.bytes.buffer.slice(
                        file.bytes.byteOffset,
                        file.bytes.byteOffset + file.bytes.byteLength,
                    ) as ArrayBuffer,
                    file.contentType,
                );
            } else {
                await copyFile(file.storagePath, storagePath);
            }
            copied.push(storagePath);
            // A copy's size is read back: a rendition's is not recorded
            // anywhere else, and Range requests need it exact.
            const size = "bytes" in file ? file.size : ((await headFile(storagePath))?.size ?? file.size);
            files.push({
                publication_id: id,
                path: file.path,
                storage_path: storagePath,
                content_type: file.contentType,
                size_bytes: size,
            });
        }

        const expiresAt =
            expiresInDays === null
                ? null
                : new Date(Date.now() + (expiresInDays as number) * 86_400_000).toISOString();
        const { data: row, error } = await db
            .from("publications")
            .insert({
                id,
                created_by: input.userId,
                document_id: input.documentId,
                version_id: version.id,
                kind: built.bundle.kind,
                audience,
                token_hash: hashToken(token),
                token_sealed: sealToken(token),
                password_hash: password ? await hashPassword(password) : null,
                require_sign_in: input.requireSignIn === true,
                title: built.title,
                expires_at: expiresAt,
            })
            .select(PUBLICATION_COLUMNS)
            .single();
        if (error || !row) throw error ?? new Error("publication insert returned no row");
        const { error: filesError } = await db.from("publication_files").insert(files);
        if (filesError) {
            await db.from("publications").delete().eq("id", id);
            throw filesError;
        }

        void recordAudit(db, {
            userId: input.userId,
            userEmail: input.userEmail ?? null,
            action: "publication.created",
            title: built.title,
            documentId: input.documentId,
            projectId: access.doc.project_id ?? null,
            detail: {
                publication_id: id,
                audience,
                require_sign_in: input.requireSignIn === true,
                expires_at: expiresAt,
                files: files.length,
            },
        });
        return {
            ok: true,
            publication: toView(row as PublicationRow, config, files.length),
            missingFiles: built.bundle.missing,
        };
    } catch (error) {
        deleteFilesBestEffort(copied, "publications/create-rollback");
        return { ok: false, code: "error", error };
    }
}

export async function listPublications(
    db: Db,
    userId: string,
    documentId: string | null,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceResult<PublicationView[]>> {
    let query = db.from("publications").select(PUBLICATION_COLUMNS).eq("created_by", userId);
    if (documentId) query = query.eq("document_id", documentId);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) return internalFailure(error);
    const rows = (data ?? []) as PublicationRow[];
    const counts = new Map<string, number>();
    if (rows.length > 0) {
        const { data: files } = await db
            .from("publication_files")
            .select("publication_id")
            .in("publication_id", rows.map((r) => r.id));
        for (const f of (files ?? []) as { publication_id: string }[])
            counts.set(f.publication_id, (counts.get(f.publication_id) ?? 0) + 1);
    }
    const config = publishingConfig(env);
    return { ok: true, data: rows.map((r) => toView(r, config, counts.get(r.id) ?? 0)) };
}

/** Only the publisher revokes; the copied files are deleted with the link. */
export async function revokePublication(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    publicationId: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; publication: PublicationView } | { ok: false; code: "not_found" } | { ok: false; code: "error"; error: unknown }> {
    const { data: existing } = await db
        .from("publications")
        .select(PUBLICATION_COLUMNS)
        .eq("id", publicationId)
        .eq("created_by", userId)
        .maybeSingle();
    if (!existing) return { ok: false, code: "not_found" };
    const row = existing as PublicationRow;
    const config = publishingConfig(env);
    if (row.revoked_at) return { ok: true, publication: toView(row, config, 0) };

    const { data: updated, error } = await db
        .from("publications")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", publicationId)
        .select(PUBLICATION_COLUMNS)
        .single();
    if (error || !updated) return { ok: false, code: "error", error };

    const { data: files } = await db
        .from("publication_files")
        .select("storage_path")
        .eq("publication_id", publicationId);
    const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path);
    await db.from("publication_files").delete().eq("publication_id", publicationId);
    deleteFilesBestEffort(paths, "publications/revoke");

    void recordAudit(db, {
        userId,
        userEmail: userEmail ?? null,
        action: "publication.revoked",
        title: row.title,
        documentId: row.document_id,
        detail: { publication_id: publicationId },
    });
    return { ok: true, publication: toView(updated as PublicationRow, config, 0) };
}

function toView(row: PublicationRow, config: PublishingConfig, fileCount: number): PublicationView {
    const token = config.enabled && !row.revoked_at ? unsealToken(row.token_sealed) : null;
    return {
        id: row.id,
        document_id: row.document_id,
        version_id: row.version_id,
        title: row.title,
        kind: row.kind,
        audience: row.audience,
        require_sign_in: row.require_sign_in === true,
        url: config.enabled && token ? publicationUrl(config, token) : null,
        created_at: row.created_at,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        file_count: fileCount,
    };
}

/**
 * The publisher's own live publication, for the chat to tell the assistant
 * where it went; null when it is not theirs, not live, or not of that document.
 */
export async function describeOwnPublication(
    db: Db,
    userId: string,
    publicationId: string,
    documentId: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<PublicationView | null> {
    const { data } = await db
        .from("publications")
        .select(PUBLICATION_COLUMNS)
        .eq("id", publicationId)
        .eq("created_by", userId)
        .maybeSingle();
    const row = data as PublicationRow | null;
    if (!row || row.document_id !== documentId || row.revoked_at) return null;
    const view = toView(row, publishingConfig(env), 0);
    return view.url ? view : null;
}

/**
 * A signed-in visitor asks to open a signed-in-only link. They may when the
 * link is live and they can open its document in the app; the answer is the
 * link's grant address, which sets the member cookie on its origin.
 */
export async function grantPublicationAccess(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    publicationId: string,
    path: unknown,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; url: string } | { ok: false }> {
    const config = publishingConfig(env);
    if (!config.enabled) return { ok: false };
    const { data } = await db
        .from("publications")
        .select(PUBLICATION_COLUMNS)
        .eq("id", publicationId)
        .maybeSingle();
    const row = data as PublicationRow | null;
    if (!row || row.revoked_at || !row.require_sign_in || !row.document_id) return { ok: false };
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { ok: false };
    const access = await ensureDocumentAccess(row.document_id, userId, userEmail, db);
    if (!access.ok) return { ok: false };
    const token = unsealToken(row.token_sealed);
    if (!token) return { ok: false };
    const query = new URLSearchParams({ g: signInGrant(row.id) });
    const inner = safeInnerPath(path);
    if (inner) query.set("r", inner);
    return { ok: true, url: `${publicationUrl(config, token)}__grant?${query.toString()}` };
}

export type PublishPreflight =
    | { ok: true; documentId: string; versionId: string; filename: string }
    | { ok: false; code: "publishing_off" | "not_found" | "not_owner" | "unsupported_type" | "no_rendition" };

const PUBLISHABLE = new Set(["html", "md", "txt", "pdf", "png", "jpg", "jpeg", "webp", "gif", "docx", "doc", "pptx", "ppt"]);
const NEEDS_RENDITION = new Set(["docx", "doc", "pptx", "ppt"]);

/**
 * Whether the caller could publish this version, checked before the
 * assistant asks them to: the same rules createPublication applies.
 */
export async function publishPreflight(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    documentId: string,
    versionId: string | null,
    env: NodeJS.ProcessEnv = process.env,
): Promise<PublishPreflight> {
    if (!publishingConfig(env).enabled) return { ok: false, code: "publishing_off" };
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, code: "not_found" };
    if (!can(access.projectRole, "access.manage")) return { ok: false, code: "not_owner" };
    const version = await loadActiveVersion(documentId, db, versionId);
    if (!version) return { ok: false, code: "not_found" };
    const type = (version.file_type ?? "").toLowerCase();
    if (!PUBLISHABLE.has(type)) return { ok: false, code: "unsupported_type" };
    if (NEEDS_RENDITION.has(type) && !version.pdf_storage_path) return { ok: false, code: "no_rendition" };
    return { ok: true, documentId, versionId: version.id, filename: version.filename ?? "Untitled" };
}
