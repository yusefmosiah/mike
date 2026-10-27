// HTTP layer for the publications module. Two surfaces:
//
//   publicationsRouter        — signed in, on the API: make, list and revoke
//                               links (mounted at /publications by app.ts).
//   publicationContentRouter  — public, on the content origin: serves the
//                               published files, behind a password page when
//                               the link has one. app.ts wraps it in its own
//                               Express app, which index.ts binds to
//                               PUBLICATION_PORT; it never shares a listener
//                               or an origin with the API.

import express, { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { parse as parseCookies, serialize as serializeCookie } from "cookie";
import { requireAuth } from "../../middleware/auth";
import { parseRange } from "../../lib/httpRange";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createDb } from "../../lib/db";
import { sendInternalError } from "../../lib/httpError";
import { createFileReadStream } from "../../lib/storage";
import {
    MEMBER_COOKIE,
    MEMBER_TTL_SECONDS,
    PAGE_CSP,
    SITE_CSP,
    UNLOCK_COOKIE,
    UNLOCK_TTL_SECONDS,
    createPublication,
    escapeHtml,
    findLivePublication,
    findPublicationFile,
    grantPublicationAccess,
    listPublications,
    missThrottle,
    publicationMemberOk,
    publicationUnlocked,
    publishingConfig,
    recordMiss,
    redeemSignInGrant,
    safeInnerPath,
    signInUrl,
    publishingConfigView,
    revokePublication,
    tokenFromRequest,
    unlockPublication,
    updatePublication,
    type LivePublication,
    type PublishFailure,
} from "./publications.service";

// ---------------------------------------------------------------------------
// Signed-in API
// ---------------------------------------------------------------------------

export const publicationsRouter = Router();

const FAILURE_STATUS: Record<PublishFailure, number> = {
    publishing_off: 400,
    password_too_short: 400,
    bad_audience: 400,
    bad_expiry: 400,
    confidential: 400,
    unsupported_type: 400,
    no_rendition: 400,
    too_large: 400,
    unreadable: 400,
    not_owner: 403,
    not_found: 404,
};

const FAILURE_DETAIL: Record<PublishFailure, string> = {
    publishing_off: "Publishing is not turned on for this deployment.",
    password_too_short: "The password must be at least 12 characters.",
    bad_audience: "Choose who can open the link.",
    bad_expiry: "Choose 7, 30 or 90 days, or no expiry.",
    confidential: "This document is marked confidential.",
    unsupported_type: "This kind of file cannot be published yet.",
    no_rendition: "This file has no PDF version to publish yet.",
    too_large: "The page refers to too many files, or files that are too large.",
    unreadable: "The file could not be read.",
    not_owner: "Only the document's owner can publish it.",
    not_found: "Document not found",
};

// GET /publications/config
publicationsRouter.get("/config", requireAuth, (_req, res) => {
    res.json(publishingConfigView());
});

// GET /publications?document_id=
publicationsRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const documentId = typeof req.query.document_id === "string" ? req.query.document_id : null;
    const result = await listPublications(createDb(), userId, documentId);
    if (!result.ok) return void sendInternalError(res, result.kind === "error" ? result.error : result.detail);
    res.json({ publications: result.data });
}));

// POST /publications
publicationsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.document_id !== "string" || !body.document_id)
        return void res.status(400).json({ code: "bad_request", detail: "document_id is required" });
    const result = await createPublication(createDb(), {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        documentId: body.document_id,
        versionId: typeof body.version_id === "string" ? body.version_id : null,
        audience: body.audience,
        password: body.password,
        requireSignIn: body.require_sign_in,
        expiresInDays: body.expires_in_days,
        followDocument: body.follow_document,
    });
    if (!result.ok) {
        if (result.code === "error") return void sendInternalError(res, result.error);
        return void res
            .status(FAILURE_STATUS[result.code])
            .json({ code: result.code, detail: FAILURE_DETAIL[result.code] });
    }
    res.status(201).json({ publication: result.publication, missing_files: result.missingFiles });
}));

// PATCH /publications/:publicationId
// The publisher edits an existing link: expiry, audience, password,
// signed-in-only, and whether it follows the document.
publicationsRouter.patch("/:publicationId", requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await updatePublication(createDb(), {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        publicationId: req.params.publicationId,
        expiresInDays: body.expires_in_days,
        audience: body.audience,
        password: body.password,
        requireSignIn: body.require_sign_in,
        followDocument: body.follow_document,
    });
    if (!result.ok) {
        if (result.code === "error") return void sendInternalError(res, result.error);
        return void res
            .status(FAILURE_STATUS[result.code])
            .json({ code: result.code, detail: FAILURE_DETAIL[result.code] });
    }
    res.json({ publication: result.publication });
}));

// POST /publications/:publicationId/revoke
publicationsRouter.post("/:publicationId/revoke", requireAuth, asyncRoute(async (req, res) => {
    const result = await revokePublication(
        createDb(),
        res.locals.userId as string,
        res.locals.userEmail as string | undefined,
        req.params.publicationId,
    );
    if (!result.ok) {
        if (result.code === "error") return void sendInternalError(res, result.error);
        return void res.status(404).json({ code: "not_found", detail: "Link not found" });
    }
    res.json({ publication: result.publication });
}));

// POST /publications/:publicationId/open
// A signed-in visitor of a signed-in-only link, sent here by the content
// server: the answer is where to send them next.
publicationsRouter.post("/:publicationId/open", requireAuth, asyncRoute(async (req, res) => {
    const result = await grantPublicationAccess(
        createDb(),
        res.locals.userId as string,
        res.locals.userEmail as string | undefined,
        req.params.publicationId,
        (req.body as Record<string, unknown> | undefined)?.path,
    );
    if (!result.ok) return void res.status(404).json({ code: "not_found", detail: "Page not found" });
    res.json({ url: result.url });
}));

publicationsRouter.use(routerErrorHandler("[publications]"));

// ---------------------------------------------------------------------------
// Content origin
// ---------------------------------------------------------------------------

export const publicationContentRouter = Router();

const UNLOCK_PATH = "__unlock";
const GRANT_PATH = "__grant";

function contentKey(req: Request): string {
    return `${req.headers.host ?? ""}${req.path.split(UNLOCK_PATH)[0]}`;
}

function sendTooManyAttempts(_req: Request, res: Response): void {
    sendPage(res, 429, "Too many attempts", "<p>Too many wrong passwords. Try again in a few minutes.</p>");
}

// Five password attempts a minute from one address, and fifty an hour from
// everywhere, per link.
const unlockPerAddress = rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}|${contentKey(req)}`,
    handler: sendTooManyAttempts,
});
const unlockPerLink = rateLimit({
    windowMs: 60 * 60_000,
    limit: 50,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: contentKey,
    handler: sendTooManyAttempts,
});

// Guessing link names: an address that has asked for too many names that do
// not exist is refused everything on this origin for a while, before any
// lookup (publications.throttle.ts).
publicationContentRouter.use(missThrottle((res) => sendNotFoundPage(res, 429)));

publicationContentRouter.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

publicationContentRouter.post(
    new RegExp(`/${UNLOCK_PATH}$`),
    unlockPerAddress,
    unlockPerLink,
    express.urlencoded({ extended: false, limit: "4kb" }),
    asyncRoute(async (req, res) => {
        const resolved = await resolveRequest(req);
        if (!resolved) return void sendMiss(req, res);
        const { row, hit, secure } = resolved;
        if (!publicationMemberOk(row, parseCookies(req.headers.cookie ?? "")[MEMBER_COOKIE]))
            return void res.redirect(303, signInUrl(row.id, ""));
        const cookie = await unlockPublication(row, (req.body as Record<string, unknown> | undefined)?.password);
        if (!cookie) return void sendPasswordPage(res, hit.prefix, true);
        res.setHeader(
            "Set-Cookie",
            serializeCookie(UNLOCK_COOKIE, cookie, {
                path: hit.prefix,
                maxAge: UNLOCK_TTL_SECONDS,
                httpOnly: true,
                sameSite: "lax",
                secure,
            }),
        );
        res.redirect(303, hit.prefix);
    }),
);

// The app's grant for a signed-in visitor, traded for a cookie on this origin.
publicationContentRouter.get(new RegExp(`/${GRANT_PATH}$`), asyncRoute(async (req, res) => {
    const resolved = await resolveRequest(req);
    if (!resolved) return void sendMiss(req, res);
    const { row, hit, secure } = resolved;
    const cookie = redeemSignInGrant(row, req.query.g);
    if (!cookie) return void sendNotFound(res);
    res.setHeader(
        "Set-Cookie",
        serializeCookie(MEMBER_COOKIE, cookie, {
            path: hit.prefix,
            maxAge: MEMBER_TTL_SECONDS,
            httpOnly: true,
            sameSite: "lax",
            secure,
        }),
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.redirect(303, hit.prefix + safeInnerPath(req.query.r));
}));

publicationContentRouter.get(/.*/, asyncRoute(async (req, res) => {
    const resolved = await resolveRequest(req);
    if (!resolved) return void sendMiss(req, res);
    const { row, hit, db } = resolved;
    // A path-style link needs its trailing slash, or the page's relative
    // references resolve one level too high.
    if (hit.path === "" && !req.path.endsWith("/")) return void res.redirect(301, hit.prefix);

    const cookies = parseCookies(req.headers.cookie ?? "");
    if (!publicationMemberOk(row, cookies[MEMBER_COOKIE])) {
        res.setHeader("Cache-Control", "no-store");
        return void res.redirect(302, signInUrl(row.id, hit.path));
    }
    if (!publicationUnlocked(row, cookies[UNLOCK_COOKIE])) return void sendPasswordPage(res, hit.prefix, false);

    const file = await findPublicationFile(db, row, hit.path);
    if (!file) return void sendNotFound(res);

    res.setHeader("Content-Type", file.content_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Accept-Ranges", "bytes");
    // Pages and SVG run script, so they carry the published-page policy.
    // PDFs and media carry none: a policy on a PDF can blank the browser's
    // own viewer, and they run nothing of ours.
    if (/^text\/html|^image\/svg\+xml/.test(file.content_type)) res.setHeader("Content-Security-Policy", SITE_CSP);
    if (file.content_type === "application/pdf")
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.path)}`);

    const range = parseRange(req.headers.range, file.size_bytes);
    if (range === "unsatisfiable") {
        res.setHeader("Content-Range", `bytes */${file.size_bytes}`);
        return void res.status(416).end();
    }
    if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.size_bytes}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else if (file.size_bytes > 0) {
        res.setHeader("Content-Length", String(file.size_bytes));
    }
    if (req.method === "HEAD") return void res.end();
    if (file.bytes) {
        res.end(range ? file.bytes.subarray(range.start, range.end + 1) : file.bytes);
        return;
    }
    const stream = createFileReadStream(file.storage_path ?? "", range ?? undefined);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
}));

publicationContentRouter.use(routerErrorHandler("[publication-content]"));

async function resolveRequest(req: Request): Promise<{
    row: LivePublication;
    hit: { token: string; path: string; prefix: string };
    secure: boolean;
    db: ReturnType<typeof createDb>;
} | null> {
    const config = publishingConfig();
    if (!config.enabled) return null;
    const hit = tokenFromRequest(config, req.headers.host ?? "", req.path);
    if (!hit) return null;
    const db = createDb();
    const row = await findLivePublication(db, hit.token);
    if (!row) return null;
    return { row, hit, db, secure: config.baseUrl.protocol === "https:" };
}

const PAGE_STYLE = `
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f}
@media (prefers-color-scheme:dark){body{background:#111113;color:#f5f5f7}input{background:#1c1c1e;color:inherit}}
main{width:min(22rem,calc(100% - 2rem))}
h1{font-size:1.25rem;margin:0 0 .5rem}
form{display:grid;gap:.75rem;margin-top:1rem}
input{font:inherit;padding:.6rem .75rem;border:1px solid #8e8e93;border-radius:8px}
button{font:inherit;padding:.6rem .75rem;border:0;border-radius:8px;background:#1d1d1f;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){button{background:#f5f5f7;color:#111113}}
input:focus-visible,button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
.error{color:#d70015}
@media (prefers-color-scheme:dark){.error{color:#ff6961}}
`;

function sendPage(res: Response, status: number, title: string, body: string): void {
    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", PAGE_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>
`);
}

// Unknown, revoked and expired links all get this page. The throttled answer
// is the same page with status 429, so it reveals nothing about any name.
function sendNotFoundPage(res: Response, status: number): void {
    sendPage(res, status, "Page not found", "<p>This link does not exist, has expired, or was turned off by the person who shared it.</p>");
}

function sendNotFound(res: Response): void {
    sendNotFoundPage(res, 404);
}

/** A request that named no live publication: counted against the address. */
function sendMiss(req: Request, res: Response): void {
    recordMiss(req);
    sendNotFound(res);
}

function sendPasswordPage(res: Response, prefix: string, wrong: boolean): void {
    sendPage(
        res,
        401,
        "Password required",
        `<p>Enter the password you were given to open this page.</p>
<form method="post" action="${escapeHtml(prefix + UNLOCK_PATH)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus${wrong ? ' aria-describedby="wrong" aria-invalid="true"' : ""}>
${wrong ? '<p id="wrong" class="error" role="alert">That password is not right.</p>' : ""}
<button type="submit">Open</button>
</form>`,
    );
}
