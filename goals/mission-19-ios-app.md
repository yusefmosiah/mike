# Mission 19: The iPhone app

Owner direction, 2026-10-10: progress the mobile app alongside the Mac app
(Mission 18), and "make the iPhone app use real local transcription with
Apple's APIs". The app is in [`mobile/`](../mobile/README.md); the station
boundaries are in
[`station-10-mobile-client-and-ocr.md`](station-10-mobile-client-and-ocr.md).

## Built (2026-10-10/11), not accepted

- **The hosted web app, as in the Mac app.** `capacitor.config.ts` loads the
  deployed Mike server (`server.url`), by default staging
  (`https://choir-ip.com`), set per build with `MIKE_SERVER_URL`. The README's
  static-export plan is dropped: the frontend uses server routes. Only the
  server's host renders in the app (`allowNavigation` takes the hostname,
  since Capacitor compares hosts without the port); other links go to Safari.
  Native logging is off (`loggingBehavior: "none"`) and the web view is not
  inspectable.
- **Offline page.** `www/offline.html` ("Mike can't be reached", "Try again")
  is Capacitor's `errorPath`; the retry goes to the configured server
  (`www/server.js`, written by `scripts/write-www.mjs`).
- **Hardening by script.** The native project is generated (`npx cap add
  ios`) and git-ignored; `scripts/configure-ios.mjs` re-applies, idempotently:
  permission prompts (microphone, speech recognition, camera, photos), the
  `mike://` scheme, a blur cover over the window when the scene resigns
  active (before the app-switcher snapshot), and Documents/Library excluded
  from backups.
- **On-device dictation with Apple's speech recognition.**
  - `mobile/plugins/speech/` (`@mike/speech`, a local Capacitor plugin,
    Swift): `status`, `install`, `transcribe`. iOS 26+ uses `SpeechAnalyzer`
    with `SpeechTranscriber`, or `DictationTranscriber` where the hardware
    lacks it; older iOS uses `SFSpeechRecognizer` only with
    `requiresOnDeviceRecognition`. Apple's server recognition is never used.
    A language is ready when Apple's model is installed system-wide (checked
    through `installedLocales`, since the asset inventory reports such a
    language only as "supported" for the app); otherwise it is
    "downloadable", and `install` downloads it only from the user's click.
    The clip is written to a temporary file with complete protection for the
    length of the call and deleted; nothing is logged.
  - Web side: `frontend/src/app/lib/voice/deviceSpeech.ts` talks to the
    plugin through the Capacitor bridge (`Capacitor.nativePromise`, plugin
    presence from `PluginHeaders`; no new dependency). A new voice engine,
    "device", labelled "This iPhone", is offered only when the plugin is
    there and is the default dictation engine in the app; it is first in the
    fallback order. Dictation records AAC (`audio/mp4`) for it, since the
    plugin refuses WebM. Settings → Voice shows its state, a "Download speech
    model" button when needed, and it is a candidate in the test bench.
    Plugin failure codes map to fixed messages; no native text reaches the UI.

## Receipts

Toolchain: Xcode 27.0 (iPhoneSimulator27.0 SDK), Capacitor 8.5.3, iPhone 17
Pro simulator.

The first simulator build failed with
`ld: -objc_abi_version '-Xlinker' not supported (expected 2)` in the plugin
SPM targets. Cause: the shell is a Nix dev shell exporting `LD=ld`,
`CC=clang` and `SDKROOT`, which xcodebuild takes as build settings. Building
under `env -i HOME=… PATH=/usr/bin:/bin:/usr/sbin:/sbin` fixed it (now in the
README):

```text
$ env -i … xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
    -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
** BUILD SUCCEEDED **
$ xcrun simctl install booted …/App.app && xcrun simctl launch booted com.firm.mike
com.firm.mike: 22363
```

- Default build, screenshot: staging's "Private preview" access gate inside
  the app, below the status bar. Not signed in: the gate needs the access
  password, which the agent does not enter.
- `MIKE_SERVER_URL=http://127.0.0.1:9` showed a blank page: WebKit refuses
  port 9 (discard) outright and Capacitor reported "WebView loaded".
  `MIKE_SERVER_URL=https://mike.invalid` with logging on for the run:
  `⚡️  WebView failed provisional navigation` / `Error: A server with the
  specified hostname could not be found.`; screenshot: the offline page,
  "Mike can't be reached", "Try again".

Dictation core on this Mac (macOS 27.2), compiled from the plugin's
`OnDeviceSpeech.swift` with a small driver, on clips made with `say` and
`afconvert -d aac`, no download:

```text
status available speech-transcriber en-US
status xx unavailable
text: The quarterly report shows the north region ahead of plan by 10%.
bad file -> unsupported-audio
text: Please draft a short letter to opposing counsel. Ask them to confirm the deposition date for March 4th, then summarize the indemnity clause in two sentences.
```

In the simulator, through the bridge: the app built against a local harness
page (`MIKE_SERVER_URL=http://localhost:8765`) that calls
`Capacitor.nativePromise("MikeSpeech", …)` as `deviceSpeech.ts` does and
posts each answer back:

```text
{"k":"headers","v":["CapacitorHttp","Console","WebView","CapacitorCookies","SystemBars","MikeSpeech","Camera","Preferences","App"]}
{"k":"status","v":{"state":"available","engine":"dictation-transcriber","locale":"en-US"}}
{"k":"status fr-FR","v":{"locale":"fr-FR","engine":"dictation-transcriber","state":"downloadable"}}
{"k":"transcribe","v":{"text":"Please draft a short letter to opposing counsel ask them to confirm the deposition date for March 4 then summarize the indemnity clause in two sentences","ms":2044}}
{"k":"webm error","v":{"code":"unsupported-audio"}}
{"k":"empty error","v":{"code":"invalid-audio"}}
```

The simulator has only `DictationTranscriber`, which behaves like keyboard
dictation: no automatic punctuation, punctuation from spoken commands. On the
Mac, the same module turned "Please draft the letter period ask them to
confirm the date comma then summarize the clause period" into "Please draft
the letter. Ask them to confirm the date, then summarize the class." ("class"
for "clause" is the model's error). Phones with `SpeechTranscriber`
punctuate on their own, as on the Mac above.

Frontend:

```text
$ npm run test:coverage --prefix frontend
 Test Files  282 passed (282)
      Tests  2412 passed (2412)
All files          |     100 |    99.63 |     100 |     100 |
$ npm run typecheck --prefix frontend      # clean
$ npx eslint <changed voice and dictation files>   # clean
```

New tests: `deviceSpeech.test.ts` (bridge detection, status, install,
base64 over several chunks, error codes to messages), preferences (default
"device" in the app, dictation only, first fallback), engine routing,
`useDictation` in the app (records `audio/mp4`, transcribes on the phone,
shows the phone's message), Settings → Voice in the app (default pill,
download button, downloading state).

## Not done

- Not run on a real iPhone; not signed. Dictation was not tried with a live
  microphone (unattended, at night); the harness fed a recorded clip through
  the same plugin call.
- The web change reaches the app only after it deploys to the server the app
  loads; the in-app Settings → Voice and composer with "This iPhone" were
  checked by unit tests, not on screen (staging is behind the access gate).
- No live partial results while speaking: the plugin transcribes the finished
  clip, like every other engine. `SpeechAnalyzer` can stream; that would need
  native capture instead of the web view's recorder.
- Apple's model downloads (other languages) were not exercised.
- Biometric unlock, secure token storage, deep-link routing, push, Android:
  unchanged (README, Remaining work).
- `npm audit` in `mobile/`: 3 moderate findings in `@capacitor/cli`'s build
  tooling (`xcode` → `uuid`), not shipped in the app; the fix is a CLI
  downgrade, not taken.
