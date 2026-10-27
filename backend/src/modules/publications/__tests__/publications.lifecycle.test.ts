// The publication lifecycle: a followed link serves the document's current
// version, a frozen one keeps its copy, and the publisher can change either,
// its expiry, its audience and its password afterwards. The database is the
// in-memory query stand-in and object storage a map.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/db";
import { memoryDb } from "../../../__tests__/helpers/memoryDb";

const state = vi.hoisted(() => ({
    db: undefined as Db | undefined,
    objects: new Map<string, Buffer>(),
    role: "owner" as string,
    projectId: "p1" as string | null,
    audits: [] as { action: string; detail?: Record<string, unknown> }[],
}));

vi.mock("../../../lib/storage", () => {
    const toArrayBuffer = (b: Buffer) =>
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    return {
        uploadFile: async (key: string, bytes: ArrayBuffer) => {
            state.objects.set(key, Buffer.from(bytes));
        },
        copyFile: async (from: string, to: string) => {
            const bytes = state.objects.get(from);
            if (!bytes) throw new Error(`no object ${from}`);
            state.objects.set(to, bytes);
        },
        headFile: async (key: string) => {
            const bytes = state.objects.get(key);
            return bytes ? { size: bytes.length, etag: null, contentType: null } : null;
        },
        downloadFile: async (key: string) => {
            const bytes = state.objects.get(key);
            return bytes ? toArrayBuffer(bytes) : null;
        },
        createFileReadStream: (key: string) => {
            const { Readable } = require("node:stream") as typeof import("node:stream");
            return Readable.from([state.objects.get(key) ?? Buffer.alloc(0)]);
        },
        deleteFilesBestEffort: async (keys: string[]) => {
            for (const key of keys) state.objects.delete(key);
        },
    };
});

vi.mock("../../documents/documents.service", () => ({
    ensureDocumentAccess: async (documentId: string) =>
        state.role === "none"
            ? { ok: false }
            : { ok: true, doc: { id: documentId, project_id: state.projectId }, projectRole: state.role },
}));

vi.mock("../../../lib/audit", () => ({
    recordAudit: (_db: Db, event: { action: string; detail?: Record<string, unknown> }) => {
        state.audits.push(event);
    },
}));

import { createPublication, updatePublication } from "../publications.manage";
import { findLivePublication, findPublicationFile, unlockPublication } from "../publications.serve";
import { unlockCookieValid, unsealToken } from "../publications.shared";

const ENV = {
    PUBLISHING: "open",
    PUBLICATION_BASE_URL: "https://pub.example.com",
    PUBLICATION_SECRET: "x".repeat(40),
} as NodeJS.ProcessEnv;

const V1 = `<!doctype html><html><head><title>Field notes</title></head><body>
<h1>Version one</h1><img src="site-plan.png"><a href="https://example.com">out</a>
</body></html>`;
const V2 = `<!doctype html><html><head><title>Field notes two</title></head><body>
<h1>Version two</h1><img src="site-plan.png">
</body></html>`;
const V3 = `<!doctype html><html><head><title>Field notes three</title></head><body>
<h1>Version three</h1><img src="site-plan.png">
</body></html>`;

let store: ReturnType<typeof memoryDb>;

function addVersion(
    documentId: string,
    versionId: string,
    filename: string,
    fileType: string,
    bytes: Buffer,
    extra: Record<string, unknown> = {},
) {
    const storagePath = `documents/u1/${documentId}/${versionId}-${filename}`;
    state.objects.set(storagePath, bytes);
    store.rows("document_versions").push({
        id: versionId,
        document_id: documentId,
        storage_path: storagePath,
        pdf_storage_path: null,
        version_number: 1,
        filename,
        source: "upload",
        file_type: fileType,
        size_bytes: bytes.length,
        page_count: null,
        deleted_at: null,
        ...extra,
    });
    return storagePath;
}

function seedDocument(
    documentId: string,
    filename: string,
    fileType: string,
    bytes: Buffer,
    createdAt = "2026-10-24T00:00:00Z",
) {
    const versionId = `${documentId}-v1`;
    store.rows("documents").push({
        id: documentId,
        user_id: "u1",
        project_id: state.projectId,
        current_version_id: versionId,
        created_at: createdAt,
    });
    addVersion(documentId, versionId, filename, fileType, bytes);
    return versionId;
}

async function publishFollow(followDocument: unknown = true) {
    const result = await createPublication(
        store.db,
        {
            userId: "u1",
            documentId: "article",
            audience: "public",
            expiresInDays: 30,
            followDocument,
        },
        ENV,
    );
    if (!result.ok) throw new Error(`publishing failed: ${result.code}`);
    return result.publication;
}

async function livePublication(id: string) {
    const row = store.rows("publications").find((r) => r.id === id);
    if (!row) throw new Error("no publication row");
    const publication = await findLivePublication(store.db, unsealToken(row.token_sealed as string)!);
    if (!publication) throw new Error("expected a live publication");
    return publication;
}

beforeEach(() => {
    state.objects.clear();
    state.role = "owner";
    state.projectId = "p1";
    state.audits = [];
    process.env.PUBLICATION_SECRET = "x".repeat(40);
    store = memoryDb();
    state.db = store.db;
    seedDocument("article", "Field notes.html", "html", Buffer.from(V1), "2026-10-24T00:00:00Z");
    seedDocument("plan", "site-plan.png", "png", Buffer.from("PNG-ONE"), "2026-10-23T00:00:00Z");
});

describe("followed publications", () => {
    it("follows by default, copies nothing and serves the document's current version", async () => {
        const result = await createPublication(
            store.db,
            { userId: "u1", documentId: "article", audience: "public", expiresInDays: 30 },
            ENV,
        );
        if (!result.ok) throw new Error(`publishing failed: ${result.code}`);
        expect(result.publication.follow_document).toBe(true);
        expect(result.publication.file_count).toBe(0);
        expect(store.rows("publication_files")).toHaveLength(0);
        expect([...state.objects.keys()].some((key) => key.startsWith("publications/"))).toBe(false);

        const page = await findPublicationFile(store.db, await livePublication(result.publication.id), "");
        expect(page!.bytes!.toString()).toContain("Version one");
    });

    it("copies nothing and serves the document's current version", async () => {
        const publication = await publishFollow();
        expect(publication).toMatchObject({ follow_document: true, file_count: 0 });
        expect(store.rows("publication_files")).toHaveLength(0);
        expect([...state.objects.keys()].some((key) => key.startsWith("publications/"))).toBe(false);
        expect(store.rows("publications")[0].version_id).toBe("article-v1");

        const live = await livePublication(publication.id);
        const page = await findPublicationFile(store.db, live, "");
        expect(page).not.toBeNull();
        expect(page!.content_type).toBe("text/html; charset=utf-8");
        expect(page!.bytes!.toString()).toContain("Version one");

        // A new document version changes what the link shows.
        const v2 = addVersion("article", "article-v2", "Field notes.html", "html", Buffer.from(V2));
        store.rows("documents").find((d) => d.id === "article")!.current_version_id = "article-v2";
        expect(store.rows("document_versions").find((v) => v.id === "article-v2")!.storage_path).toBe(v2);

        const pageAgain = await findPublicationFile(store.db, live, "");
        expect(pageAgain!.bytes!.toString()).toContain("Version two");
        expect(pageAgain!.bytes!.toString()).not.toContain("Version one");

        // Referenced files resolve live too: the page's image follows its own
        // document's current version.
        const image = await findPublicationFile(store.db, live, "site-plan.png");
        expect(image).toMatchObject({ content_type: "image/png", size_bytes: 7 });
        expect(state.objects.get(image!.storage_path!)!.toString()).toBe("PNG-ONE");

        addVersion("plan", "plan-v2", "site-plan.png", "png", Buffer.from("PNG-TWO"));
        store.rows("documents").find((d) => d.id === "plan")!.current_version_id = "plan-v2";
        const imageAgain = await findPublicationFile(store.db, live, "site-plan.png");
        expect(imageAgain!.storage_path).toBe("documents/u1/plan/plan-v2-site-plan.png");
        expect(state.objects.get(imageAgain!.storage_path!)!.toString()).toBe("PNG-TWO");
    });

    it("404s like an unknown link when the document or a usable version is gone", async () => {
        const publication = await publishFollow();
        const live = await livePublication(publication.id);

        addVersion("article", "article-v4", "Sheet.xlsx", "xlsx", Buffer.from("XLSX"));
        store.rows("documents").find((d) => d.id === "article")!.current_version_id = "article-v4";
        expect(await findPublicationFile(store.db, live, "")).toBeNull();

        await store.db.from("documents").delete().eq("id", "article");
        expect(await findPublicationFile(store.db, live, "")).toBeNull();
    });

    it("rejects a type that cannot be followed without a rendition", async () => {
        const docx = await createPublication(
            store.db,
            { userId: "u1", documentId: "article", audience: "public", followDocument: true },
            ENV,
        );
        expect(docx.ok).toBe(true);
        addVersion("article", "article-docx", "Memo.docx", "docx", Buffer.from("DOCX"));
        store.rows("documents").find((d) => d.id === "article")!.current_version_id = "article-docx";
        const refused = await createPublication(
            store.db,
            { userId: "u1", documentId: "article", audience: "public", followDocument: true },
            ENV,
        );
        expect(refused).toEqual({ ok: false, code: "no_rendition" });
    });
});

describe("freezing and following again", () => {
    it("freezes the current version, and follows again after dropping the copy", async () => {
        const created = await publishFollow();
        addVersion("article", "article-v2", "Field notes.html", "html", Buffer.from(V2));
        store.rows("documents").find((d) => d.id === "article")!.current_version_id = "article-v2";

        const frozen = await updatePublication(
            store.db,
            { userId: "u1", publicationId: created.id, followDocument: false },
            ENV,
        );
        expect(frozen.ok).toBe(true);
        if (!frozen.ok) return;
        expect(frozen.publication).toMatchObject({
            follow_document: false,
            file_count: 2,
            version_id: "article-v2",
            title: "Field notes two",
        });
        expect(store.rows("publication_files")).toHaveLength(2);
        expect([...state.objects.keys()].filter((key) => key.startsWith(`publications/${created.id}/`))).toHaveLength(2);
        expect(state.audits).toContainEqual(
            expect.objectContaining({
                action: "publication.updated",
                detail: { publication_id: created.id, changed: ["follow_document"] },
            }),
        );

        // Frozen: a later version is not served.
        const live = await livePublication(created.id);
        const page = await findPublicationFile(store.db, live, "");
        expect(page!.bytes).toBeUndefined();
        expect(state.objects.get(page!.storage_path!)!.toString()).toContain("Version two");

        addVersion("article", "article-v3", "Field notes.html", "html", Buffer.from(V3));
        store.rows("documents").find((d) => d.id === "article")!.current_version_id = "article-v3";
        const still = await findPublicationFile(store.db, live, "");
        expect(state.objects.get(still!.storage_path!)!.toString()).toContain("Version two");

        // Following again drops the copy and serves the newest version.
        const followed = await updatePublication(
            store.db,
            { userId: "u1", publicationId: created.id, followDocument: true },
            ENV,
        );
        expect(followed.ok).toBe(true);
        if (!followed.ok) return;
        expect(followed.publication).toMatchObject({ follow_document: true, file_count: 0 });
        expect(store.rows("publication_files")).toHaveLength(0);
        expect([...state.objects.keys()].some((key) => key.startsWith("publications/"))).toBe(false);

        const next = await findPublicationFile(store.db, await livePublication(created.id), "");
        expect(next!.bytes!.toString()).toContain("Version three");
    });

    it("leaves a frozen publication alone when nothing is asked to change", async () => {
        const created = await publishFollow(false);
        expect(created.follow_document).toBe(false);
        const result = await updatePublication(
            store.db,
            { userId: "u1", publicationId: created.id, followDocument: false },
            ENV,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.publication.file_count).toBe(2);
        expect(state.audits.filter((event) => event.action === "publication.updated")).toHaveLength(0);
    });
});

describe("editing expiry, audience and password", () => {
    async function publishPasswordLink() {
        const result = await createPublication(
            store.db,
            {
                userId: "u1",
                documentId: "article",
                audience: "password",
                password: "maple-river-lamp-stone",
                expiresInDays: 30,
            },
            ENV,
        );
        if (!result.ok) throw new Error(`publishing failed: ${result.code}`);
        return result.publication;
    }

    it("clears and resets the expiry", async () => {
        const { id } = await publishPasswordLink();
        const cleared = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, expiresInDays: null },
            ENV,
        );
        expect(cleared.ok && cleared.publication.expires_at).toBeNull();

        const renewed = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, expiresInDays: 7 },
            ENV,
        );
        if (!renewed.ok) throw new Error("expected the update");
        const expires = Date.parse(renewed.publication.expires_at!);
        expect(expires).toBeGreaterThan(Date.now() + 6 * 86_400_000);
        expect(expires).toBeLessThan(Date.now() + 8 * 86_400_000);

        const bad = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, expiresInDays: 3 },
            ENV,
        );
        expect(bad).toEqual({ ok: false, code: "bad_expiry" });
    });

    it("rotates the password and invalidates every unlock cookie", async () => {
        const { id } = await publishPasswordLink();
        const before = await livePublication(id);
        const oldCookie = await unlockPublication(before, "maple-river-lamp-stone");
        expect(oldCookie).not.toBeNull();
        expect(unlockCookieValid(before, oldCookie!)).toBe(true);

        const rotated = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, password: "new-maple-river-lamp" },
            ENV,
        );
        expect(rotated.ok).toBe(true);
        const after = await livePublication(id);
        expect(after.password_version).toBe(1);

        // The old cookie and password are dead; the new password opens it.
        expect(unlockCookieValid(after, oldCookie!)).toBe(false);
        expect(await unlockPublication(after, "maple-river-lamp-stone")).toBeNull();
        const newCookie = await unlockPublication(after, "new-maple-river-lamp");
        expect(newCookie).not.toBeNull();
        expect(unlockCookieValid(after, newCookie!)).toBe(true);
        expect(state.audits).toContainEqual(
            expect.objectContaining({
                action: "publication.updated",
                detail: { publication_id: id, changed: ["password"] },
            }),
        );
    });

    it("moves between public and password audiences", async () => {
        const { id } = await publishPasswordLink();

        const publicLink = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, audience: "public" },
            ENV,
        );
        expect(publicLink.ok).toBe(true);
        if (!publicLink.ok) return;
        expect(publicLink.publication.audience).toBe("public");
        expect(store.rows("publications")[0].password_hash).toBeNull();

        const noPassword = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, audience: "password" },
            ENV,
        );
        expect(noPassword).toEqual({ ok: false, code: "password_too_short" });

        const secret = await updatePublication(
            store.db,
            {
                userId: "u1",
                publicationId: id,
                audience: "password",
                password: "another-river-lamp-stone",
            },
            ENV,
        );
        expect(secret.ok).toBe(true);
        if (!secret.ok) return;
        expect(secret.publication.audience).toBe("password");
        expect(store.rows("publications")[0].password_version).toBe(1);
        expect(await unlockPublication(await livePublication(id), "another-river-lamp-stone")).not.toBeNull();

        const mismatched = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, audience: "public", password: "another-river-lamp-stone" },
            ENV,
        );
        expect(mismatched).toEqual({ ok: false, code: "bad_audience" });
        expect(
            await updatePublication(
                store.db,
                { userId: "u1", publicationId: id, audience: "everyone" },
                ENV,
            ),
        ).toEqual({ ok: false, code: "bad_audience" });
    });

    it("turns signed-in-only on and off and keeps the view in step", async () => {
        const { id } = await publishPasswordLink();
        const list = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, requireSignIn: true },
            ENV,
        );
        expect(list.ok && list.publication.require_sign_in).toBe(true);
        const off = await updatePublication(
            store.db,
            { userId: "u1", publicationId: id, requireSignIn: false },
            ENV,
        );
        expect(off.ok && off.publication.require_sign_in).toBe(false);
    });
});

describe("who may edit", () => {
    it("only the publisher, and only with publishing on", async () => {
        const created = await publishFollow();
        const foreign = await updatePublication(
            store.db,
            { userId: "u2", publicationId: created.id, expiresInDays: 7 },
            ENV,
        );
        expect(foreign).toEqual({ ok: false, code: "not_found" });
        expect(store.rows("publications")[0].expires_at).toBe(created.expires_at);

        const unknown = await updatePublication(
            store.db,
            { userId: "u1", publicationId: "missing", expiresInDays: 7 },
            ENV,
        );
        expect(unknown).toEqual({ ok: false, code: "not_found" });

        const off = await updatePublication(
            store.db,
            { userId: "u1", publicationId: created.id, expiresInDays: 7 },
            { PUBLISHING: "off" } as NodeJS.ProcessEnv,
        );
        expect(off).toEqual({ ok: false, code: "publishing_off" });

        state.role = "editor";
        const notOwner = await createPublication(
            store.db,
            { userId: "u1", documentId: "article", audience: "public", followDocument: true },
            ENV,
        );
        expect(notOwner).toEqual({ ok: false, code: "not_owner" });
    });
});
