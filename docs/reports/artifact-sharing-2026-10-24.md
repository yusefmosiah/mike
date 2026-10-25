# Sharing documents and artifacts from the viewer: design

Date: 2026-10-24. Design only; no code changed.

## Summary

- **What it is.** From the document viewer, anyone with the right role can publish a document or a generated artifact as a link. The link can open for one of three audiences:
  - signed-in members of the owner's organisation;
  - anyone with the link who also has a password;
  - anyone with the link.
- **Formats.** PDF; Word, PowerPoint and Excel through their PDF rendition, with the original as an optional download; Markdown; images; video and audio; static HTML sites, including the HTML the assistant writes.
- **Chats.** Sharing chats is out of scope.
- **What a link shows.** A link shows a frozen copy of one version, never "whatever the document says now". A later edit is shared only by publishing it.
- **The rule that matters most.** Nothing a user uploaded or a model wrote ever runs on the app's own origin.
  - **Inert formats:** PDF, raster images, sanitised Markdown and video are shown on a share page with a strict content-security policy.
  - **Active content:** HTML sites and SVG are served only from a separate user-content domain, with one subdomain per publication, in a sandbox.
- **Containment.** The public share server can read only published copies, never the document store.
- **Policy.** Public and password links are off by default for an organisation, and always off in strict private mode, until an admin turns them on.
- **Phasing.**
  1. Organisation and password links for inert formats.
  2. Video, then HTML sites on the user-content domain.
  3. Links for named people, links whose content is encrypted in the browser, and embeds.

## What exists today

The facts come from a survey of the code; paths are relative to the repository root.

- **Storage.**
  - One S3-compatible bucket holds everything: R2 in production, RustFS in Compose (`backend/src/lib/storage.ts`).
  - Document bytes live under `documents/{userId}/{docId}/...`. Versions are rows in `document_versions` with a `storage_path` and, for Office files, a `pdf_storage_path` rendition made by LibreOffice (`backend/src/lib/convert.ts`).
  - Uploads go straight to the bucket through presigned PUTs. The limits are 100 MB a file and 20 MB an image.
  - Allowed types are pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt, png, jpg, jpeg, webp, gif, txt, md and csv. HTML, SVG and video are not allowed (`backend/src/lib/documentTypes.ts`).
  - Images are decoded and re-encoded with sharp, which drops their metadata, including GPS (`backend/src/lib/images.ts`).
- **Serving.** Every download route requires a signed-in session and re-checks access:
  - `/single-documents/:id/file`, `/display` and `/url` (an hour-long presigned GET);
  - `/download/:token`.
  - Nothing is public.
- **Access.**
  - Documents have no grants of their own. `ensureDocAccess` (`backend/src/lib/access.ts`) inherits access in this order:
    1. from the project;
    2. from the workflow;
    3. from the organisation (any member);
    4. otherwise, only the person who created it.
  - Roles are viewer < editor < owner, with capabilities such as `access.manage` (`backend/src/lib/permissions.ts`).
  - RLS is on, but has no policies. The TypeScript checks are the authorization layer.
- **Origins and headers.**
  - The app, its `/api` proxy and auth share one origin. There is no user-content domain.
  - The backend sends helmet's headers: `default-src 'none'`, `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`. The Next.js app sends no CSP.
  - Staging sits behind a shared-password gate (`infra/node-a/gate.nix`). Any public link on staging would be behind it too.
- **Viewer.**
  - Formats: PDF.js, a docx renderer and editor, spreadsheets, images, and text/Markdown (react-markdown).
  - There is no iframe anywhere. The one `dangerouslySetInnerHTML` is case-law HTML passed through DOMPurify (`frontend/src/app/components/assistant/CaseView.tsx`).
  - There is no video or HTML viewer.
- **Audit.**
  - `audit_events` requires a `user_id`, so it cannot record an anonymous viewer.
  - No view, download or share events exist.
- **Gaps.** No public routes, no rate limits on reads, no hashing library for passwords (only node's `crypto.scrypt`), no CSP in the web app, and no user-content origin.

## Requirements

1. Publish a document version, or a generated artifact, from the viewer in a few clicks, and get a link.
2. Choose who can open it:
   - **Organisation:** signed-in members only.
   - **Password:** anyone with the link and the password.
   - **Public:** anyone with the link.
3. Formats: docx, Markdown, static HTML sites, images, video, and also PDF, the other Office formats and audio.
4. The owner and organisation admins can see every link, who opened it and when (people by name; anonymous visitors as counts and coarse detail), and can revoke a link at once.
5. Safe by default for a law firm. A careless publish must not leak the following:
   - tracked changes, comments or author metadata;
   - later edits;
   - privileged work.
6. Self-hosted installs without a user-content domain still get organisation and password sharing for inert formats. HTML hosting stays off (fail closed).

## Design

### Publications

A **publication** is a frozen copy of what is shared, plus its settings. It is separate from the document so that the following hold:

- **It is immutable.** A link shows exactly what was reviewed when it was published. "Update this link to the current version" is an explicit action, recorded in the log.
- **It is contained.** Its bytes are copied at publish time to a prefix the share server alone reads: `publications/{publicationId}/...`, ideally in a separate bucket. The share server's storage credentials can read only that prefix. A bug or a compromise in the public path cannot reach the document store.
- **It follows the document's lifecycle.**
  - Deleting the document or its version revokes the publication.
  - Moving the document into a project the publisher cannot manage keeps the publication but flags it to that project's owners.
  - A legal hold keeps the publication's log rows.

### Audiences

| Audience | Who can open it | How it is checked |
| --- | --- | --- |
| Organisation | Signed-in members of the publication's organisation | The app session, on the app origin. The member is recorded by name. |
| Password | Anyone with the link and the password | Unlock form, then a short-lived cookie for that publication |
| Public | Anyone with the link | The link alone |
| People (phase 3) | Named email addresses | A one-time code or magic link to that email, then a cookie |

- **Discoverability.** Every link is unlisted:
  - pages send `X-Robots-Tag: noindex, nofollow` and `<meta name="robots">`;
  - `robots.txt` disallows the share paths;
  - there is no "publish to the web" directory.

  An indexed option is deliberately absent. Search-indexed "publish to web" pages are the largest source of accidental exposure in comparable products ([Netskope](https://www.netskope.com/blog/leaky-links-accidental-exposure-in-google-link-sharing), [Stanford UIT](https://uit.stanford.edu/news/your-google-drive-sharing-more-you-realize)).
- **Personal documents.** A personal document (no organisation) can use the password and public audiences when the deployment allows them. It cannot use the organisation audience.

### Links

- **Token.**
  - The token is 32 random bytes (256 bits), base64url, in the path: `/s/{token}`. Putting it in the path rather than the query string keeps it out of most analytics and proxy query logging.
  - Lookup is by its SHA-256. So the owner can copy the link again later, the token is also stored encrypted with a server key that is kept outside the database. A database leak alone yields no working link.
  - Regenerating issues a new token and kills the old one.
- **Responses.** Revoked, expired, wrong-audience and unknown links all return the same 404 page, with the same timing. A link cannot be confirmed to exist.
- **Expiry.**
  - Public and password links default to 30 days. Organisation links have no expiry by default.
  - An admin can set a maximum expiry.
  - Expiry and revocation take effect at the next request, because every request checks the database.
- **Logs.** Tokens are redacted from request logs, Sentry breadcrumbs and the activity log through the existing redaction helpers.

### Passwords

- **Hashing.** Passwords are hashed with scrypt from `node:crypto`, at OWASP-level parameters (N=2^17, r=8, p=1, 16-byte salt), so no new dependency is needed. Argon2id through `@node-rs/argon2` is the alternative if a dependency is acceptable.
- **Minimum length.** Twelve characters. The dialog offers a generated passphrase and suggests sending it by a different channel from the link.
- **Brute force.** Attempts are limited to:
  - five a minute per IP per publication;
  - fifty an hour per publication across all IPs.

  After that the publication refuses password attempts for 15 minutes and tells the owner. The limits are on the share routes with `express-rate-limit`, like the auth routes in `backend/src/app.ts`.
- **Unlock cookie.**
  - A successful unlock sets a cookie scoped to the publication's path. It is HMAC-signed and carries the publication id and the password's version.
  - It is `HttpOnly`, `Secure` and `SameSite=Lax`, and lasts 12 hours.
  - Changing the password bumps its version and invalidates every cookie.
- **CSRF.** The unlock form carries a token.

### Origins

| Origin | Serves | Why |
| --- | --- | --- |
| App origin (`choir-ip.com` on staging) | The share page's chrome (title, publisher, version, download button) and inert content (PDF.js, sanitised Markdown, images, video), for every audience. The organisation audience is decided here because it needs the session. | Same-origin with the session for organisation links; nothing active is ever served. |
| User-content domain (for example `{brand}usercontent.com`), one subdomain per publication | HTML sites, SVG, and anything a browser would execute | Content on a separate registrable domain cannot reach the app's cookies or DOM ([Google, "Securely hosting user data"](https://security.googleblog.com/2023/04/securely-hosting-user-data-in-modern.html), [web.dev](https://web.dev/articles/securely-hosting-user-data)). One subdomain per publication stops one published site from reading another's storage. Registering the domain on the Public Suffix List makes each subdomain its own site for cookies too. |

- **Share page headers (app origin).** Its CSP is limited to the minimum:
  - `script-src` covers the app's own bundles only.
  - `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and `frame-ancestors 'none'`.
  - `frame-src` is only the user-content domain.

  The page also sends `Referrer-Policy: no-referrer`, so a click on a link inside a document does not carry the share URL to a third party.
- **Inert bytes.** Served with an exact `Content-Type` and `X-Content-Type-Options: nosniff`. Downloads also get `Content-Disposition: attachment`.
- **HTML sites.** They are served from `{publicationId}.{usercontent-domain}` and framed by the share page, or opened full-window. The headers are:
  - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`. There is no `allow-forms`, and no `allow-same-origin` unless the domain is on the Public Suffix List.
  - A `default-src` that allows the site's own files plus `data:`, with outbound network off by default. The owner can allow named external hosts, for example a CDN font.
  - `Cross-Origin-Resource-Policy: same-site`, `nosniff`, and `Referrer-Policy: no-referrer`.
- **Access to an HTML site.** A non-public HTML publication is opened with a short-lived capability URL. The app mints it after checking the audience: an HMAC over the publication id and an expiry of minutes, which sets a cookie on that subdomain. The user-content domain never sees the app session.
- **Self-hosted installs.** `SHARE_CONTENT_ORIGIN` names the domain. When it is unset, HTML and SVG publishing is unavailable. The rest works.

### Formats

| Format | What is published | Notes |
| --- | --- | --- |
| PDF | The file, shown with PDF.js | The PDF's own JavaScript does not run in PDF.js. |
| Word, PowerPoint, Excel | The PDF rendition by default; the original as an optional download | See "Leaks inside Office files" below. Rendering an editable docx for anonymous viewers would ship the editor to the public; the PDF is safer and looks the same everywhere. |
| Markdown | Rendered on the server to HTML through a sanitiser (no raw HTML, http(s) and mailto links only, the same rules as `CaseView`), shown inline | Also downloadable as `.md`. |
| Images (png, jpg, webp, gif) | The re-encoded copy | Metadata is already stripped by sharp. |
| SVG | Rasterised to PNG for inline display; the SVG itself only on the user-content domain | SVG can carry script. |
| Video (mp4 H.264/AAC, webm) and audio (m4a, mp3) | The file, streamed with HTTP Range requests from short-lived presigned URLs (5 minutes, re-minted by the page) | A new upload type, with multipart uploads and a larger limit (2 GB). Each file is probed with `ffprobe` in the processing job, so a mislabelled file or a polyglot is refused. A poster frame is taken. Transcoding is not in phase 2. |
| Static HTML site | A zip or folder upload, or an artifact the assistant wrote | Checked when unpacked: no absolute paths, `..` or symlinks; at most 2,000 files and 200 MB; a decompression-ratio limit against zip bombs; an `index.html` required. Each file is stored as `publications/{id}/site/{path}` with its content type from the extension. |

Downloads can be turned off for a publication. The dialog says plainly that turning them off hides the button but cannot stop someone who can view the content from saving it.

### Leaks inside Office files

This is the main risk for legal work, so the defaults lean hard against it:

- **Before publishing a Word file, check what it contains:**
  - tracked changes;
  - comments;
  - hidden text;
  - author and company metadata;
  - document properties;
  - earlier authors' names in the revision history.

  If anything is found, the dialog says what it found.
- **PDF rendition.** The PDF must be made from the accepted-changes view with comments off. This needs verifying: LibreOffice prints tracked changes when the document is saved with "show changes" on. If verification fails, publishing makes a clean copy first.
- **The original as a download.** Offered as a "clean copy" by default: changes accepted, comments, hidden text and personal metadata removed, saved as a new version that shows in the document's history. The unchanged original is a separate, explicit choice with a warning.
- **The same check on other formats.** PowerPoint speaker notes and hidden slides, Excel hidden sheets, and PDF annotations and attachments.

### Who can publish, and organisation policy

- **Organisation audience:** a person needs `content.edit` on the document (editor or above).
- **Password and public audiences:** a person needs `access.manage` on the document (owner), or the organisation's admin policy must allow editors.
- **Organisation settings (admins):**
  - which audiences are allowed: organisation only (the default), plus password, plus public;
  - a maximum expiry;
  - whether a password is required for anything outside the organisation;
  - which formats may be public;
  - whether HTML sites are allowed.
- **Strict private mode:** password and public links are refused whatever the policy says, matching the mode's other refusals.
- **Ethical walls:** once `matter_id` and walls land (the observability plan), publishing from a walled matter is refused unless the wall allows it. An organisation link resolves its members at view time, so someone walled off from the matter is refused there too.

### Data model (sketch)

```sql
create table public.publications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  document_id uuid references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete cascade,
  kind text not null check (kind in ('file', 'site')),
  audience text not null check (audience in ('org', 'password', 'public', 'people')),
  token_hash bytea not null unique,
  token_sealed bytea not null,            -- the token, encrypted with a server key, so the owner can copy it again
  password_hash text,
  password_version int not null default 0,
  allow_download boolean not null default false,
  title text not null,
  settings jsonb not null default '{}',   -- external hosts allowed, banner, rendition choice
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.publication_files (
  publication_id uuid not null references public.publications(id) on delete cascade,
  path text not null,                      -- '' for a single file
  storage_path text not null,
  content_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  primary key (publication_id, path)
);

create table public.publication_views (
  id bigserial primary key,
  publication_id uuid not null references public.publications(id) on delete cascade,
  at timestamptz not null default now(),
  viewer_user_id uuid references auth.users(id) on delete set null,  -- null when anonymous
  visitor text,      -- HMAC of IP and user agent with a key rotated daily: counts visitors, does not identify them
  outcome text not null check (outcome in ('viewed', 'downloaded', 'password_failed', 'denied', 'rate_limited'))
);
```

- **Activity log.** Creating, changing, refreshing and revoking a publication are actions by a person, so they go to `audit_events` as `publication.*`. Views go to `publication_views`, because an anonymous visitor has no user id. The unified activity log in `docs/reports/unified-observability-2026-10-25.md` should take both, with an `anonymous` actor kind.
- **Row-level security.** Tables get RLS enabled with no policies, like the rest of the schema. The authorization layer is the publications module, which goes through the documents facade for every check on the source document (AGENTS.md).

### Serving

- **Module.** A new backend module, `backend/src/modules/publications/`:
  - Authenticated routes create, list, update and revoke publications, and mint capability URLs.
  - Unauthenticated routes, under `/public/s/:token`, serve the page data and bytes, with rate limits and uniform 404s.
- **Next.js.** A `/s/[token]` page outside the signed-in layout renders the chrome. It has its own CSP, set in a `headers()` block or by the page.
- **HTML sites.** The user-content domain is a separate listener: a Caddy site in front of a small file server, or the same module mounted on that host. It reads only `publications/`.
- **Caching.** Cached responses are private or short-lived (`Cache-Control: private, max-age=60` for bytes behind a cookie, and `no-store` for pages). Revocation takes effect within a minute. With a CDN later, revoking also purges the publication's paths.
- **Load and abuse.**
  - Per-IP and per-publication limits on page views and bytes.
  - Video bytes go straight from presigned URLs, so they do not pass through the API.
  - A "report abuse" link on public pages.
  - Public HTML sites only for organisations, never personal accounts, because free HTML hosting attracts phishing. The sandbox blocks forms by default, and a thin banner names the publishing organisation.

### Threats and how the design answers them

| Threat | Answer |
| --- | --- |
| Link forwarded or posted beyond its audience | Password or organisation audiences for sensitive material; expiry; the view log shows unexpected visitors; revocation is instant |
| Token guessed or enumerated | 256-bit tokens; only hashes stored; uniform 404s; rate limits |
| Password brute-forced | scrypt; per-IP and per-publication limits; lockout; owner notified |
| URL leaked through a referrer or logs | Token in the path; `Referrer-Policy: no-referrer`; tokens redacted from logs and Sentry |
| Script in a published file attacks the app (XSS) | No active content on the app origin; strict CSP; nosniff and exact content types; SVG rasterised; HTML only on the user-content domain, in a sandbox |
| One published site attacks another | One subdomain per publication; the Public Suffix List; no `allow-same-origin` until listed |
| Phishing or malware hosted on the product | Public HTML only for organisations; no forms by default; publisher banner; abuse reports; an allowlist of file types; video probed; optional ClamAV scan in the processing job |
| Hidden content in Office files | Scan before publishing; a clean copy by default; PDF from the accepted-changes view; notes and hidden sheets flagged |
| Later edits exposed | Each publication is pinned to one version; refreshing it is explicit and logged |
| Search engines index a link | noindex everywhere; no directory; no "publish to web" |
| Clickjacking of share pages | `frame-ancestors 'none'` (an embed option in phase 3 would name allowed parents) |
| Public path compromised | The share server's credentials read only `publications/`; no writes besides the view log |
| Privileged or walled material published | Role and policy gates; a confirmation for public links ("anyone with the link"); ethical-wall check; strict private mode refuses |
| Staging shows a link to the public | The staging gate stays in front; the share domain on staging is gated too |

## User experience

- **Share button.** A Share button in the viewer's tab actions opens a dialog:
  1. **Who can open it:** Only people in {organisation} (default), Anyone with the link and password, or Anyone with the link. An option is shown only when policy allows it.
  2. **What is shared:** this version (named, with its date). Office files show the PDF rendition, with a choice of "Also allow downloading a clean copy". Any findings from the content scan appear here in plain words, with the fix offered.
  3. **Expiry and download:** both shown with their defaults.
  4. **The link:** copy, and for a password link the generated password, copied separately.
- **Existing links.** The same dialog lists the document's links, each with its audience, expiry, views ("12 views, 3 visitors, last opened yesterday") and Revoke.
- **Settings.**
  - "Shared links" lists everything a person has shared.
  - Admins see the whole organisation's links, with a policy panel.
- **Share page.**
  - It shows the title, the publishing organisation, "Version 4, published 24 October 2026", the content, a download button when allowed, and a line saying it is a shared copy and may be out of date.
  - The product name comes from the brand setting, as AGENTS.md requires.
  - The page follows the design system's content-fitting rules: long titles and organisation names wrap.
- **Assistant artifacts.** HTML or a document the assistant wrote gets the same Share action from its card, through the same pipeline. The assistant never publishes on its own; publishing is always a person's click.

## Phases

1. **Organisation, password and public links for inert formats.**
   - Formats: PDF, Office as PDF, Markdown, images.
   - Pinned versions, the publications module, the share page on the app origin, the views log, rate limits, organisation policy (outside audiences off by default), the Office content scan with clean copies, and revocation.
   - Tests: route tests for every audience and refusal; Playwright for the share page and the unlock flow.
2. **Video and audio, then HTML sites and SVG.**
   - Video and audio upload and streaming.
   - HTML sites and SVG on the user-content domain with per-publication subdomains and capability URLs.
   - Apply to the Public Suffix List early, because inclusion takes weeks.
3. **Later additions.**
   - Links for named people (email code), an embed option with an allowlist of parents, and watermarking.
   - Links whose content is encrypted in the browser, with the key in the URL fragment, which the server never sees. This is like Firefox Send, for the most confidential material. A server preview is then impossible and the viewer decrypts in the browser.

## Questions for the owner

1. The user-content domain: which name, and should it be registered and submitted to the Public Suffix List now?
2. Defaults: is "organisation only, 30-day expiry for anything outside it, downloads off" right?
3. Can editors publish outside the organisation, or only owners and admins?
4. Should public HTML sites be allowed at all in phase 2, or only organisation and password ones?
5. Should views by signed-in members be shown to the owner by name? This is a privacy choice inside the firm.
