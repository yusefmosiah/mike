// Publishing end to end over HTTP: make a link on the API, open it on the
// content origin, unlock a password link, revoke and expire links. The
// database is an in-memory store and object storage a map, so the files a
// publication copies are the files the content server serves.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "../../lib/db";
import { memoryDb } from "../helpers/memoryDb";

const state = vi.hoisted(() => ({
    db: undefined as Db | undefined,
    objects: new Map<string, Buffer>(),
    role: "owner" as string,
    canOpen: true,
}));

vi.mock("../../lib/db", () => ({ createDb: () => state.db }));
vi.mock("../../middleware/auth", async () => {
    const { authMock } = await import("../helpers/authMock.js");
    return authMock();
});
vi.mock("../../lib/access", async (original) => ({
    ...(await original<typeof import("../../lib/access")>()),
    ensureDocAccess: async () =>
        state.canOpen ? { ok: true, isCreator: true, projectRole: state.role } : { ok: false },
}));
vi.mock("../../lib/storage", async (original) => {
    const actual = await original<typeof import("../../lib/storage")>();
    const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    return {
        ...actual,
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
        createFileReadStream: (key: string, range?: { start: number; end: number }) => {
            const bytes = state.objects.get(key) ?? Buffer.alloc(0);
            return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
        },
        deleteFilesBestEffort: async (keys: string[]) => {
            for (const key of keys) state.objects.delete(key);
        },
    };
});
vi.mock("../../lib/audit", async (original) => ({
    ...(await original<typeof import("../../lib/audit")>()),
    recordAudit: async () => undefined,
}));

import { app, publicationContentApp } from "../../app";
import { publishPreflight } from "../../modules/publications/publications.service";

const ARTICLE = `<!doctype html><html><head><title>Field notes</title></head><body>
<h1>Field notes</h1>
<img src="site-plan.png">
<img src="./missing.jpg">
<a href="https://example.com/x">out</a>
<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>
</body></html>`;

let store: ReturnType<typeof memoryDb>;

function seedDocument(id: string, filename: string, fileType: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
    const versionId = `${id}-v1`;
    store.rows("documents").push({ id, user_id: "u1", project_id: "p1", org_id: null, workflow_id: null, current_version_id: versionId, created_at: "2026-10-24T00:00:00Z" });
    const storagePath = `documents/u1/${id}/${filename}`;
    state.objects.set(storagePath, bytes);
    store.rows("document_versions").push({
        id: versionId,
        document_id: id,
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
}

async function publish(body: Record<string, unknown>) {
    return request(app).post("/publications").set("Authorization", "Bearer t").send(body);
}

function hostOf(url: string) {
    return new URL(url).host;
}

beforeEach(() => {
    store = memoryDb();
    state.db = store.db;
    state.objects.clear();
    state.role = "owner";
    state.canOpen = true;
    process.env.FRONTEND_URL = "http://app.test";
    process.env.PUBLISHING = "open";
    process.env.PUBLICATION_BASE_URL = "http://pub.test";
    delete process.env.PUBLICATION_URL_STYLE;
    // Its own key, whatever the environment running the suite holds.
    process.env.PUBLICATION_SECRET = "x".repeat(40);
    seedDocument("article", "Field notes.html", "html", Buffer.from(ARTICLE));
    seedDocument("plan", "site-plan.png", "png", Buffer.from("PNGDATA"));
});

describe("publishing an HTML article", () => {
    it("reports the deployment's policy", async () => {
        const res = await request(app).get("/publications/config").set("Authorization", "Bearer t");
        expect(res.body).toEqual({ enabled: true, audiences: ["public", "password"] });
        delete process.env.PUBLISHING;
        const off = await request(app).get("/publications/config").set("Authorization", "Bearer t");
        expect(off.body).toEqual({ enabled: false, audiences: [], reason: "off" });
    });

    it("serves the page and the images beside it on its own subdomain", async () => {
        const res = await publish({ document_id: "article", audience: "public", expires_in_days: 30 });
        expect(res.status).toBe(201);
        expect(res.body.missing_files).toEqual(["missing.jpg"]);
        const { publication } = res.body;
        expect(publication).toMatchObject({ title: "Field notes", kind: "site", audience: "public", file_count: 2 });
        expect(publication.url).toMatch(/^http:\/\/[a-z2-7]{26}\.pub\.test\/$/);
        expect(Date.parse(publication.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);

        const host = hostOf(publication.url);
        const page = await request(publicationContentApp).get("/").set("Host", host);
        expect(page.status).toBe(200);
        expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(page.headers["content-security-policy"]).toContain("frame-src https://www.youtube-nocookie.com");
        expect(page.headers["content-security-policy"]).toContain("form-action 'none'");
        expect(page.headers["x-robots-tag"]).toBe("noindex, nofollow");
        expect(page.headers["referrer-policy"]).toBe("no-referrer");
        expect(page.text).toContain('<iframe referrerpolicy="strict-origin-when-cross-origin" src="https://www.youtube-nocookie.com/embed/abc">');

        const image = await request(publicationContentApp).get("/site-plan.png").set("Host", host);
        expect(image.status).toBe(200);
        expect(image.headers["content-type"]).toBe("image/png");
        expect(image.headers["content-security-policy"]).toBeUndefined();
        expect(Buffer.from(image.body).toString()).toBe("PNGDATA");

        const missing = await request(publicationContentApp).get("/missing.jpg").set("Host", host);
        expect(missing.status).toBe(404);

        // The copy is frozen: changing the document does not change the link.
        state.objects.set("documents/u1/article/Field notes.html", Buffer.from("<p>edited</p>"));
        const again = await request(publicationContentApp).get("/").set("Host", host);
        expect(again.text).toContain("Field notes");
    });

    it("lists the publisher's links and revokes one, deleting its copy", async () => {
        const created = await publish({ document_id: "article", audience: "public", expires_in_days: null });
        const { publication } = created.body;
        expect(publication.expires_at).toBeNull();

        const list = await request(app).get("/publications?document_id=article").set("Authorization", "Bearer t");
        expect(list.body.publications).toHaveLength(1);
        expect(list.body.publications[0]).toMatchObject({ id: publication.id, url: publication.url, file_count: 2 });

        const revoked = await request(app).post(`/publications/${publication.id}/revoke`).set("Authorization", "Bearer t");
        expect(revoked.status).toBe(200);
        expect(revoked.body.publication.revoked_at).toBeTruthy();
        expect(revoked.body.publication.url).toBeNull();
        expect([...state.objects.keys()].some((k) => k.startsWith("publications/"))).toBe(false);

        const page = await request(publicationContentApp).get("/").set("Host", hostOf(publication.url));
        expect(page.status).toBe(404);
        expect(page.text).toContain("This link does not exist");

        const unknown = await request(app).post("/publications/nope/revoke").set("Authorization", "Bearer t");
        expect(unknown.status).toBe(404);
    });

    it("refuses an expired link like an unknown one", async () => {
        const { body } = await publish({ document_id: "article", audience: "public", expires_in_days: 7 });
        store.rows("publications")[0].expires_at = "2020-01-01T00:00:00Z";
        const page = await request(publicationContentApp).get("/").set("Host", hostOf(body.publication.url));
        expect(page.status).toBe(404);
        const bogus = await request(publicationContentApp).get("/").set("Host", "aaaaaaaaaaaaaaaaaaaaaaaaaa.pub.test");
        expect(bogus.status).toBe(404);
        expect(bogus.text).toBe(page.text);
    });
});

describe("password links", () => {
    it("asks for the password, refuses a wrong one, and opens with the right one", async () => {
        const short = await publish({ document_id: "article", audience: "password", password: "short", expires_in_days: 30 });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe("password_too_short");

        const { body } = await publish({ document_id: "article", audience: "password", password: "maple-river-lamp-stone", expires_in_days: 30 });
        const host = hostOf(body.publication.url);

        const locked = await request(publicationContentApp).get("/").set("Host", host);
        expect(locked.status).toBe(401);
        expect(locked.headers["cache-control"]).toBe("no-store");
        expect(locked.text).toContain('action="/__unlock"');
        expect(locked.text).not.toContain("Field notes");
        const lockedImage = await request(publicationContentApp).get("/site-plan.png").set("Host", host);
        expect(lockedImage.status).toBe(401);

        const wrong = await request(publicationContentApp).post("/__unlock").set("Host", host).type("form").send({ password: "nope" });
        expect(wrong.status).toBe(401);
        expect(wrong.text).toContain("That password is not right.");

        const right = await request(publicationContentApp)
            .post("/__unlock")
            .set("Host", host)
            .type("form")
            .send({ password: "maple-river-lamp-stone" });
        expect(right.status).toBe(303);
        expect(right.headers.location).toBe("/");
        const cookie = right.headers["set-cookie"][0] as string;
        expect(cookie).toMatch(/^pub_unlock=.+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax$/);

        const open = await request(publicationContentApp).get("/").set("Host", host).set("Cookie", cookie.split(";")[0]);
        expect(open.status).toBe(200);
        expect(open.text).toContain("Field notes");
    });

    it("stops guessing after five attempts a minute", async () => {
        const { body } = await publish({ document_id: "article", audience: "password", password: "maple-river-lamp-stone", expires_in_days: 30 });
        const host = hostOf(body.publication.url);
        for (let i = 0; i < 5; i++)
            await request(publicationContentApp).post("/__unlock").set("Host", host).type("form").send({ password: "nope" });
        const blocked = await request(publicationContentApp).post("/__unlock").set("Host", host).type("form").send({ password: "maple-river-lamp-stone" });
        expect(blocked.status).toBe(429);
    });
});

describe("signed-in links", () => {
    it("sends a visitor to the app to sign in, and lets in someone who can open the document", async () => {
        const { body } = await publish({ document_id: "article", audience: "public", require_sign_in: true, expires_in_days: 30 });
        const { publication } = body;
        expect(publication.require_sign_in).toBe(true);
        const host = hostOf(publication.url);

        const away = await request(publicationContentApp).get("/site-plan.png").set("Host", host);
        expect(away.status).toBe(302);
        expect(away.headers.location).toBe(`http://app.test/published?p=${publication.id}&r=site-plan.png`);

        const open = await request(app)
            .post(`/publications/${publication.id}/open`)
            .set("Authorization", "Bearer t")
            .send({ path: "site-plan.png" });
        expect(open.status).toBe(200);
        const grant = new URL(open.body.url);
        expect(grant.host).toBe(host);
        expect(grant.pathname).toBe("/__grant");
        expect(grant.searchParams.get("r")).toBe("site-plan.png");

        const redeemed = await request(publicationContentApp).get(`${grant.pathname}${grant.search}`).set("Host", host);
        expect(redeemed.status).toBe(303);
        expect(redeemed.headers.location).toBe("/site-plan.png");
        const cookie = (redeemed.headers["set-cookie"][0] as string).split(";")[0];
        expect(cookie).toMatch(/^pub_member=/);
        expect(redeemed.headers["set-cookie"][0]).toContain("Max-Age=3600");

        const image = await request(publicationContentApp).get("/site-plan.png").set("Host", host).set("Cookie", cookie);
        expect(image.status).toBe(200);

        // A grant is for its own link only, and cannot be forged.
        const forged = await request(publicationContentApp).get("/__grant?g=1.abc").set("Host", host);
        expect(forged.status).toBe(404);
    });

    it("refuses someone who cannot open the document, and a link that does not ask for sign-in", async () => {
        const signedIn = await publish({ document_id: "article", audience: "public", require_sign_in: true, expires_in_days: 30 });
        state.canOpen = false;
        const refused = await request(app)
            .post(`/publications/${signedIn.body.publication.id}/open`)
            .set("Authorization", "Bearer t")
            .send({});
        expect(refused.status).toBe(404);
        state.canOpen = true;
        const plain = await publish({ document_id: "article", audience: "public", expires_in_days: 30 });
        const notNeeded = await request(app)
            .post(`/publications/${plain.body.publication.id}/open`)
            .set("Authorization", "Bearer t")
            .send({});
        expect(notNeeded.status).toBe(404);
    });

    it("asks for the password after sign-in when a link has both", async () => {
        const { body } = await publish({
            document_id: "article",
            audience: "password",
            password: "maple-river-lamp-stone",
            require_sign_in: true,
            expires_in_days: 30,
        });
        const host = hostOf(body.publication.url);
        const unlockFirst = await request(publicationContentApp).post("/__unlock").set("Host", host).type("form").send({ password: "maple-river-lamp-stone" });
        expect(unlockFirst.status).toBe(303);
        expect(unlockFirst.headers.location).toContain("http://app.test/published?p=");
        const open = await request(app).post(`/publications/${body.publication.id}/open`).set("Authorization", "Bearer t").send({});
        const grant = new URL(open.body.url);
        const redeemed = await request(publicationContentApp).get(`${grant.pathname}${grant.search}`).set("Host", host);
        const member = (redeemed.headers["set-cookie"][0] as string).split(";")[0];
        const locked = await request(publicationContentApp).get("/").set("Host", host).set("Cookie", member);
        expect(locked.status).toBe(401);
        const unlocked = await request(publicationContentApp)
            .post("/__unlock")
            .set("Host", host)
            .set("Cookie", member)
            .type("form")
            .send({ password: "maple-river-lamp-stone" });
        const password = (unlocked.headers["set-cookie"][0] as string).split(";")[0];
        const page = await request(publicationContentApp).get("/").set("Host", host).set("Cookie", `${member}; ${password}`);
        expect(page.status).toBe(200);
    });
});

describe("other formats and refusals", () => {
    it("publishes Markdown as a page and a PDF as itself, with ranges", async () => {
        seedDocument("notes", "Notes.md", "md", Buffer.from("# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"));
        const md = await publish({ document_id: "notes", audience: "public", expires_in_days: 30 });
        const page = await request(publicationContentApp).get("/").set("Host", hostOf(md.body.publication.url));
        expect(page.text).toContain("<h1>Hello</h1>");
        expect(page.text).toContain("<table>");
        expect(page.text).toContain("<title>Notes</title>");

        seedDocument("brief", "Brief.pdf", "pdf", Buffer.from("%PDF-1.7 0123456789"));
        const pdf = await publish({ document_id: "brief", audience: "public", expires_in_days: 30 });
        expect(pdf.body.publication.kind).toBe("file");
        const host = hostOf(pdf.body.publication.url);
        const whole = await request(publicationContentApp).get("/").set("Host", host);
        expect(whole.headers["content-type"]).toBe("application/pdf");
        expect(whole.headers["content-disposition"]).toBe("inline; filename*=UTF-8''Brief.pdf");
        const part = await request(publicationContentApp).get("/").set("Host", host).set("Range", "bytes=0-3");
        expect(part.status).toBe(206);
        expect(part.headers["content-range"]).toBe("bytes 0-3/19");
        expect(Buffer.from(part.body).toString()).toBe("%PDF");
        const bad = await request(publicationContentApp).get("/").set("Host", host).set("Range", "bytes=99-");
        expect(bad.status).toBe(416);
    });

    it("publishes a Word file as its PDF rendition, and refuses one without", async () => {
        seedDocument("memo", "Memo.docx", "docx", Buffer.from("DOCX"));
        const none = await publish({ document_id: "memo", audience: "public", expires_in_days: 30 });
        expect(none.status).toBe(400);
        expect(none.body.code).toBe("no_rendition");

        state.objects.set("documents/u1/memo/Memo.pdf", Buffer.from("%PDF-memo"));
        store.rows("document_versions").find((v) => v.id === "memo-v1")!.pdf_storage_path = "documents/u1/memo/Memo.pdf";
        const ok = await publish({ document_id: "memo", audience: "public", expires_in_days: 30 });
        expect(ok.status).toBe(201);
        const file = await request(publicationContentApp).get("/").set("Host", hostOf(ok.body.publication.url));
        expect(file.headers["content-length"]).toBe("9");
        expect(file.text ?? Buffer.from(file.body).toString()).toContain("%PDF-memo");
    });

    it("serves path-style links under one host", async () => {
        process.env.PUBLICATION_URL_STYLE = "path";
        process.env.PUBLICATION_BASE_URL = "http://localhost:3002";
        const { body } = await publish({ document_id: "article", audience: "public", expires_in_days: 30 });
        const url = new URL(body.publication.url);
        expect(url.pathname).toMatch(/^\/[a-z2-7]{26}\/$/);
        const bare = await request(publicationContentApp).get(url.pathname.slice(0, -1)).set("Host", url.host);
        expect(bare.status).toBe(301);
        expect(bare.headers.location).toBe(url.pathname);
        const image = await request(publicationContentApp).get(`${url.pathname}site-plan.png`).set("Host", url.host);
        expect(image.status).toBe(200);
    });

    it("refuses when publishing is off, the caller is not the owner, or the type is unsupported", async () => {
        state.role = "editor";
        expect((await publish({ document_id: "article", audience: "public", expires_in_days: 30 })).status).toBe(403);
        state.role = "owner";
        seedDocument("sheet", "Sheet.xlsx", "xlsx", Buffer.from("XLSX"));
        const sheet = await publish({ document_id: "sheet", audience: "public", expires_in_days: 30 });
        expect(sheet.body.code).toBe("unsupported_type");
        expect((await publish({ document_id: "article", audience: "everyone", expires_in_days: 30 })).body.code).toBe("bad_audience");
        expect((await publish({ document_id: "article", audience: "public", expires_in_days: 3 })).body.code).toBe("bad_expiry");
        expect((await publish({ document_id: "gone", audience: "public", expires_in_days: 30 })).status).toBe(404);
        expect((await publish({ audience: "public" })).status).toBe(400);
        delete process.env.PUBLISHING;
        const off = await publish({ document_id: "article", audience: "public", expires_in_days: 30 });
        expect(off.body.code).toBe("publishing_off");
        const content = await request(publicationContentApp).get("/").set("Host", "aaaaaaaaaaaaaaaaaaaaaaaaaa.pub.test");
        expect(content.status).toBe(404);
    });

    it("checks before the assistant asks, with the same rules as publishing", async () => {
        expect(await publishPreflight(store.db, "u1", undefined, "article", null)).toEqual({
            ok: true,
            documentId: "article",
            versionId: "article-v1",
            filename: "Field notes.html",
        });
        seedDocument("memo", "Memo.docx", "docx", Buffer.from("DOCX"));
        expect(await publishPreflight(store.db, "u1", undefined, "memo", null)).toEqual({ ok: false, code: "no_rendition" });
        seedDocument("sheet", "Sheet.xlsx", "xlsx", Buffer.from("XLSX"));
        expect(await publishPreflight(store.db, "u1", undefined, "sheet", null)).toEqual({ ok: false, code: "unsupported_type" });
        expect(await publishPreflight(store.db, "u1", undefined, "gone", null)).toEqual({ ok: false, code: "not_found" });
        state.role = "editor";
        expect(await publishPreflight(store.db, "u1", undefined, "article", null)).toEqual({ ok: false, code: "not_owner" });
        delete process.env.PUBLISHING;
        expect(await publishPreflight(store.db, "u1", undefined, "article", null)).toEqual({ ok: false, code: "publishing_off" });
    });

    it("tells crawlers to stay out", async () => {
        const res = await request(publicationContentApp).get("/robots.txt").set("Host", "pub.test");
        expect(res.text).toBe("User-agent: *\nDisallow: /\n");
    });
});
