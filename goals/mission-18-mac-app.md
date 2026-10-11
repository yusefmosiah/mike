# Mission 18: The Mac app

Owner direction, 2026-10-10: build the wrapper first (a window around the
hosted web app) and leave upstream's self-contained local mode for later. The
plan is [`docs/mac-app.md`](../docs/mac-app.md); the app is in
[`desktop/`](../desktop/README.md).

## Built (2026-10-10), not accepted

- **The wrapper from upstream.** `desktop/` holds upstream's Electron shell
  from `open-legal-products/mike` commit `89dc8323`: `src/main.js` (window,
  menus and shortcuts, single instance, origin fence, popups, downloads),
  `src/preload.js`, `src/pages/connect.html`, `assets/`, the two
  electron-builder configs and the CDP e2e suites. Left out: `src/local/`,
  the welcome and local-boot pages, the local build configs and scripts.
- **Our changes.**
  - Default server `https://choir-ip.com` (staging).
  - Local mode removed from `main.js` (the first-run chooser, the local boot,
    the `start-local`, `local-available`, `choose-cloud` and
    `guest-credentials` channels, the quit-time database stop), from the
    preload bridge and from the connection screen.
  - `appId` `com.yusefmosiah.mike`, a placeholder for the owner to rename.
    The product name stays "Mike".
  - Electron 44.7.0 instead of upstream's 38 (38 is out of security support
    and `npm audit` flags a use-after-free in it); electron-builder 26.15.3,
    playwright-core 1.64.0. `npm audit` still reports moderate findings in
    electron-builder's own dependencies (build-time only).
- **Connector sign-in (backend).** The OAuth popup pages
  (`backend/src/modules/user/user.routes.ts`) now send
  `Cross-Origin-Opener-Policy: unsafe-none`, so the popup keeps
  `window.opener` when it returns from the provider's consent page, and
  escape `<` in the embedded message. Ported from the same upstream commit.
  Helmet's same-origin default still applies everywhere else.

## Receipts

```text
$ npm run dist --prefix desktop
  • packaging       platform=darwin arch=arm64 electron=44.7.0 appOutDir=dist/mac-arm64
  • skipped macOS code signing  reason=identity explicitly is set to null
$ defaults read desktop/dist/mac-arm64/Mike.app/Contents/Info.plist CFBundleIdentifier
com.yusefmosiah.mike
$ du -sh desktop/dist/mac-arm64/Mike.app
289M
```

The packaged app, launched with a debugging port and a throwaway settings
directory, read over raw CDP (`Runtime.evaluate`, `Page.captureScreenshot`):

```text
default server:  {"url":"https://choir-ip.com/__gate?next=%2F","title":"Private preview", ...}
--server-url=http://127.0.0.1:9:
                 {"url":"file:///.../Mike.app/Contents/Resources/app.asar/src/pages/connect.html?server=http%3A%2F%2F127.0.0.1%3A9",
                  "text":"Connect to Mike\n\nThe Mike server isn't reachable. ..."}
```

Signed in (a GoTrue session minted on node-a from a magic link verified
there, plus a gate cookie signed with the gate's key, set over CDP; no
password typed; the cookie file was deleted on both machines afterwards):

```text
set __Host-mike-session true
set mike_gate true
{"url":"https://choir-ip.com/assistant","title":"Mike - Legal AI Platform","text":"Mike\nAssistant\nIDE\nProjects\nLibrary\n..."}
{"url":"https://choir-ip.com/workflows?tab=all", ...}
```

The Workflows screenshot shows the sidebar, the account and the workflow
table inside the app window.

Connector popup header, in the route tests:

```text
$ npm test --prefix backend -- src/__tests__/integration/connectors.routes.test.ts src/__tests__/integration/googleWorkspace.routes.test.ts
      Tests  42 passed (42)
```

## Not done

- **By hand:** the menu shortcuts (CDP cannot press native menu items), and
  whether the inset traffic lights overlap the sidebar's logo (screenshots
  over CDP do not include the native title bar).
- **The e2e suites** (`npm run e2e`, `npm run e2e:flows`) need the local e2e
  stack; not run yet.
- **A connector sign-in in the app** against staging (needs a connector
  configured there).
- **Signing and notarization** need the owner's Apple Developer ID.
- **CI:** no job builds the app yet; a macOS runner job is a cost decision.
