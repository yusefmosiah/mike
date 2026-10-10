# Mac app (planned)

**Status:** planned, not started. The owner chose on 2026-10-10 to build the
wrapper first and to leave the self-contained local mode for later.

The Mac app is a desktop window around the Mike web app. It loads a deployed
Mike server, by default ours, so every web change reaches the app without a new
release. The app adds only what a browser tab cannot: a dock icon, a menu bar,
keyboard shortcuts, in-app downloads, and a connection screen when the server
is unreachable.

## Source

Upstream built it as an Electron shell in `open-legal-products/mike` commit
`89dc8323` ("[Mac app] Self-contained local workspace with a simple first run",
2026-10-09), under `desktop/`. Read `desktop/README.md` in that commit for the
full behavior. Of the wrapper, only `desktop/` comes over. The commit's
backend and login-page changes belong to the local mode and are not part of
the wrapper.

Files the wrapper needs from that commit:

| File | What it does |
|---|---|
| `desktop/src/main.js` | Window, menu bar, shortcuts, window-state persistence, single-instance lock, the origin fence, popups, downloads |
| `desktop/src/preload.js` | The small bridge the connection screen uses to change servers |
| `desktop/src/pages/connect.html` | Connection screen ("can't reach server", change server) |
| `desktop/assets/` | Icon source, `icon.icns`, macOS entitlements |
| `desktop/electron-builder.json`, `electron-builder.release.json` | Packaging, and the signed release build |
| `desktop/package.json`, `package-lock.json` | Electron and electron-builder |
| `desktop/e2e/app.e2e.mjs`, `flows.e2e.mjs`, `helpers.mjs` | Tests that drive the packaged app against a real stack |

Left out: `desktop/src/local/`, `pages/local-boot.html`, `pages/welcome.html`,
`electron-builder.local.json` and the `scripts/*-local-stack*` files. Those
run the whole stack on the Mac (see "Later: local mode" below).

## What the wrapper does

- **Origin fence.** Only the configured Mike server renders in the app. Other
  links (cited sources, documentation) open in the default browser, so
  third-party pages never run inside the app.
- **Popups.** Connector sign-in popups stay in the app so they can report back
  to the page that opened them. Popups get no access to the app's bridge.
- **Downloads.** Document downloads are saved to `~/Downloads` without a
  dialog. Navigation started by a popup is dropped, so a hostile page cannot
  trigger a download.
- **Menus and shortcuts.** ⌘N new chat; ⌘1 to ⌘6 for Assistant, Projects,
  Library, Tabular Review, Workflows and History; ⌘, product settings; ⌘⇧,
  change server. Also a right-click menu with spellcheck suggestions.
- **Minimum window size.** 800×600, which keeps the web app above its 768px
  mobile breakpoint.

## What we change

1. **Default server.** Replace `https://app.mikeoss.com` with our deployment
   (staging today: `https://choir-ip.com`) in `main.js` and the connection
   screen.
2. **Name and identity.** Set `productName`, `appId` and the menu labels to our
   product name, and replace the icon if we brand differently.
3. **Remove local mode.** Delete the "Start on this Mac" path from `main.js`,
   the connection screen and the preload bridge, including the guest-credential
   bridge. Without the local stack it would only fail.
4. **Connector sign-in fix (backend, independent of the app).** Upstream found
   that Helmet's default `Cross-Origin-Opener-Policy: same-origin` cuts the
   connector OAuth callback popup off from its opener, in every browser, so
   the app never hears the result. Their fix sends `unsafe-none` on that one
   callback route and escapes `<` in the embedded error detail. Our backend sets
   no exception, so we very likely have the same bug. Port it (backend part of
   `89dc8323`, `user.routes.ts`) and verify it in a browser first.

## Release

- **Signing.** Without an Apple Developer ID ($99 a year) macOS warns before
  opening the app. A public download needs the signed and notarized build
  (`electron-builder.release.json`).
- **Architecture.** Upstream targets Apple Silicon only. An Intel or universal
  build is a separate decision.
- **Updates.** The app needs a new release only when the wrapper itself
  changes. Web changes arrive from the server.

## Verification plan

- `npm run dist` builds `desktop/dist/mac-arm64/<App>.app`.
- `desktop/e2e/app.e2e.mjs` and `flows.e2e.mjs` launch the packaged app over
  CDP against the local e2e stack (`scripts/e2e-local-stack.sh`): sign up,
  create a project, a connector popup with a live opener, a download kept in the
  app, and an external link handed to the browser.
- Menu shortcuts cannot be driven over CDP. Check them by hand.

## Later: local mode

Upstream's local mode runs Postgres, GoTrue, the backend and the frontend on the
Mac, with no server. Its build scripts compile our own backend and frontend from
this repository, but its supervisor is written for upstream's stack. To adopt
it we would:

- drop PostgREST and the `apikey` gateway, since our backend talks to Postgres
  directly;
- rewrite the backend environment block (`DATABASE_URL` for the chat engine, our
  `AUTH_URL` and `AUTH_SERVICE_KEY` names);
- port upstream's filesystem storage driver and download tokens (about 600
  lines with tests), or bundle a storage server;
- apply migrations through the `schema_migrations` ledger (`backend/scripts/migrate.sh`);
- port the guest sign-in on the login page by hand, because it conflicts with
  our sign-up and password changes;
- decide how local users supply model keys, since the app cannot carry the
  deployment's OpenCode Go or OpenRouter keys.

Already compatible: the background queue runs on Postgres without Redis by
default, GoTrue is the same version (v2.189.0), and the schema needs only
`pgcrypto` and `pg_trgm`. Expect one to two weeks of work and a 250 to 350 MB
download.
