# Mission 18: The Mac app

Owner direction, 2026-10-10: build the wrapper first (a window around the
hosted web app) and leave upstream's self-contained local mode for later. The
plan is [`docs/mac-app.md`](../docs/mac-app.md); the app is in
[`desktop/`](../desktop/README.md).

Owner direction, 2026-10-25: "Use Mac Catalyst and retire the Electron." The
Mac app becomes the iPhone app (`mobile/`) built with Mac Catalyst, for parity
with the iPhone, voice mode above all. See "Mac Catalyst" at the end; the
sections before it are the Electron app's history.

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

## Title bar (2026-10-11), not accepted

The web app drew to the top edge behind the inset traffic lights: the
sidebar's logo started at y 19 (CSS px, measured over CDP in the packaged
app), under lights that end near y 30, and the product declared no drag
region, so the window could not be moved by its top. Now (`91c369a3`) the
shell sets `--mike-titlebar-inset: 24px` on product pages (removed in full
screen) and the sidebar starts with a strip of that height marked
`-webkit-app-region: drag`; in a browser the variable is unset and the strip
has no height. Packaged app against staging after the deploy, signed in
with a minted session (cookie files deleted afterwards):

```text
windowed {"url":"/assistant","inset":"24px","strip":{"x":13,"y":13,"w":254,"h":24},"stripRegion":"drag","bodyRegion":"no-drag","logo":{"x":25,"y":43,"w":70,"h":33}}
```

Still by hand: the native title bar itself (CDP screenshots leave it out,
and this terminal has no Screen Recording permission), dragging the window
by the strip, and the full-screen toggle.

## The e2e suites, against current code (2026-10-11)

Local e2e stack: the backend from this tree on :3101
(`scripts/e2e-local-stack.sh --serve-backend`) and `next dev` on :3100,
which the storage CORS allows. Fixes to the suites themselves: Playwright
attaches only once `/json` shows the app's page (it misses a page that is
blank when it connects), the project wizard's new Access step is skipped,
sign-up waits for the redirect to `/login` first, and the row menu's
Download item is a button, not a menuitem.

```text
$ MIKE_E2E_URL=http://localhost:3100 MIKE_E2E_API=http://localhost:3101 npm run e2e:flows
✓ signed up + onboarded + signed in
✓ oauth popup: about:blank window.open allowed in-shell
✓ oauth popup: survives cross-origin navigation
✓ oauth popup: live opener back-channel, no mikeDesktop bridge
✓ external link: no in-shell window, URL captured
✓ renderer file: navigation of the main window does not land
✓ popup cannot drive its opener into a silent download
✓ failing iframe does not trigger the connect screen
✓ blob download is saved by the shell download handler
✓ library upload + row-menu Download stays in-shell
✓ presigned-URL anchor click resolves to an in-shell download
FLOWS E2E PASSED

$ MIKE_E2E_URL=http://localhost:3100 MIKE_E2E_API=http://localhost:3101 npm run e2e
✓ shell connected; anonymous user routed to /login
✓ signed up + onboarded + auto-signed-in as desktop-e2e-…@example.com
✓ project "Desktop E2E …" created and visible
✓ page title: Mike - Legal AI Platform
E2E PASSED
```

The first `npm run e2e` after starting `next dev` failed with
"page.evaluate: Execution context was destroyed, most likely because of a
navigation" while the dev server compiled its first pages; the rerun above
passed unchanged.

## The menu, from the main process (2026-10-11)

`e2e/menus.e2e.mjs` (`npm run e2e:menus`) opens Node's inspector on the
packaged app's main process, clicks each item the shell defines and checks
the result over CDP, and puts the window in and out of full screen. Same
local stack as above:

```text
$ MIKE_E2E_URL=http://localhost:3100 npm run e2e:menus
✓ signed up and in
✓ menu shortcuts: Settings… Cmd+,, Change Server… Cmd+Shift+,, Hide Mike Command+H, Hide Others Command+Alt+H, Quit Mike CommandOrControl+Q, New Chat Cmd+N, Assistant Cmd+1, Projects Cmd+2, Library Cmd+3, Tabular Review Cmd+4, Workflows Cmd+5, History Cmd+6, Close Window CommandOrControl+W, Undo CommandOrControl+Z, Redo Shift+CommandOrControl+Z, Cut CommandOrControl+X, Copy CommandOrControl+C, Paste CommandOrControl+V, Paste and Match Style Cmd+Option+Shift+V, Select All CommandOrControl+A, Home Cmd+Shift+H, Reload CmdOrCtrl+R, Force Reload Shift+CmdOrCtrl+R, Actual Size CommandOrControl+0, Zoom In CommandOrControl+Plus, Zoom Out CommandOrControl+-, Toggle Full Screen Control+Command+F, Toggle Developer Tools Alt+Command+I, Minimize CommandOrControl+M
✓ File › Projects → /projects
✓ File › Library → /library
✓ File › Tabular Review → /tabular-reviews
✓ File › Workflows → /workflows
✓ File › History → /history
✓ File › Assistant → /assistant
✓ File › New Chat → /assistant
✓ Mike › Settings… → /settings
✓ View › Home → /assistant
✓ full screen: strip 24px → 0px → 24px
✓ Help › Mike on GitHub → default browser (captured)
✓ Mike › Change Server… → connect page
MENUS E2E PASSED
```

What this cannot do, tried in the same run before narrowing the suite:
key events sent to the window (`webContents.sendInputEvent`, ⌘1…⌘6, ⌘N,
⌘,, ⌘⇧H, ⌘=, ⌘⇧,) left the page where it was, since they never reach the
native menu; and `MenuItem.click()` on the Toggle Full Screen role item left
`isFullScreen()` false for six seconds, while `setFullScreen(true)` worked.
So the shortcuts are registered (listed above) but pressing them, and the
role items (Edit, zoom, Toggle Full Screen), stay by hand.

**Release hardening found here:** the development build (`npm run dist`)
leaves `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
`EnableNodeCliInspectArguments` on (`npx @electron/fuses read --app
dist/mac-arm64/Mike.app`), so anyone who can start it can run code in it
with full Node; this suite depends on that. The release config
(`electron-builder.release.json`, `npm run dist:signed`) now turns all three
off and turns on `OnlyLoadAppFromAsar` and
`EnableEmbeddedAsarIntegrityValidation`. File-protocol privileges stay on
because the connect page is a `file://` page. Checked with an unsigned build
of the release config (`--mac dir -c.mac.identity=null
-c.mac.notarize=false`):

```text
RunAsNode is Disabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
```

Launched with `--inspect=9341`, after an ad-hoc re-sign (flipping the fuses
edits the binary after the linker's ad-hoc signature, and macOS refuses to
run it until it is signed again, which a real release does anyway), it
loaded its connect page from `app.asar` and nothing listened on 9341.

## Not done

- **By hand:** pressing the shortcuts and the role items (see the menu
  section), the traffic lights, and dragging the window by its strip.
- **A connector sign-in in the app** against staging (needs a connector
  configured there).
- **Signing and notarization** need the owner's Apple Developer ID. This Mac
  has none: `security find-identity -v -p codesigning` printed "0 valid
  identities found" (2026-10-11), and Xcode has no Apple account signed in.
- **CI:** no job builds the app yet; a macOS runner job is a cost decision.

## Mac Catalyst (2026-10-25), not accepted

How it is built, what works and what is left: [`docs/mac-app.md`](../docs/mac-app.md).
Toolchain: Xcode 27.1, macOS 27.2, Capacitor 8.5.3.

Two binary dependencies have no Catalyst slice. The first build failed with
"While building for Mac Catalyst, no library for this platform was found" in
`Capacitor.xcframework`, `Cordova.xcframework` and xn-ptts's
`PhononCore.xcframework`. `npm run mac:deps` builds the Catalyst slices from
source (Capacitor unchanged; Phonon's Rust core for `aarch64-apple-ios-macabi`)
into local packages that override the remote ones. Then the link failed with a
duplicate `_rust_eh_personality` (two Rust static libraries, each with std);
dead-code stripping, on by default for iOS but not for the Mac's Debug build,
fixed it. A Release build failed on x86_64 (Phonon has no Intel slice); the
Mac build is Apple silicon only. No Swift source needed a Catalyst guard to
compile.

```text
$ npm run mac:build                       # Debug, ad hoc
** BUILD SUCCEEDED **
$ scripts/build-mac.sh Release
** BUILD SUCCEEDED **
$ lipo -info .../Release-maccatalyst/App.app/Contents/MacOS/App
Non-fat file: ... is architecture: arm64
$ du -sh .../Release-maccatalyst/App.app
270M
iOS, same project with the local packages:
  iPhone 18 Pro simulator  ** BUILD SUCCEEDED **
  generic/platform=iOS     ** BUILD SUCCEEDED **  (Capacitor binary: the release's SHA-256)
```

The app, launched sandboxed under another bundle identifier (the first launch
as `com.firm.mike` waited in sandbox setup for macOS's prompt about an
existing container from a differently signed build), loading a local harness
page that calls the plugins through the bridge:

```text
headers   CapacitorHttp, Console, WebView, CapacitorCookies, SystemBars, Browser, App, Camera, MikeSpeech, Preferences, MikeFiles
status    en-US       {"state":"available","engine":"speech-transcriber","locale":"en-US"}
status    fluid-mini  {"live":true,"state":"available","engine":"fluid-mini","locale":"en"}
voices    185
speak     audio/wav, 75584 base64 chars
transcribe fluid-mini  "Please draft a short letter to opposing counsel and confirm the deposition date."  67540 ms (first: Core ML compile)
transcribe apple       "Please draft a short letter to opposing counsel and confirm the deposition date."  834 ms
voiceInstall  {"available":true}  44601 ms
voicePrewarm  ready: eou, fluid-mini, phonon, smart-turn, speaker, vad
speak phonon  audio/wav, 179260 base64 chars, 301 ms
voiceRemove, remove phonon: models deleted
```

(`Browser` is `@capacitor/browser` 8.0.5, installed for this check only; it
compiles under Catalyst.) Before the fix to the model lookup
(`Bundle.resourceURL`), Fluid Speech Mini reported `unavailable` on the Mac:
macOS keeps a resource bundle's files in `Contents/Resources`.

The speech plugin's tests under Catalyst (a workspace with the plugin and the
local packages): `Executed 154 tests, with 7 tests skipped and 0 failures`
(the 7 are the model integration tests, which need downloaded models).

### Not done

- By hand: the microphone prompt, live dictation and a voice session with
  echo cancellation, the camera, the window's look (no Screen Recording
  permission here).
- Connector sign-in popups, menus and shortcuts, signing and notarization,
  and the rest of "Retiring desktop/" in `docs/mac-app.md`.
