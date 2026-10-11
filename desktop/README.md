# Mike for Mac

A native macOS window around the Mike web app, adapted from upstream's
Electron shell (`open-legal-products/mike` commit `89dc8323`, `desktop/`),
without upstream's local mode. The plan and the decisions behind it are in
[`docs/mac-app.md`](../docs/mac-app.md); progress is in
[`goals/mission-18-mac-app.md`](../goals/mission-18-mac-app.md).

The app loads a deployed Mike server, by default ours
(`https://choir-ip.com`), so every web change reaches the app without a new
release. It adds only what a browser tab cannot:

- a menu bar mirroring the sidebar, with shortcuts (below);
- an inset traffic-light title bar, remembered window size and position, one
  instance;
- a right-click menu (copy and paste, spelling suggestions, link actions);
- external links in the default browser; sign-in popups and document
  downloads handled in the app (below);
- a connection screen when the server cannot be reached (⌘⇧, to change
  servers), instead of a Chromium error page.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘N | New chat (`/assistant`) |
| ⌘1 | Assistant |
| ⌘2 | Projects |
| ⌘3 | Library |
| ⌘4 | Tabular Review |
| ⌘5 | Workflows |
| ⌘6 | History |
| ⌘, | Settings (the product's settings page) |
| ⌘⇧, | Change server (the connection screen) |
| ⌘⇧H | Home |

## Popups, sign-in and downloads

- **Only the configured server renders in the app.** Other links open in the
  default browser, so third-party pages never run inside the app.
- **Script-opened popups** (`window.open("about:blank")`) become child
  windows. Connector sign-in uses this: the popup goes through the provider's
  consent pages and the callback reports back with
  `window.opener.postMessage`, so the whole chain stays in the popup. Popups
  never get the shell's bridge, may only navigate over http(s), and their own
  popups follow the same rules.
- **Same-window navigation to another origin** is probed with a one-byte
  ranged GET. An attachment or binary (Mike's signed document links) is saved
  to `~/Downloads` without a dialog, with Finder-style ` (2)` names; anything
  else opens in the default browser. A navigation started by a popup is
  dropped, so a hostile page cannot start a download.

## Run in development

```bash
cd desktop
npm install
npm start                                       # https://choir-ip.com
npm start -- --server-url=http://localhost:3000 # a local frontend
```

`--server-url=` wins over `MIKE_SERVER_URL`, which wins over the saved
setting (`~/Library/Application Support/Mike/settings.json`), which wins over
the default.

| Variable | Effect |
| --- | --- |
| `MIKE_SERVER_URL` | server URL (only `--server-url=` overrides it) |
| `MIKE_USER_DATA_DIR` | settings and the single-instance lock somewhere else (tests) |
| `MIKE_DOWNLOAD_DIR` | download folder instead of `~/Downloads` |
| `MIKE_E2E_CAPTURE_EXTERNAL` | file; "open in browser" URLs are appended here instead |
| `MIKE_E2E_DOWNLOAD_LOG` | file; each finished download appends a JSON line |

## Package

```bash
npm run dist                  # dist/mac-arm64/Mike.app, unsigned, Apple Silicon
open dist/mac-arm64/Mike.app
```

An app you built yourself opens without a Gatekeeper prompt; the warning only
applies to downloaded apps. A public download needs a Developer ID
certificate and notarization: `npm run dist:signed` with `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` set
(`electron-builder.release.json`, `assets/entitlements.mac.plist`).

## Tests

`npm run e2e` and `npm run e2e:flows` launch the packaged app with a CDP port
and drive it with Playwright against a running stack (the local e2e stack,
`scripts/e2e-local-stack.sh`): the app connects and sends an anonymous user to
`/login`, signs up, creates a project; the flows add a connector popup with a
live opener, a download kept in the app, and an external link handed to the
browser. Menu shortcuts cannot be driven over CDP; check them by hand.

## Icon

The dock icon is the product's glass asterisk on a macOS plate.
`assets/icon.html` is the source; `npm run icon` renders it and rebuilds
`assets/icon.icns`.
