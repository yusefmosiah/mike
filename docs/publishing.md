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
| PDF | The PDF, in the browser's own viewer. |
| Word, PowerPoint | Their PDF rendition. A file without one cannot be published yet. |
| Spreadsheets, CSV | Not publishable yet. |

- **The link shows a frozen copy.** Publishing copies the version's files to `publications/{id}/` in object storage. A later edit is shared only by publishing again.
- **Missing files.** References the server could not find are listed after publishing, so the publisher can add the files and publish again.
- **Limits.** A page and its files are limited to 200 files and 200 MB.
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
- **Expiry.** 7, 30 (the default) or 90 days, or never.
- **Revoking.** The publisher can revoke a link at once. Revoking deletes the copied files.
- **Refused links.** Unknown, revoked and expired links all show the same "page not found".
- **Recording.** Making and revoking links are recorded in the activity log (`publication.created`, `publication.revoked`). Views are not tracked.
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

Tokens are 128 bits, in lowercase base32, so a token is a valid DNS label.
The database stores a SHA-256 of each token for lookup, plus a copy sealed
with the server key.

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

The staging domain is temporary. The product will get two new domains:

1. **The app's domain.**
2. **A content domain for published links.** It needs wildcard DNS (`*.<content domain>`) pointing at node-a and a wildcard TLS certificate. Caddy serves it from `PUBLICATION_PORT`, outside the staging gate.

Until then, publishing works locally as above, and on staging only once a
content domain is set up. Before anyone other than the owner can publish,
submit the content domain to the Public Suffix List, so that the browser
treats each subdomain as its own site for cookies too.

## Not built yet

- **Policy settings and admin view.** Organisation policy, and a view of every link in the organisation for admins.
- **Content scan.** The Office scan for tracked changes, comments and metadata, with a clean copy by default. Until it exists, Word files publish only their PDF rendition, so check that rendition before publishing.
- **Video and audio uploads.** A page can embed media by URL, but media files cannot be uploaded as documents yet.
- **View counts.**
- **Removing stored copies when a document is deleted.** Deleting a document deletes its publications' rows, so its links stop working, but the copied files stay in storage until they are cleaned up.
