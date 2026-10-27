# Publishing documents as links

A document's owner can publish one version as a link that opens outside the
app: to anyone with the link, with or without a password, and optionally only
to people signed in to the app who can open the document. The design,
with its threat model, is `docs/reports/artifact-sharing-2026-10-24.md`; this
page is how it works and how to run it.

## What gets published

| Document | What the link shows |
| --- | --- |
| HTML (`.html`, uploaded or written by the assistant's `generate_html` tool) | The page itself, as a normal web page: scripts run, YouTube, Vimeo, Spotify and SoundCloud players embed, media, fonts and styles load over https. Files the page refers to by a relative path (`<img src="site-plan.png">`, `<a href="part-2.html">`) are found by filename among the documents beside it, in the same project or, for a library document, the publisher's library, and published with it. Linked HTML pages are followed the same way. |
| Markdown, plain text | A readable article page. |
| PNG, JPEG, WebP, GIF | A page showing the image. |
| Audio (MP3, M4A, WAV, OGG), video (MP4, WebM, MOV) | A page with the browser's own player. The file is served beside it with byte ranges, so it streams and seeks. |
| PDF | The PDF, in the browser's own viewer. |
| Word, PowerPoint | Their PDF rendition. A file without one cannot be published yet. |
| Spreadsheets, CSV | Not publishable yet. |

- **The link follows the document.** A new link serves the document's current version: editing the document, or replacing its version, changes what visitors see. A followed link stores no copy of the files; the content server builds what it serves on each request, including the files an HTML page refers to. The publisher can freeze a link instead, which copies the current version and leaves the link at it until it is frozen again; existing links made before following was added stay frozen at the version they copied.
- **Missing files.** References the server could not find when freezing are listed after publishing, so the publisher can add the files and publish again. A followed page resolves them at request time, so a missing file appears as soon as the document beside it exists.
- **Limits.** A page and its files are limited to 200 files and 500 MB.
- **Audio and video in a page.** A page embeds them as it does images, by filename: `<video controls src="walkthrough.mp4">`, `<audio controls src="interview.mp3">`, or a `<source>` inside either. The files are uploaded as documents beside the page.
- **Assistant-written HTML.** The assistant writes the page with `generate_html`.

## Asking the assistant to publish

The `publish_document` tool lets a person ask in a prompt ("publish this as a
link with a password"). It works like the vault's credential request: the
assistant only proposes.

- **The card.** The turn pauses on a card with the assistant's suggestions (password or not, signed-in only or not, expiry) and its reason. The person can change any of them, sets the password themselves, and clicks Publish, or declines.
- **The password.** The card creates the publication directly through the API. The password goes from the card to the server, never into the conversation, and the assistant never sees it.
- **What the assistant learns.** The answer carries only the publication's id. The server checks it is the person's own publication of that document, then tells the assistant the link, who can open it and when it expires.
- **When it is offered.** The tool is offered only when publishing is on and the conversation can pause for the person: not in Auto Mode, and not to a guest in someone else's workstation. Before pausing, it refuses anything the person could not publish (not the owner, an unsupported type, no PDF rendition).

## Who can publish, and who can open a link

- **Publishing.** Only the document's owner can publish (`access.manage`). For a personal document that is the person who created it.
- **Audiences:**
  - **Anyone with the link.**
  - **Anyone with the link and the password.** The password must be at least 12 characters and is hashed with scrypt. A correct password sets an `HttpOnly` cookie for that one link, which lasts 12 hours.
  - Wrong passwords are limited to 5 a minute from one address and 50 an hour for one link.
  - **Signed in only.** This can be combined with either of the above. A visitor without access is sent to the app (`/published`), signs in if needed, and gets in only if they can open the source document there: the same rule as the app's own sharing. The app then sends them back with a two-minute grant, which the content server exchanges for a cookie on that link's origin. The cookie lasts an hour, so someone who loses access to the document loses the link within the hour. With a password as well, the password is asked after sign-in.
- **Expiry.** 7, 30 (the default) or 90 days, or never. The publisher can change it after making the link (including removing it).
- **Revoking.** The publisher can revoke a link at once. Revoking deletes any copied files.
- **Editing.** The publisher can change a link's expiry, audience and password, whether it needs a signed-in visitor, and whether it follows the document. Changing the password invalidates every unlock cookie, so visitors must enter the new one.
- **Refused links.** Unknown, revoked and expired links all show the same "page not found". A followed link whose document was deleted, or whose version can no longer be served, does too.
- **Recording.** Making, editing and revoking links are recorded in the activity log (`publication.created`, `publication.updated`, `publication.revoked`). Views are not tracked.
- **In the app.** Publish appears in the document side panel and in a viewer tab's menu, when this install publishes and the file type can be published.

## Where links are served

Published pages are served by a separate listener, the content server, on a
separate domain. A page on that domain cannot reach the app's cookies,
storage or API session. That separation, not a sandbox, is what makes it safe
to let published pages run scripts and embed players.

| Setting | Meaning |
| --- | --- |
| `PUBLISHING=open` | Turns publishing on. Anything else, or unset, is off. Strict private mode (`STRICT_PRIVATE_MODE=true`) keeps it off. |
| `PUBLICATION_BASE_URL` | The content domain, for example `https://pub.example.com`. |
| `PUBLICATION_URL_STYLE` | `subdomain` (default): links are `https://<token>.pub.example.com/`, each its own origin, which needs wildcard DNS and a wildcard certificate. `path`: links are `https://pub.example.com/<token>/`, for a host without wildcard DNS; all publications then share one origin, which is acceptable only while one person publishes. |
| `PUBLICATION_PORT` | The port the content server listens on, in the backend process. The proxy sends the content domain here. |
| `FRONTEND_URL` | The app's address, where signed-in-only links send visitors to sign in. |
| `PUBLICATION_SECRET` | 32 or more characters. It seals link tokens (so the owner can copy a link again) and signs password cookies, sign-in grants and member cookies. It falls back to `AUTH_HANDOFF_ENCRYPTION_SECRET`; with neither, publishing is off. |

Rules for the content domain:

- **A different registrable domain from the app.** It must be a separate domain, not a subdomain of the app's.
- **Not behind a staging gate.** Visitors must reach it without one.
- **The proxy keeps the `Host` header.** The subdomain carries the token.

### Link names

A link's name (its token) is the only secret of an "anyone with the link"
page, and in the subdomain style it is a DNS label.

- **Format.** Four words and four numbers joined by hyphens, such as `34-chapeau-1207-shiso-calabaza-3981-mango-602`. The numbers take four of the eight places, in any of the 70 possible arrangements, and each is 0 to 4095 written without padding (3.73 digits on average). Lowercase `a-z` and digits only, at most 63 characters, the limit for a DNS label.
- **Words.** Drawn uniformly from `backend/src/modules/publications/linkWords.ts`: about 2,900 plain-ASCII words from English, French, Spanish, Italian, Portuguese, German, Dutch, Japanese, Swahili, Hawaiian, Finnish, Turkish, Indonesian and a few other languages. The list has at least 2048 words and may grow; add words only by the rules in that file's header.
- **Numbers.** Uniform from 0 to 999, written without padding.
- **Randomness.** Every draw uses `crypto.randomInt`.
- **Entropy.** `4 * log2(words) + 4 * 12 + log2(70)`: at least 98.1 bits with 2048 words and about 100.2 with the list as shipped (`linkTokenEntropyBits`). The throttle below slows guessing further; a password is still the right choice for anything that must stay private from someone who sees the link.
- **Older links.** Names made before word links are 26 characters of base32 (128 bits); the first word links (three words and two numbers, about 58 bits) were made on 2026-10-25. Both keep working. The server accepts a name by its structure, not by whether its words are in the list, so the list can grow without breaking links.
- **Storage.** The database stores a SHA-256 of each token for lookup (unique; a collision makes the insert retry with a new name, up to three times), plus a copy sealed with the server key.

### Guessing limit

A client address that asks the content server for 30 names that do not exist
within 10 minutes (malformed, unknown, revoked or expired all count alike) gets
`429` with the same "page not found" page as any other refusal, and no
database lookup, for the rest of the window. While throttled, an address is
refused every request on the content server, links that do exist included,
because answering some of them would reveal which names exist. Requests for real
links, and for missing files inside them, are not counted. The address is
`req.ip`, which Express derives from `X-Forwarded-For` as set by Caddy
(`TRUST_PROXY_HOPS`, default 1), as for the other limiters. The count is kept in
memory in the backend process, so a restart clears it.

### Headers on a published page

- **Pages and SVG.** They carry a content-security policy:
  - `https:` is allowed for scripts, styles, images, media, fonts and `fetch`.
  - Frames are allowed only from the video and audio players named above.
  - `form-action 'none'`: forms cannot submit, so a published page cannot collect passwords.
  - `object-src 'none'` and `frame-ancestors 'none'`.
- **On every response:**
  - `X-Robots-Tag: noindex, nofollow`;
  - `nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Cache-Control: private, max-age=60`.
- **robots.txt.** It disallows everything.
- **YouTube embeds.** YouTube refuses to play an embed whose request carries no Referer. So each YouTube `<iframe>` gets `referrerpolicy="strict-origin-when-cross-origin"` when published, unless the author chose a policy. YouTube therefore sees the publication's origin, which in the subdomain style contains its token. Use a password for anything that should not be opened by someone who learns the link.

## Running it locally

```bash
PUBLISHING=open \
PUBLICATION_BASE_URL=http://pub.localhost:3002 \
PUBLICATION_PORT=3002 \
PUBLICATION_SECRET="$(openssl rand -hex 32)" \
npm run dev --prefix backend
```

Browsers resolve every `*.localhost` name to this machine, so subdomain links
such as `http://<token>.pub.localhost:3002/` work without any DNS setup.

## Domains for this install

Staging publishes at `https://<token>.choir.chat/` (`infra/node-a/staging.nix`):

- **DNS.** `*.choir.chat` is a proxied (orange-cloud) record pointing at the same address as staging, `choir-ip.com`. Cloudflare's universal certificate covers `*.choir.chat` at the edge.
- **Origin certificate.** Caddy on node-a serves `*.choir.chat` with a Cloudflare Origin CA certificate (`/var/lib/publication-tls/`, valid until 2041). The zone's SSL mode is Full (strict). Its private key was generated on node-a and has never left it. A wildcard certificate keeps link tokens out of the public Certificate Transparency logs, where a certificate per link would list every token.
- **Caddy.** The content site is outside the staging gate, and its access log is off because hostnames carry tokens. Behind Cloudflare, Caddy takes the client's address from `CF-Connecting-IP`, but only from Cloudflare's address ranges. Cloudflare reaches node-a through the OVH load balancer (147.135.24.51), which sends a PROXY v2 header naming the Cloudflare address; Caddy honours that header only from the balancer's range, 10.88.0.0/16. The balancer setting is `proxyProtocolVersion` on node-a's server in the TCP farm for port 443, and turning it off without removing Caddy's `proxy_protocol` wrapper is safe. Every upstream then gets that one address in `X-Forwarded-For`.
- **Backend.** `staging.nix` writes `PUBLISHING=open`, `PUBLICATION_BASE_URL=https://choir.chat` and `PUBLICATION_PORT=3002`, and generates `PUBLICATION_SECRET` once. The compose override binds the port to loopback.
- **Zone settings.** Email obfuscation is off in both zones, because it rewrites HTML. The minimum TLS version is 1.2.
- **Staging zone.** `choir-ip.com` is proxied too, with Full (strict) SSL and a cache rule that bypasses Cloudflare's cache for everything except `/_next/static/`. Without that rule, a signed document download could outlive its expiry at the edge.

Limits of the current setup:

- **Uploads.** Cloudflare's free plan limits a request body to 100 MB.
- **Idle streams.** It closes a response after 100 seconds with no bytes.
- **Client addresses.** The staging address forwards to node-a from the hosting network's own addresses, not Cloudflare's. So Caddy, and so the gate and rate limits, still see the forwarder rather than the visitor, as they did before Cloudflare.

Before anyone other than the owner can publish, submit the content domain to the Public Suffix List, so that browsers treat each subdomain as its own site for cookies too. The product's own domains will replace these later.

## Not built yet

- **Policy settings and admin view.** Organisation policy, and a view of every link in the organisation for admins.
- **Content scan.** The Office scan for tracked changes, comments and metadata, with a clean copy by default. Until it exists, Word files publish only their PDF rendition, so check that rendition before publishing.
- **Larger video.** Audio and video upload as documents up to the 100 MB every upload is held to, which is also what Cloudflare's free plan lets one request carry. Longer video needs multipart uploads, which send a file in parts.
- **Transcoding and poster frames.** Media is stored and played as uploaded. A format the visitor's browser cannot play (some MOV files outside Safari, OGG in older Safari) shows the player's own error.
- **View counts.**
- **Removing stored copies when a document is deleted.** Deleting a document deletes its publications' rows, so its links stop working, but the copied files stay in storage until they are cleaned up.
