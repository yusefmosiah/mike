// Making, listing, editing and revoking publications: the signed-in side of
// the module. Publishing needs the document's owner role (access.manage)
// because a link reaches people the document's own sharing never named.

import crypto from "node:crypto";
import type { Db } from "../../lib/db";
import { recordAudit } from "../../lib/audit";
import { loadActiveVersion } from "../../lib/documentVersions";
import { can } from "../../lib/permissions";
import { copyFile, deleteFilesBestEffort, headFile, uploadFile } from "../../lib/storage";
import { internalFailure, type ServiceResult } from "../../lib/serviceResult";
import { ensureDocumentAccess } from "../documents/documents.service";
import { buildBundle, bundleShape, type Bundle } from "./publications.bundle";
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
    follow_document: boolean;
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
    | "revoked"
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
    followDocument?: unknown;
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

    const access = await ensureDocumentAccess(input.documentId, input.userId, input.userEmail, db, {
        select: "id, user_id, project_id, org_id, workflow_id",
    });
    if (!access.ok) return { ok: false, code: "not_found" };
    if (!can(access.projectRole, "access.manage")) return { ok: false, code: "not_owner" };
    const version = await loadActiveVersion(input.documentId, db, input.versionId ?? null);
    if (!version) return { ok: false, code: "not_found" };

    // New publications follow the document unless the caller asks for a
    // frozen copy. Existing rows stay frozen at the version they copied.
    const follow = input.followDocument !== false;
    const projectId = access.doc.project_id ?? null;
    let kind: PublicationKind;
    let title: string;
    let missingFiles: string[] = [];
    let bundle: Bundle | null = null;
    if (follow) {
        const shape = bundleShape(version);
        if (!shape.ok) return { ok: false, code: shape.code };
        kind = shape.kind;
        title = shape.title;
    } else {
        const built = await buildBundle(db, {
            documentId: input.documentId,
            projectId,
            userId: input.userId,
            version,
        });
        if (!built.ok) return { ok: false, code: built.code };
        kind = built.bundle.kind;
        title = built.title;
        missingFiles = built.bundle.missing;
        bundle = built.bundle;
    }

    const id = crypto.randomUUID();
    let copied: string[] = [];
    try {
        const copiedFiles = bundle ? await copyBundleFiles(id, bundle) : { files: [], copied: [] };
        copied = copiedFiles.copied;

        const expiresAt =
            expiresInDays === null
                ? null
                : new Date(Date.now() + (expiresInDays as number) * 86_400_000).toISOString();
        const passwordHash = password ? await hashPassword(password) : null;
        let row: unknown;
        let error: { code?: string } | null = null;
        // A fresh token on the (astronomically unlikely) unique-hash collision.
        for (let attempt = 0; attempt < 3; attempt++) {
            const token = newToken();
            ({ data: row, error } = await db
                .from("publications")
                .insert({
                    id,
                    created_by: input.userId,
                    document_id: input.documentId,
                    version_id: version.id,
                    follow_document: follow,
                    kind,
                    audience,
                    token_hash: hashToken(token),
                    token_sealed: sealToken(token),
                    password_hash: passwordHash,
                    require_sign_in: input.requireSignIn === true,
                    title,
                    expires_at: expiresAt,
                })
                .select(PUBLICATION_COLUMNS)
                .single());
            if (error?.code !== "23505") break;
        }
        if (error || !row) throw error ?? new Error("publication insert returned no row");
        if (copiedFiles.files.length > 0) {
            const { error: filesError } = await db.from("publication_files").insert(copiedFiles.files);
            if (filesError) {
                await db.from("publications").delete().eq("id", id);
                throw filesError;
            }
        }

        void recordAudit(db, {
            userId: input.userId,
            userEmail: input.userEmail ?? null,
            action: "publication.created",
            title,
            documentId: input.documentId,
            projectId,
            detail: {
                publication_id: id,
                audience,
                require_sign_in: input.requireSignIn === true,
                follow_document: follow,
                expires_at: expiresAt,
                files: copiedFiles.files.length,
            },
        });
        return {
            ok: true,
            publication: toView(row as PublicationRow, config, copiedFiles.files.length),
            missingFiles,
        };
    } catch (error) {
        deleteFilesBestEffort(copied, "publications/create-rollback");
        return { ok: false, code: "error", error };
    }
}

type PublicationFileRow = {
    publication_id: string;
    path: string;
    storage_path: string;
    content_type: string;
    size_bytes: number;
};

/**
 * Copy a bundle under publications/{id}/ and describe its rows. The rows are
 * inserted after the publication exists; `copied` is every key written, so a
 * failed insert can remove them.
 */
async function copyBundleFiles(
    publicationId: string,
    bundle: Bundle,
): Promise<{ files: PublicationFileRow[]; copied: string[] }> {
    const files: PublicationFileRow[] = [];
    const copied: string[] = [];
    try {
        for (const file of bundle.files) {
            const storagePath = `publications/${publicationId}/${file.path}`;
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
            // A copy's size is read back: a rendition's is not recorded anywhere
            // else, and Range requests need it exact.
            const size = "bytes" in file ? file.size : ((await headFile(storagePath))?.size ?? file.size);
            files.push({
                publication_id: publicationId,
                path: file.path,
                storage_path: storagePath,
                content_type: file.contentType,
                size_bytes: size,
            });
        }
    } catch (error) {
        deleteFilesBestEffort(copied, "publications/copy-rollback");
        throw error;
    }
    return { files, copied };
}

/** Remove a publication's copied files and their rows, best effort for storage. */
async function clearPublicationFiles(db: Db, publicationId: string, reason: string): Promise<void> {
    const { data: files } = await db
        .from("publication_files")
        .select("storage_path")
        .eq("publication_id", publicationId);
    await db.from("publication_files").delete().eq("publication_id", publicationId);
    deleteFilesBestEffort(
        ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path),
        reason,
    );
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

    await clearPublicationFiles(db, publicationId, "publications/revoke");

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

export type UpdatePublicationInput = {
    userId: string;
    userEmail?: string;
    publicationId: string;
    expiresInDays?: unknown;
    audience?: unknown;
    password?: unknown;
    requireSignIn?: unknown;
    followDocument?: unknown;
};

/**
 * The publisher edits a link after making it: its expiry, who can open it,
 * its password, and whether it follows the document or stays frozen. Only
 * the publisher may; the owner check is the query filter.
 */
export async function updatePublication(
    db: Db,
    input: UpdatePublicationInput,
    env: NodeJS.ProcessEnv = process.env,
): Promise<
    | { ok: true; publication: PublicationView }
    | { ok: false; code: PublishFailure }
    | { ok: false; code: "error"; error: unknown }
> {
    const config = publishingConfig(env);
    if (!config.enabled) return { ok: false, code: "publishing_off" };

    const { data: existing } = await db
        .from("publications")
        .select(PUBLICATION_COLUMNS)
        .eq("id", input.publicationId)
        .eq("created_by", input.userId)
        .maybeSingle();
    if (!existing) return { ok: false, code: "not_found" };
    const row = existing as PublicationRow;
    // A revoked link is gone for good — editing it can't quietly re-arm it.
    if (row.revoked_at) return { ok: false, code: "revoked" };
    if (input.followDocument !== undefined && typeof input.followDocument !== "boolean") {
        return { ok: false, code: "bad_audience" };
    }
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.expiresInDays !== undefined) {
        const days = input.expiresInDays;
        if (days !== null && !EXPIRY_DAYS.includes(days as (typeof EXPIRY_DAYS)[number]))
            return { ok: false, code: "bad_expiry" };
        patch.expires_at =
            days === null ? null : new Date(Date.now() + (days as number) * 86_400_000).toISOString();
        changed.push("expires_in_days");
    }

    const audience = input.audience ?? row.audience;
    if (audience !== "public" && audience !== "password") return { ok: false, code: "bad_audience" };
    if (!config.audiences.includes(audience)) return { ok: false, code: "publishing_off" };
    if (audience !== row.audience) changed.push("audience");
    patch.audience = audience;

    const rotatingPassword = input.password !== undefined && input.password !== null;
    if (rotatingPassword && audience !== "password") return { ok: false, code: "bad_audience" };
    let passwordHash = row.password_hash;
    let passwordVersion = row.password_version;
    if (rotatingPassword) {
        if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH)
            return { ok: false, code: "password_too_short" };
        passwordHash = await hashPassword(input.password);
        passwordVersion = (row.password_version ?? 0) + 1;
        changed.push("password");
    }
    // The audience check in the schema ties a hash to the password audience.
    if (audience === "public") passwordHash = null;
    else if (!passwordHash) return { ok: false, code: "password_too_short" };
    patch.password_hash = passwordHash;
    patch.password_version = passwordVersion;

    if (input.requireSignIn !== undefined) {
        const requireSignIn = input.requireSignIn === true;
        patch.require_sign_in = requireSignIn;
        if (requireSignIn !== (row.require_sign_in === true)) changed.push("require_sign_in");
    }

    // A toggle to frozen copies the document at this moment; a toggle to
    // follow drops the copy and serves the live version from then on.
    let dropCopy = false;
    let freeze = false;
    // The frozen-copy row count only matters when the follow flag is being
    // toggled; a routine expiry/audience edit skips the extra query.
    let fileCount = 0;
    const targetFollow =
        typeof input.followDocument === "boolean"
            ? input.followDocument
            : row.follow_document === true;
    if (targetFollow !== (row.follow_document === true)) {
        const { data: existingFiles } = await db
            .from("publication_files")
            .select("path")
            .eq("publication_id", row.id);
        fileCount = ((existingFiles ?? []) as { path: string }[]).length;
        changed.push("follow_document");
        if (targetFollow) {
            dropCopy = true;
            patch.follow_document = true;
        } else {
            freeze = true;
            if (!row.document_id) return { ok: false, code: "not_found" };
            const version = await loadActiveVersion(row.document_id, db, null);
            if (!version) return { ok: false, code: "not_found" };
            const { data: document } = await db
                .from("documents")
                .select("project_id")
                .eq("id", row.document_id)
                .maybeSingle();
            const built = await buildBundle(db, {
                documentId: row.document_id,
                projectId: (document as { project_id: string | null } | null)?.project_id ?? null,
                userId: input.userId,
                version,
            });
            if (!built.ok) return { ok: false, code: built.code };
            // A followed publication should have no rows; clear any left by
            // an earlier interrupted freeze before writing its copy.
            await clearPublicationFiles(db, row.id, "publications/freeze-replace");
            let copiedFiles: { files: PublicationFileRow[]; copied: string[] } = { files: [], copied: [] };
            try {
                copiedFiles = await copyBundleFiles(row.id, built.bundle);
                const { error: filesError } = await db
                    .from("publication_files")
                    .insert(copiedFiles.files);
                if (filesError) throw filesError;
            } catch (error) {
                deleteFilesBestEffort(copiedFiles.copied, "publications/freeze-rollback");
                return { ok: false, code: "error", error };
            }
            // The frozen copy is the current version, and its title is the
            // one the page now shows.
            patch.follow_document = false;
            patch.version_id = version.id;
            patch.kind = built.bundle.kind;
            patch.title = built.title;
            fileCount = copiedFiles.files.length;
        }
    }

    let updated: unknown = row;
    if (Object.keys(patch).length > 0) {
        const { data, error } = await db
            .from("publications")
            .update(patch)
            .eq("id", row.id)
            .select(PUBLICATION_COLUMNS)
            .single();
        if (error || !data) {
            // The publication stayed followed; drop the partial freeze.
            if (freeze) await clearPublicationFiles(db, row.id, "publications/freeze-rollback");
            return { ok: false, code: "error", error };
        }
        updated = data;
    }
    if (dropCopy) {
        await clearPublicationFiles(db, row.id, "publications/follow");
        fileCount = 0;
    } else if (!freeze) {
        // Nothing re-counted the copy this request — the view still needs
        // an honest file count, so read it here and only here.
        const { data: existingFiles } = await db
            .from("publication_files")
            .select("path")
            .eq("publication_id", row.id);
        fileCount = ((existingFiles ?? []) as { path: string }[]).length;
    }

    if (changed.length > 0) {
        void recordAudit(db, {
            userId: input.userId,
            userEmail: input.userEmail ?? null,
            action: "publication.updated",
            title: (updated as PublicationRow).title,
            documentId: row.document_id,
            detail: { publication_id: row.id, changed },
        });
    }
    return { ok: true, publication: toView(updated as PublicationRow, config, fileCount) };
}

function toView(row: PublicationRow, config: PublishingConfig, fileCount: number): PublicationView {
    const token = config.enabled && !row.revoked_at ? unsealToken(row.token_sealed) : null;
    return {
        id: row.id,
        document_id: row.document_id,
        version_id: row.version_id,
        follow_document: row.follow_document === true,
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

const PUBLISHABLE = new Set([
    "html", "md", "txt", "pdf", "png", "jpg", "jpeg", "webp", "gif", "docx", "doc", "pptx", "ppt",
    "mp3", "m4a", "wav", "ogg", "mp4", "webm", "mov",
]);
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
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db, {
        select: "id, user_id, project_id, org_id, workflow_id",
    });
    if (!access.ok) return { ok: false, code: "not_found" };
    if (!can(access.projectRole, "access.manage")) return { ok: false, code: "not_owner" };
    const version = await loadActiveVersion(documentId, db, versionId);
    if (!version) return { ok: false, code: "not_found" };
    const type = (version.file_type ?? "").toLowerCase();
    if (!PUBLISHABLE.has(type)) return { ok: false, code: "unsupported_type" };
    if (NEEDS_RENDITION.has(type) && !version.pdf_storage_path) return { ok: false, code: "no_rendition" };
    return { ok: true, documentId, versionId: version.id, filename: version.filename ?? "Untitled" };
}
