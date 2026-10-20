# Mike Mobile — enterprise iOS/Android shell

Capacitor shell that packages the Mike web app as a firm-owned mobile client.
Distribution is enterprise-only: firm MDM, inside the firm WireGuard VPN. There
is no public App Store / Google Play track, and none is planned (station-10
boundary, `goals/station-10-mobile-client-and-ocr.md`).

App identity `com.firm.mike` · display name "Mike" · deep-link scheme `mike://`
· license AGPL-3.0-only. Progress: `goals/mission-19-ios-app.md`.

## Status: iOS builds and runs in the simulator; not signed, not on a device

- `capacitor.config.ts` loads the deployed Mike web app (`server.url`), by
  default our staging deployment (`https://choir-ip.com`); a firm build sets
  `MIKE_SERVER_URL` to its host inside the VPN. Only that host renders in the
  app; other links open in Safari.
- `www/` holds only the page shown when the server cannot be reached ("Mike
  can't be reached", with a retry).
- `scripts/configure-ios.mjs` applies the native hardening to the generated
  project: permission prompts, the `mike://` scheme, the app-switcher privacy
  cover and backup exclusion (below), and the keyboard: no form bar
  (previous, next, Done) above it, and dragging the page closes it. A
  tap on the page closes it too (frontend `hooks/useBlurOnOutsideTap.ts`).
  On iOS 17 and later the app, not WebKit, makes room for the keyboard: the
  web view ends just below the keyboard's top edge, so the page's viewport is
  the space above it plus a 24pt band the keyboard slides over. That band is
  the chat composer's empty bottom (below its buttons) and its rounded
  corners, so the keyboard covers no control and nothing shows behind its own
  rounded corners. WebKit's own handling shrank the page's viewport and,
  on iOS 27, could leave it short after the keyboard closed, which floated
  the chat composer above the bottom of the screen.
- `plugins/speech/` is Mike's own plugin: dictation with Fluid Speech Mini
  (bundled in the app) or Apple's on-device speech recognition, and read-aloud
  with Phonon (downloaded on request) or Apple's voices (below). The app's
  deployment target is iOS 18: the xn-ptts package that runs Phonon declares
  iOS 18, and Swift Package Manager refuses a dependency with a higher
  floor than the package using it (the models need iOS 18 anyway). `cap sync`
  re-derives the target from the project and writes `.iOS(.v18)`, which
  CapApp-SPM's tools version (5.9) rejects, so run `npm run ios:configure`
  after every `npm run sync` (it writes `.iOS("18.0")`).
- `plugins/files/` saves downloads: the web view ignores a link that
  downloads a blob, so a document's Download button opens the share sheet
  (Save to Files, AirDrop, Mail) through this plugin instead.
- Android has not been generated or built.

## How the pieces fit

- The web view loads the firm's Mike server, so every web change reaches the
  app without a new build, as in the Mac app (`desktop/`). A static export of
  the frontend is not possible: it uses server routes and middleware.
- The web view fills the screen (`contentInset: "never"`): the page pads
  itself with `env(safe-area-inset-*)`, blurs text scrolling under the status
  bar, and on chat threads scrolls the document, so a tap on the status bar
  scrolls back to the top. When the page detects it runs edge to edge
  (`frontend/src/app/lib/displayEdge.ts`), the composer sits near the bottom
  of the screen with corners concentric with the display's.
- The device talks only to the firm server, over the firm WireGuard VPN.
  Model, search and server-side speech operators are reached by the backend,
  never by the phone. On-device dictation (below) needs no network at all.
- Every build made from this directory must preserve the station-10 boundaries:
  no confidential matter text in push notifications, and the app window is
  covered immediately when it leaves the foreground.

## Build and run (iOS)

Needs Node.js 22+, Xcode, and an iOS simulator runtime.

```bash
cd mobile
npm install
npm run ios:add            # first time: www, cap add ios, configure-ios
npm run sync               # after a plugin or config change
npm run ios:configure      # safe to re-run
npx cap open ios           # or build from the command line (below)
```

`MIKE_SERVER_URL=https://mike.firm.internal npm run sync` points a build at
another server (it also writes `www/server.js`, the offline page's retry
target).

Command-line build for the simulator:

```bash
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Run it from a clean environment if your shell exports a compiler toolchain
(a Nix or Homebrew dev shell sets `LD`, `CC`, `SDKROOT`): xcodebuild takes
environment variables as build settings, and a foreign `ld` fails with
`ld: -objc_abi_version '-Xlinker' not supported`. For example, prefix
`env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

### UI test (software keyboard, screenshots)

`scripts/configure-ios.mjs` also adds an `AppUITests` XCUITest target
(`ui-tests/AppUITests.swift`, written straight into `project.pbxproj`, no
extra tools) and a shared `App` scheme that runs it. It launches the app,
taps the composer (optionally after scrolling to the end of the page), waits
for the keyboard, closes it (a tap on the page; a drag down at the end), and attaches a
screenshot at each step. Serve a test page, or the real web app with its API
stubbed, then:

```bash
python3 -m http.server 8766 --bind 127.0.0.1 --directory <page-dir> &
scripts/ui-test-ios.sh <screenshots-dir> [http://127.0.0.1:8766/]
SIMULATOR="iPhone 17 Pro" scripts/ui-test-ios.sh ...   # name or UDID; default iPhone 17
```

The script builds, writes the page URL into the built app's
`capacitor.config.json` (the source tree is untouched), runs the tests and
exports `top-*.png` and `end-*.png` to the folder. The test taps a text view
in the web view, or else the composer's place at the bottom of the screen. If
no keyboard appears, the simulator has a hardware keyboard connected (I/O >
Keyboard > Connect Hardware Keyboard, or
`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`).

### Scripts

| Script | Runs | Purpose |
|---|---|---|
| `www` | `scripts/write-www.mjs` | Write `www/server.js` (the offline page's retry URL). |
| `speech-model` | `scripts/fetch-speech-model.mjs` | Fetch the Fluid Speech Mini Core ML files (about 250 MB) at the revision pinned in `scripts/speech-model.manifest.json`, check each file's SHA-256 and refuse a mismatch; a no-op when the files match. `MIKE_SKIP_SPEECH_MODEL=1` skips it (the app then reports the model unavailable and dictation uses Apple's recognizer). Phonon is not fetched here: the app downloads it on request. |
| `sync` | `www` + `speech-model` + `cap sync` | Copy `www/`, write `capacitor.config.json`, update plugins (SPM). |
| `test` | `node --test scripts/*.test.mjs` | Unit tests of the scripts. |
| `ios:add` | `www` + `cap add ios` + `ios:configure` | Generate the iOS project. |
| `ios:configure` | `scripts/configure-ios.mjs` | Apply the hardening to the generated project. |
| `build:ios` | `cap build ios` | Signed iOS artifact (signing per firm profiles). |
| `build:android` | `cap build android` | Signed Android artifact (not yet generated). |

## Dictation on the phone

In the app, Settings → Voice offers a "This iPhone" dictation engine, and it is
the default there. The web app records the clip as it does for every engine
and hands it to the `MikeSpeech` plugin (`plugins/speech/`), which transcribes
it on the phone. The default is Fluid Speech Mini by FluidVoice (CC BY 4.0), a
Core ML model that ships inside the app (`npm run speech-model` fetches it
before the build; it adds about 250 MB), runs on the Neural Engine through the
FluidAudio package, works offline from the first launch, and needs iOS 18 and
English. Otherwise (older iOS, a build without the model, another language, or
Apple's recognizer chosen in Settings) it is Apple's speech recognition:
`SpeechAnalyzer` on iOS 26 and later, `SFSpeechRecognizer` with on-device
recognition only on older systems. Audio never leaves the phone and never
reaches Mike's backend or Apple. For Apple's recognizer, a language whose
model is not on the phone shows "Download speech model" (a system download
from Apple, started only by that click). The attribution for the model is in
Settings → Voice; its LICENSE and NOTICE are bundled with it. The web
side is `frontend/src/app/lib/voice/deviceSpeech.ts`; the plugin's methods
and error codes are in `plugins/speech/README.md`.

## Read-aloud on the phone

Settings → Voice → Read aloud → "This iPhone" offers Apple's voices and
Phonon 31m by Gradium (Apache-2.0, built on Kyutai's Pocket TTS; xn-ptts
0.4.0, Swift product `ptts`, module `PhononTTS`), a Core ML model on the
Neural Engine for English. Unlike Fluid Speech Mini it is not in the app, so
the app does not grow. The person chooses Phonon and presses "Download
Phonon"; the plugin then fetches the model (about 160 MB; about twice that on
disk once the phone has compiled it) with `PhononModels.download`, which
checks every file against its `bundle.json` and resumes an interrupted
download, into Application Support (excluded from backup). "Remove Phonon"
deletes it. Until it is on the phone, a build without it, iOS before 18,
another language than English, a failed reading or an Apple voice chosen,
read-aloud uses Apple's voices. The first reading after a download compiles
the models for the phone (about 10 seconds); the model is then kept until a
memory warning or five idle minutes.

This is the only request the phone makes to a host other than the firm's
server, and it carries no user content: a public model download from
`https://huggingface.co/mosiah/phonon-31m-en-coreml/resolve/<commit>/`. The
commit is the `PhononVoice.modelBaseURL` constant in
`plugins/speech/ios/Sources/MikeSpeechPlugin/PhononVoice.swift`; change it
only together with a new upload to that repository. The files
are the v0.4.0 release's `phonon-31m-en-coreml.zip` (SHA-256
`10f3a99fd39256db44f826267ef21d78cca959b16c0554926344c09fde27b436`),
unzipped, with the voices cut to the eight Settings offers plus the default
and `bundle.json` rewritten to list exactly the files present. The credit
("Phonon by Gradium", linking the model card) is in Settings → Voice. The web
side is `frontend/src/app/lib/voice/deviceSpeech.ts`.

## Distribution: MDM only

- Ship through the firm's MDM: Apple Business Manager managed distribution (or
  equivalent enterprise provisioning) and a private/managed Google Play track
  or EMM-managed APK. Public store distribution is excluded by policy.
- Builds are signed with firm-owned certificates; the MDM also enforces device
  compliance (passcode, encryption, supervised) and pushes the WireGuard
  profile.
- The native shells are git-ignored and regenerate from `npx cap add`; keep the
  firm's hardening edits (below) as a patch series or script so they re-apply.

### License: AGPL-3.0-only and the corresponding-source plan

Mike is AGPL-3.0-only (repo root `LICENSE`). Firm plan, deliberately stricter
than the license floor: for every revision handed to staff (including MDM
installs), publish — or keep a written, retrievable offer for — the
corresponding source of the exact deployed revision, plus the local
native-shell modifications (which live outside git in generated projects).
Because there is no public store track, the offer stays in the firm's own
channels. Confirm the final wording with firm counsel.

## Network: WireGuard VPN

- The shell is expected to run only with an active WireGuard tunnel to the firm
  network; the API origin must be a host inside that tunnel.
- The MDM-pushed VPN profile must route the firm API host and its DNS. If the
  tunnel is split, the split must still cover the API origin; a full tunnel
  covers everything.
- A firm build sets `MIKE_SERVER_URL` to the Mike host inside the tunnel. The
  default (our staging deployment) is for development only; do not ship a
  build pointed at a public server or run the app off-VPN.

### Backend strict private mode (PRIVATE_MODE_ALLOWED_EGRESS_HOSTS)

Backend egress is gated in `backend/src/lib/egress.ts`. Under
`STRICT_PRIVATE_MODE=true`, LLM and audio operator requests may reach only
private/loopback hosts, or hosts listed in `PRIVATE_MODE_ALLOWED_EGRESS_HOSTS`
(exact host or subdomain). Mobile implications:

- The device makes no direct operator calls, so there is no mobile-side egress
  allowlist to maintain.
- If the firm's model / STT / TTS operator is not reachable on a private
  network from the backend, add its host to `PRIVATE_MODE_ALLOWED_EGRESS_HOSTS`
  so dictation and chat behave on mobile exactly as on web.
- In the intended deployment the API host itself is private on the VPN, so no
  allowlist entry is involved in the mobile path.

## Native shell hardening

`npm run ios:configure` applies 2 (the native cover), 3 (iOS backup
exclusion) and the permission and URL-scheme declarations of 5 and 6 to the
generated iOS project. The rest is policy for the Android project and for
plugins not yet installed.

### 1. Biometric unlock (hook point; two plugins, not yet installed)

Add before shipping:

- `@aparajita/capacitor-biometric-auth` — Face ID / Touch ID / Android biometric prompt.
- `@aparajita/capacitor-secure-storage` — Keychain/Keystore for the session token.

Gate the WebView before any matter content renders — on cold start and on
resume from background. Sketch (confirm the plugin API at integration time):

```ts
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";

async function unlock(): Promise<boolean> {
    const { isAvailable } = await BiometricAuth.checkBiometry();
    if (!isAvailable) return false; // fail closed
    await BiometricAuth.authenticate({ reason: "Unlock Mike" });
    return true;
}
```

Rules:

- Session tokens live in secure storage (Keychain/Keystore), never in
  `@capacitor/preferences` — that plugin maps to UserDefaults /
  SharedPreferences, which are not a secret store and are captured by OS
  backups. Keep `Preferences` for non-secret UI settings.
- Fail closed: biometrics unavailable or canceled means locked screen, no
  cached matter content. The web layer's own authentication remains the source
  of truth.

### 2. Blur on background (required; iOS native cover implemented)

iOS: `configure-ios.mjs` adds a blur view over the window in
`SceneDelegate.sceneWillResignActive` (marker `MIKE_PRIVACY_COVER`), before
iOS takes the app switcher's snapshot. A personal build that should show its
real snapshot in the app switcher is configured with
`MIKE_APP_SWITCHER_PREVIEW=1 npm run ios:configure` (Info.plist
`MikeAppSwitcherPreview`); a firm build must leave it unset. The CSS below remains a sketch for
Android.

`@capacitor/app` is declared. In the shell bootstrap:

```ts
import { App } from "@capacitor/app";

void App.addListener("appStateChange", ({ isActive }) => {
    document.documentElement.classList.toggle("app-backgrounded", !isActive);
});
```

```css
html.app-backgrounded body {
    filter: blur(24px);
}
```

The iOS app-switcher snapshot is captured around the same moment the
inactive→background transition fires; if the CSS update loses that race, the
snapshot can still show content. Add a native cover that appears instantly on
`applicationWillResignActive` — e.g. the `@capacitor/privacy-screen` plugin
(not installed here; confirm Capacitor 8 compatibility at install time) or a
small AppDelegate overlay — and treat it as required for shipping.

### 3. OS backup exclusion (required; iOS implemented)

iOS: `configure-ios.mjs` adds the exclusion below to `AppDelegate`
(marker `MIKE_BACKUP_EXCLUSION`).

Android — add to the `<application>` tag in
`android/app/src/main/AndroidManifest.xml`:

```xml
android:allowBackup="false"
android:fullBackupContent="@xml/backup_rules"
android:dataExtractionRules="@xml/data_extraction_rules"
```

`allowBackup="false"` is the decisive switch (no backup, no restore). The rules
files make the intent explicit and cover device-transfer behavior:

`android/app/src/main/res/xml/backup_rules.xml` (API ≤ 30):

```xml
<full-backup-content>
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="file" path="." />
    <exclude domain="external" path="." />
</full-backup-content>
```

`android/app/src/main/res/xml/data_extraction_rules.xml` (API 31+):

```xml
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="file" path="." />
        <exclude domain="external" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="file" path="." />
        <exclude domain="external" path="." />
    </device-transfer>
</data-extraction-rules>
```

iOS — WebView storage and preferences live under Documents/Library, which
iCloud/iTunes backups capture by default. Mark the app container excluded from
backup at launch via `NSURLIsExcludedFromBackupKey`
(`ios/App/App/AppDelegate.swift`):

```swift
private func excludeAppDataFromBackup() {
    let fm = FileManager.default
    let roots = fm.urls(for: .documentDirectory, in: .userDomainMask)
        + fm.urls(for: .libraryDirectory, in: .userDomainMask)
    for root in roots {
        var url = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) -> Bool {
    excludeAppDataFromBackup()
    // ... generated Capacitor setup ...
    return true
}
```

Also enable Data Protection (`NSFileProtectionComplete`) for the app container
so files are encrypted at rest while the device is locked. Apple's
device-to-device transfer is OS-managed, so the durable control is the same as
on Android: matter content does not live on the device — the shell caches only
session material and non-secret settings; everything else is fetched over the
VPN per view.

### 4. Push notifications: content rule (not implemented)

Push is not wired in this scaffold. If the firm adds
`@capacitor/push-notifications`, payloads must carry neutral text only —
"New activity" — and never matter names, document titles, client or sender
identities, or excerpts. Detail is shown only after the app opens behind the
biometric gate. Example payload:

```json
{
    "notification": { "title": "Mike", "body": "New activity" },
    "data": { "route": "mike://assistant" }
}
```

Also have MDM disable lock-screen notification previews for the app as defense
in depth.

### 5. Deep links: mike:// (declaration + hook point)

Targets mirror web routes: `mike://assistant`, `mike://library`,
`mike://projects/<projectId>`. Routing an incoming URL into the web app is not
implemented; the hook point is:

```ts
import { App } from "@capacitor/app";

void App.addListener("appUrlOpen", ({ url }) => {
    // hand `url` to the web router once deep-link routing is implemented
});
```

Declarations in the generated shells:

iOS `ios/App/App/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>com.firm.mike</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>mike</string>
        </array>
    </dict>
</array>
```

Android `AndroidManifest.xml` (main activity):

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="mike" />
</intent-filter>
```

Universal links / App Links avoid the custom scheme; add only if the firm
controls domain certificates.

### 6. Microphone (dictation) and camera (scanner)

In the app, dictation runs on the phone by default (Dictation on the phone,
above). The user can choose the deployment's speech server instead, which uses
the backend speech proxy:

- `POST {firm-api}/audio/transcriptions` with
  `{ audio_base64, mimetype, filename?, language? }` → `{ text }`.
  Authenticated; recordings capped at 25 MB; the backend keeps them in memory
  and forwards to the firm's own STT operator (`MIKE_STT_BASE_URL`), which is
  egress-gated like every other outbound call.
- Capture runs in the WebView (getUserMedia / MediaRecorder). Container formats
  differ by platform WebView (iOS commonly `audio/mp4`, Android `audio/webm`);
  always send the actual recorded MIME type so the operator's decoder is keyed
  correctly.
- Open verification item (station-10): confirm the deployed operator decodes
  what both platforms' WebViews actually produce, on real devices.
- Native permissions: iOS `NSMicrophoneUsageDescription` and
  `NSSpeechRecognitionUsageDescription` (asked only on iOS before 26, for
  `SFSpeechRecognizer`) and Android `RECORD_AUDIO`; scanner: iOS
  `NSCameraUsageDescription` and Android `CAMERA`. `@capacitor/camera` is
  declared for scanner input.
- Read-aloud plays an answer as a run of audio segments in one audio element
  in the WebView, starting with the first while the rest are synthesized,
  with lock-screen controls through the Media Session API. iOS keeps it playing in the background and
  with the screen locked because `scripts/configure-ios.mjs` adds `audio` to
  `UIBackgroundModes`.

## Plugin inventory

| Plugin | State | Purpose |
|---|---|---|
| `@capacitor/core` | declared | Capacitor runtime. |
| `@capacitor/cli` | declared (dev) | `cap` tooling. |
| `@capacitor/app` | declared | background/foreground listener, deep-link events. |
| `@capacitor/preferences` | declared | non-secret settings only. |
| `@capacitor/camera` | declared | scanner input. |
| `@mike/speech` (`plugins/speech/`) | installed, iOS | dictation with Fluid Speech Mini or Apple's on-device recognition. |
| `@mike/files` (`plugins/files/`) | installed, iOS | downloads through the share sheet. |
| `@aparajita/capacitor-biometric-auth` | required before ship, not installed | biometric unlock. |
| `@aparajita/capacitor-secure-storage` | required before ship, not installed | Keychain/Keystore token storage. |
| `@capacitor/push-notifications` | optional, not installed | push (policy above). |
| `@capacitor/ios` | installed | iOS platform. |
| `@capacitor/android` | not installed | Android platform. |

## Remaining work

- [x] Load the hosted web app (`server.url`) with an offline page.
- [x] Generate the iOS shell and apply the hardening by script.
- [x] Native app-switcher cover and backup exclusion (iOS).
- [x] On-device dictation with Apple's speech recognition (iOS).
- [x] Downloads through the share sheet (iOS).
- [ ] Run on a real iPhone; sign with the firm's profile.
- [ ] Implement the biometric gate and secure token storage.
- [ ] Implement deep-link routing.
- [ ] Enforce the push payload rule if push is ever enabled.
- [ ] Verify server STT format compatibility on real iOS/Android devices.
- [ ] Generate and harden the Android shell.
- [ ] Firm security audit against the station-10 checklist: device-local
      storage encrypted, window blurs on background, OS backups exclude
      matter files.
