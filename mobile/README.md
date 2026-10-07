# Mike Mobile — enterprise iOS/Android shell

Capacitor shell that packages the Mike web app as a firm-owned mobile client.
Distribution is enterprise-only: firm MDM, inside the firm WireGuard VPN. There
is no public App Store / Google Play track, and none is planned (station-10
boundary, `goals/station-10-mobile-client-and-ocr.md`).

App identity `com.firm.mike` · display name "Mike" · deep-link scheme `mike://`
· license AGPL-3.0-only.

## Status: scaffold, not a built app

Committed here:

- `capacitor.config.ts` — app identity and the `webDir` wiring to the frontend
  build output.
- `package.json` — Capacitor core/cli plus the first plugins the shell needs
  (`@capacitor/app`, `@capacitor/preferences`, `@capacitor/camera`).
- This guide — deployment, VPN, and device-hardening policy, with the native
  snippets an operator applies when the shells are generated.

Deliberately not here yet:

- No `ios/` / `android/` native projects; they are generated locally with
  `npx cap add` (needs Xcode / Android SDK) and are git-ignored.
- No build, sync, simulator, or device run has been performed from this
  scaffold. Treat these files as a scaffold, not a tested app.
- No `npm install` has run here and no lockfile is committed; versions resolve
  on first install.
- Biometric unlock, the native blur cover, OS backup exclusion, push, and
  deep-link routing are policy and hook points described below — not
  implemented code.
- The frontend is not statically exportable as-is (see Operator preflight).

## How the pieces fit

- The WebView serves a static export of the Next.js frontend from `webDir`
  (`../frontend/out`); nothing is loaded from the public internet.
- The device talks only to the firm backend, over the firm WireGuard VPN.
  Model, STT/TTS, and search operators are reached by the backend, never by
  the phone.
- Every build made from this directory must preserve the station-10 boundaries:
  no confidential matter text in push notifications, and the app window blurs
  immediately on backgrounding.

## Operator preflight

1. Toolchains: Node.js LTS with npm; Xcode for iOS; Android Studio + JDK for
   Android.
2. Produce the web bundle (frontend config is owned by the frontend and is not
   touched here): `capacitor.config.ts` expects `frontend/out`, but a plain
   `next build` emits `.next/`. Enable a static export in the frontend
   (`output: "export"` in `frontend/next.config.ts`, then
   `npm run build --prefix frontend`), which emits `frontend/out/`.
   Caveat: static export forbids server-dependent Next features (API routes,
   middleware, server rendering). The frontend currently uses server-side
   routes, so this is a real configuration decision — the mobile bundle must be
   pointed at a firm API origin at build time. If a static export is not
   viable, the alternative enterprise pattern is a Capacitor `server.url`
   pointing at the firm-hosted web app inside the VPN; it is not configured
   here and would replace the `webDir` pipeline.
3. `npm install --prefix mobile`.
4. Generate the shells: `npx cap add ios` and/or `npx cap add android`
   (installs `@capacitor/ios` / `@capacitor/android`; requires the toolchains).
5. Apply Native shell hardening (below) to the generated projects.
6. `npm run sync` (`cap sync`) — copies the web export into each shell and
   updates plugins and native dependencies.

### Scripts

| Script | Runs | Purpose |
|---|---|---|
| `copy-web` | `cap copy` | Copy `frontend/out` into each added platform. |
| `build` | `npm run copy-web` | Alias: assemble the web bundle into the shells (the web app itself is built in `frontend/`). |
| `sync` | `cap sync` | `copy` plus plugin / native dependency update. |
| `build:ios` | `cap build ios` | Signed iOS artifact from the generated project (signing per firm profiles). |
| `build:android` | `cap build android` | Signed Android artifact (keystore params via `cap build --help`). |

Open the shells for native edits with `npx cap open ios` / `npx cap open android`.

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
- Assets are bundled in the app; only API traffic crosses the tunnel.
- Do not configure a public `server.url` or run the app off-VPN.

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

Apply to the generated `ios/` / `android/` projects (preflight step 5).

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

### 2. Blur on background (required)

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

### 3. OS backup exclusion (required)

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

Dictation reuses the existing web UI and the backend speech proxy:

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
- Native permissions: iOS `NSMicrophoneUsageDescription` (Info.plist) and
  Android `RECORD_AUDIO`; scanner: iOS `NSCameraUsageDescription` and Android
  `CAMERA`. `@capacitor/camera` is declared for scanner input.

## Plugin inventory

| Plugin | State | Purpose |
|---|---|---|
| `@capacitor/core` | declared | Capacitor runtime. |
| `@capacitor/cli` | declared (dev) | `cap` tooling. |
| `@capacitor/app` | declared | background/foreground listener, deep-link events. |
| `@capacitor/preferences` | declared | non-secret settings only. |
| `@capacitor/camera` | declared | scanner input. |
| `@aparajita/capacitor-biometric-auth` | required before ship, not installed | biometric unlock. |
| `@aparajita/capacitor-secure-storage` | required before ship, not installed | Keychain/Keystore token storage. |
| `@capacitor/privacy-screen` | recommended, not installed | native app-switcher cover. |
| `@capacitor/push-notifications` | optional, not installed | push (policy above). |
| `@capacitor/ios`, `@capacitor/android` | added by `npx cap add` | platform projects. |

## Remaining work

- [ ] Enable the frontend static export (or decide the `server.url` alternative).
- [ ] `npm install`, generate shells, re-apply the hardening patches.
- [ ] Implement the biometric gate and secure token storage.
- [ ] Implement the native app-switcher cover.
- [ ] Implement deep-link routing.
- [ ] Enforce the push payload rule if push is ever enabled.
- [ ] Verify STT format compatibility on real iOS/Android devices.
- [ ] Firm security audit against the station-10 checklist: device-local
      storage encrypted, window blurs on background, OS backups exclude
      matter files.
