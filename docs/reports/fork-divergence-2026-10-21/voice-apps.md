# Triage: voice, mobile and desktop apps

## Summary

This area adds speech to the app and ships it in two new native shells. It covers four things. First, a backend `audio` module (dictation and read-aloud through an operator's OpenAI-compatible speech endpoints, plus an OpenRouter lane). Second, a large frontend layer: `lib/voice/**` (45 files, about 8.3k lines), `useVoiceChat`, `useDictation`, `useReadAloud`, `VoiceModePanel`, and Settings → Voice. Third, an iPhone/Android Capacitor shell (`mobile/`, 97 tracked files) with its own `MikeSpeech` plugin that does on-device dictation (Fluid Speech Mini), read-aloud (Phonon), and a hands-free voice engine (VAD, Parakeet EOU, Smart Turn, speaker check). Fourth, a Mac app (`desktop/`) that is a trimmed copy of upstream's own Electron shell. Almost all of it is new files (no code in `mobile/`, `audio/` or `lib/voice/` existed at the fork point), so it is mostly ADDITIVE. Three problems stand out. The desktop app is a parallel add/add copy of what upstream already shipped (#612) and is FORK-ONLY. Voice mode needs backend changes in the chat engine and a DB migration (`4f5a1cc2`), so it is tied to our Pi loop and prompts. The web app was edited in about 60 places to host this, mostly `ChatInput`, `ChatView`, `AssistantMessage`, `globals.css` and `mikeApi.ts`, which upstream also changed heavily. Maturity is uneven. The dictation and read-aloud code is tested and has been used on a simulator or emulator. The hands-free voice engine was built in about a day, has run only in the iOS simulator, and the owner has not yet QA'd today's changes on a device. `docs/voice-chat.md` still says "design for discussion ... Not approved for building".

## Cluster table

| Cluster | Bucket | Readiness | Maturity | Upstream conflict |
|---|---|---|---|---|
| 1. Backend audio module (STT/TTS proxy, OpenRouter lane) | ADDITIVE | NEEDS-WORK | shipped+tested | low |
| 2. Web dictation + read-aloud (hooks, composer, message actions) | ADDITIVE | NEEDS-WORK | shipped+tested | high (ChatInput/AssistantMessage) |
| 3. Browser on-device models + Settings → Voice + test bench | ADDITIVE | NEEDS-WORK | experimental | med |
| 4. Dictation vocabulary (names spelled right) | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| 5. iPhone app shell (Capacitor) + web-hosting changes | ADDITIVE | FORK-ONLY (as is) | experimental (simulator only, unsigned) | med |
| 6. On-device speech plugin: dictation + read-aloud (iOS and Android) | ADDITIVE | NEEDS-WORK | experimental | low (new files) |
| 7. Hands-free voice mode (iOS engine, `useVoiceChat`, panel, backend voice turns) | ADDITIVE, with a MIXED backend edge | NEEDS-WORK, not PR-ready | incomplete | high |
| 8. Android app | ADDITIVE | FORK-ONLY | experimental | low |
| 9. Mac app (`desktop/`) | SUBTRACTIVE (upstream's app minus local mode) | FORK-ONLY | shipped (unsigned), tested | high (add/add) |
| 10. Mac title-bar inset and Electron fuses | FIX | READY (small slices) | shipped | low |

## Clusters

### 1. Backend audio module
- **Bucket:** ADDITIVE.
- **What changed:** New `backend/src/modules/audio/` with `POST /audio/transcriptions` (base64 JSON, in memory only), `POST /audio/speech`, and a voice and price catalog.
  - It talks to a deployment-configured OpenAI-compatible operator (`MIKE_STT_*` and `MIKE_TTS_*` env vars) and fails closed with 503 when they are unset.
  - A second "comparison" lane goes through OpenRouter, with costs reported.
  - The service follows the routes/service layering rules and has route tests with 572 lines of coverage.
- **Key commits:**
  - `743fa26e feat(station-6): local audio STT dictation and TTS read-aloud proxies`
  - `db680985 feat(audio): OpenRouter voice lane with catalog, prices and costs (Mission 10)`
  - `6e5b553a feat(station-8): strict private mode...` touches the module's egress gating.
- **Key paths:** `backend/src/modules/audio/**`, the `audioRouter` mount in `backend/src/app.ts`, and `audio*` helpers in `frontend/src/app/lib/mikeApi.ts`.
- **Readiness: NEEDS-WORK.**
  - The module imports `lib/egress` and `lib/privateMode`, which belong to our strict-private-mode work and do not exist upstream. A PR would stub or strip those.
  - The OpenRouter lane is a separate decision and should be split off.
  - Config is undocumented upstream (`.env.example`/docs).
- **Dependencies:** `lib/privateMode` and `lib/egress` (the privacy cluster, owned by another area), and the app.ts mounting.
- **Upstream:** `git log 9a0a0a5b..upstream/main -- backend/src/modules/audio` is empty. Upstream has no audio or voice module. The only collision is `app.ts` (router mount lines), which is trivial. The module's conflict is low.
- **Maturity:** shipped+tested.

### 2. Web dictation and read-aloud
- **Bucket:** ADDITIVE.
- **What changed:** A mic button in `ChatInput` (MediaRecorder, then the transcript is inserted at the caret and never auto-submitted). Per-message read-aloud in `AssistantMessage` (sentence streaming, speed control, a seekable single-file player). Live dictation streams into the composer itself. The behavior is split across `useDictation.ts` (491 lines), `useReadAloud.ts` (495), `useBrowserReadAloud.ts`, `readAloudShared.ts`, `ReadAloudPlayer.tsx` and `LiveDictationText.tsx`.
- **Key commits:**
  - `743fa26e` (first version)
  - `7b40aeef feat(voice): read aloud with Phonon in the browser and on the iPhone`
  - `6a911f43 feat(voice): read a response aloud as one seekable audio file`
  - `c025ed2e feat(voice): stream live dictation into the composer itself`
  - `7b7222c6 feat(voice): warm Fluid Speech Mini up while the person speaks`
- **Key paths:** `frontend/src/app/components/assistant/{ChatInput,AssistantMessage,useDictation,useReadAloud,ReadAloudPlayer,LiveDictationText}.*`, `frontend/src/app/lib/voice/{engines,speechAudio,clauses,speakable,spokenAnswer,liveComposer}.ts`.
- **Readiness: NEEDS-WORK.**
  - `ChatInput.tsx` was touched by 9 voice commits (+661 lines overall in the fork, 19 fork commits there, 15 upstream commits there). `AssistantMessage.tsx` and `ChatView.tsx` were touched by 12/17 fork and 10/15 upstream commits.
  - Rebasing onto current upstream will be painful, and the code is only useful with cluster 1.
  - The code assumes the voice preference store and device plugin detection (clusters 3 and 6).
- **Dependencies:** cluster 1 (server lane), `lib/voice/preferences.ts`. The device-engine branches are inert without cluster 6.
- **Upstream:** no equivalent. Strong overlap in the same components, so the conflict is high.
- **Maturity:** shipped+tested. Dozens of vitest files, including `ChatInput.dictation`, `ChatInput.liveDictation` and `useReadAloud.test.ts` at 642 lines.

### 3. Browser on-device models, Settings → Voice, test bench
- **Bucket:** ADDITIVE.
- **What changed:**
  - **Browser engines:** WebGPU/WASM engines run in a worker — Fluid Speech Mini ONNX, Whisper, Kokoro, and Phonon via `phonon-tts` (`lib/voice/browserModels*.ts`).
  - **Settings → Voice:** a new `/settings/voice` page: engine and voice pickers with samples, model setup cards, a test bench, a vocabulary section, and voice-mode setup (`components/settings/voice/**`, about 3k lines).
  - **Build hook:** `frontend/scripts/copy-phonon-tts.mjs` runs as `predev`/`prebuild` and copies the package into `public/phonon-tts/`.
- **Key commits:**
  - `908b92fe feat(voice): Settings → Voice, browser engines and a test bench (Mission 10)`
  - `69121a32 feat(voice): choose Phonon's voice from a list with samples`
  - `7ae12ba4 fix(voice): run the open models on iPhone without reloading the page`
  - `44d4f6b0 feat(voice): read aloud with Apple's voices in the iPhone app; open models in a worker`
- **Readiness: NEEDS-WORK.**
  - New dependencies in `frontend/package.json`: `@huggingface/transformers` 3.8.1, `kokoro-js`, `phonon-tts` 0.4.0, `double-metaphone`. These are large and are a policy decision for upstream.
  - Model mirrors are on a personal Hugging Face org (`mosiah/...`).
  - The `prebuild` hook changes the build, so `frontend/Dockerfile` needs checking per the repo rules.
  - The test bench and the OpenRouter comparison UI look like internal tooling.
  - A minimal PR would be Settings → Voice with the server lane only.
- **Dependencies:** cluster 2, cluster 1, and the brand package if copy uses the product name.
- **Upstream:** no `settings/voice` upstream. The settings layout (`settings/layout.tsx`) is the only shared file. Conflict is medium.
- **Maturity:** experimental. Tested, but the WebGPU paths depend on browser support (`docs/voice-chat.md` cites the WebGPU rollout).

### 4. Dictation vocabulary
- **Bucket:** ADDITIVE.
- **What changed:** A per-user list of names and terms (`user.dictationVocabulary.ts`, a migration, `GET/PUT` under the user routes). The client corrects every transcript with it (phonetic matching via double-metaphone) and passes the terms to Apple's recognizer. Names from the user's projects and documents are included (`lib/voice/{vocabulary,dictationVocabulary}.ts`, `VocabularySection.tsx`).
- **Key commits:**
  - `282ab97b feat(voice): a dictation vocabulary that spells names right`
  - `309944a8 test(voice): cover the dictation vocabulary so the coverage gate passes`
- **Key paths:** `backend/migrations/20261020_01_dictation_vocabulary.sql`, `backend/schema.sql`, `backend/src/modules/user/user.dictationVocabulary.ts`, `docs/dictation-vocabulary.md`, `AuthContext.tsx`, `ChatView.tsx`, `ProjectWorkspace.tsx`.
- **Readiness: NEEDS-WORK.**
  - It is self-contained and tested, but useful only if dictation lands.
  - The migration filename date would need renumbering against upstream's migrations.
  - It also edits `AuthContext`, which upstream changed (3 commits).
- **Dependencies:** cluster 2 (dictation).
- **Upstream:** nothing equivalent. Conflict is medium (`user.routes.ts` was touched by 13 upstream commits).
- **Maturity:** shipped+tested.

### 5. iPhone app shell and web-hosting changes
- **Bucket:** ADDITIVE.
- **What changed:** `mobile/` is a Capacitor 8 shell. It loads the deployed web app (`server.url`, default `https://choir-ip.com`) and falls back to `www/offline.html`. Native hardening goes into the generated Xcode project through `scripts/configure-ios.mjs`: permission prompts, the `mike://` scheme, an app-switcher privacy cover, backup exclusion, and keyboard handling (no form bar, tap or drag to close). A small `MikeFiles` plugin opens the share sheet for downloads.
- **Key commits:**
  - `c4212067 feat(mobile): the iPhone app, with dictation on the phone`
  - `410b5266 feat(mobile): chat threads scroll the page on a phone; the app runs edge to edge`
  - `81b89eb3`/`ddb565ea` keyboard handling
  - `d2deeace` swipe sidebar
  - `32c10e6c fix(mobile): ... Download button`
- **How much of the web app changed to host it:** a fair amount, but all of it is guarded so a browser is unaffected. The frontend never imports `@capacitor/*`; it detects the global `window.Capacitor` and its `PluginHeaders`. The dedicated files are `lib/{nativeKeyboard,nativeFiles,displayEdge,scrollViewport,horizontalSwipe,downloadDocument}.ts` and `hooks/useBlurOnOutsideTap.ts`. There are also edits in `(pages)/layout.tsx`, `app/layout.tsx`, `globals.css` (5 commits), `ChatView`/`ChatThread`/`InitialView`, `DocxView`, `AppSidebar` (also the Mac title-bar strip), and the mobile-header test. The mobile layout behavior is mixed into the shared chat components, which is the main splitting difficulty.
- **Readiness: FORK-ONLY (as is).**
  - `mobile/README.md` frames it as an "enterprise iOS/Android shell ... firm MDM ... firm WireGuard VPN", no public store, bundle id `com.firm.mike`, and a default server of our staging host.
  - Upstream would need a generic identity, a configurable server, and its own signing story.
  - A reusable "native shell hooks" PR (keyboard, safe areas, downloads) is possible after the voice work.
- **Dependencies:** none for the shell. Clusters 6 and 7 live inside it.
- **Upstream:** `git log 9a0a0a5b..upstream/main -- mobile` is empty. Upstream has no mobile app. Web-side conflict is medium (layout, `globals.css`).
- **Maturity:** experimental. It builds and runs in the simulator, and is unsigned and not on a device in release form (README status line).

### 6. On-device speech plugin: dictation and read-aloud
- **Bucket:** ADDITIVE.
- **What changed:** `mobile/plugins/speech/` (72 files, about 12.7k lines).
  - **iOS (Swift):** Fluid Speech Mini via the upstream FluidAudio package (a spike showed the altic-dev fork drops audio on long recordings), live dictation with a sliding window, Apple recognizer fallback with custom terms, Phonon read-aloud through the xn-ptts package, and Apple voices.
  - **Android (Java):** an ONNX port of Fluid Speech Mini (`FluidModel.java`), Phonon through a cargo-ndk-built `libptts_ffi.so`, and the phone's own TTS. There are JVM and instrumented tests.
  - **Model downloads:** pinned and hash-checked, from `mosiah/*` Hugging Face mirrors.
- **Key commits:**
  - `3a13534a feat(mobile): dictate with Fluid Speech Mini on the iPhone`
  - `1ccf00b8 feat(voice): show dictation as it is spoken on the iPhone`
  - `fb0b24a9 feat(android): the Android app, with on-device dictation and read-aloud`
- **Readiness: NEEDS-WORK.**
  - It is an independent plugin, but depends on the shell and on third-party model licences and mirrors (Fluid Speech Mini, Phonon, CAM++, WeSpeaker).
  - iOS needs 18+ and 5 GB+ RAM for the full set.
  - It would more naturally live as its own repo or package than as an upstream PR.
- **Dependencies:** cluster 5; a pinned FluidAudio 0.17.7.
- **Upstream:** no equivalent. Low conflict.
- **Maturity:** experimental. It has real unit tests (Swift: LiveDictation, FluidSpeechMini, PhononVoice, and others; Java: Model, Audio, ModelInstaller). Both Android and iOS results come from simulator or emulator, with no signed-device receipts. `docs/fluid-speech-mini-iphone.md` has an uncommitted edit (a spike result), and `mobile/plugins/speech/Package.resolved` is untracked.

### 7. Hands-free voice mode
- **Bucket:** ADDITIVE for the client. The server edge (`4f5a1cc2 feat(chat): voice turns and what was heard of an interrupted answer`) edits Pi `runtime.mts`, `chat.prepare/turn`, `prompts.ts`, `streaming.ts`, project-chat, and a migration (`20261020_02_spoken_answers.sql`), so that part is MIXED with the chat-engine cluster.
- **What changed:** A native Swift engine (`VoiceAudioEngine`, `EouStream`, `SmartTurn`, `TurnPolicy`, `ClauseQueue`, `VoiceEngine`, `SpeakerEmbedder`/`SpeakerFusion`) does the listening and speaking inside the audio loop.
  - The listening models are Silero VAD, Parakeet EOU, Smart Turn v3.2, and Fluid Speech Mini for the final text.
  - Speech is spoken clause by clause through Phonon, with barge-in and the spoken-prefix record of what was heard.
  - Speaker check ignores other voices (WeSpeaker, CAM++, and a fused head trained in `tools/speaker-bench`).
  - The web side holds the conversation: `hooks/useVoiceChat.ts` (733 lines), `lib/voice/{voiceEngine,voiceMode,spokenPrefix,speakerCheck}.ts`, `VoiceModePanel.tsx`.
  - The contract is `docs/voice-chat-contract.md`.
- **Key commits:**
  - `ebab8879 feat(voice): hands-free voice engine on the iPhone`
  - `6ac5a42a feat(voice): hands-free voice mode in the chat`
  - `ec468cfd feat(voice): learn the person's voice and ignore other voices`
  - `7bd861ca feat(voice): decide "Both" in a space trained on both speaker models`
  - `17696ea6 feat(voice): wait longer for the end of a turn, merge a turn cut too soon, and shrug off noise`
  - `82512ee9`/`13e1c9d0` echo fixes
- **Readiness: NEEDS-WORK, not PR-ready.**
  - `docs/voice-chat.md` still says "Not approved for building" and "It has run in the iOS simulator only ... nothing has been tried on a device yet, so every threshold ... is still untuned".
  - Almost all of it landed on 2026-10-20 and 21, and the commit messages show thresholds being re-tuned from outdoor use ("From use outdoors: turns ended on a breath ..."). The CAM++ threshold is "provisional" and the learned-voice scoring "decided by the phone".
  - The last two commits change turn-end timing and add a "continues" merge path (a new branch of a user prompt), none of which is device-verified yet.
  - It is iPhone-only (Android hides voice mode; the browser version is "after that").
  - It adds heavy models (Parakeet EOU about 300 MB, plus Smart Turn, WeSpeaker, CAM++) and the 5 GB RAM gate.
- **Dependencies:** clusters 2, 3 and 6, the Pi runtime and prompts (cluster in the LLM area), the voice-turn migration, and `@mike/contracts` additions.
- **Upstream:** no equivalent. The web conflict is high (`ChatInput`, `ChatView`, `useAssistantChat`, and chat engine `streaming.ts` where there were 15 upstream commits against our 38).
- **Maturity:** incomplete. Good unit coverage (`useVoiceChat.test.tsx` 919 lines, `TurnPolicyTests`, `VoiceContractTests`, and fixtures), but no field validation yet.

### 8. Android app
- **Bucket:** ADDITIVE.
- **What changed:** `mobile/android/` is generated, not committed (`npm run android:add`), and configured by `scripts/configure-android.mjs`. It runs the same web view with Android versions of the speech plugin (cluster 6).
- **Key commit:** `fb0b24a9 feat(android): the Android app, with on-device dictation and read-aloud`. Also `83cea411 fix(voice): never ask Android's WebView for on-device recognition`.
- **Readiness: FORK-ONLY.** The Android Download button does nothing yet, `MikeFiles` has no methods there, and there is no voice mode. Fluid Speech Mini on Android is a roughly 300 MB download, and Phonon needs a locally built native library.
- **Dependencies:** clusters 5 and 6.
- **Upstream:** none. Low conflict.
- **Maturity:** experimental (emulator only).

### 9. Mac app (`desktop/`)
- **Bucket:** SUBTRACTIVE.
- **What changed:** Upstream added its own Mac app in `89dc8323 [Mac app] Self-contained local workspace ... (#612)`, which includes local mode (bundled stack, Postgres/SQL, secrets, supervisor). Ours is a copy of that wrapper made before #612's follow-ups, with local mode removed. It also defaults to our server, moves Electron 38 to 44.7, and adds a menu e2e (`menus.e2e.mjs`). Menus, shortcuts, the origin fence, sign-in popups, downloads and the connection screen are inherited from upstream.
- **Key commits:**
  - `8cb586f2 feat(desktop): the Mac app, upstream's wrapper without local mode`
  - `c273ad67 test(desktop): e2e suites pass against the current app`
  - `9d464130 test(desktop): drive the app menu from the main process`
- **Readiness: FORK-ONLY.**
  - Upstream already has this app, and ours is a strict subset plus our server and branding. Merging means taking upstream's `desktop/` wholesale and dropping ours.
  - Our desktop was copied before upstream's later `ffd8fa41` (desktop onboarding fixes).
  - Only the small items in cluster 10 are worth contributing.
- **Upstream:** the same paths changed upstream (`desktop/**`, 45 files plus `ffd8fa41`). Add/add conflict on every file. High.
- **Maturity:** shipped (unsigned `dist/mac-arm64/Mike.app`), and e2e suites pass according to the commits.

### 10. Mac title-bar inset and Electron fuses
- **Bucket:** FIX.
- **What changed:**
  - **Title bar:** The shell injects `--mike-titlebar-inset: 24px` (removed in full screen) so the sidebar keeps a draggable strip under the inset traffic lights. The sidebar renders `height: var(--mike-titlebar-inset, 0px)`, so a browser is unaffected.
  - **Fuses:** The signed release build disables `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and loads code only from the integrity-checked `app.asar`.
- **Key commits:**
  - `91c369a3 fix(desktop): room and a drag handle under the Mac app's traffic lights`
  - `363f99a4 build(desktop): lock down Electron fuses in the release build`
- **Key paths:** `desktop/src/main.js`, `frontend/src/app/components/shared/AppSidebar.tsx` (+ test), `desktop/electron-builder.release.json`.
- **Readiness: READY** once rebased onto upstream's `desktop/`. Both are small and self-contained, and upstream's `electron-builder.release.json` has no fuse config. Check that upstream has not changed `titleBarStyle: "hiddenInset"` handling. `AppSidebar.tsx` is a busy file upstream (30 commits), so expect a mechanical rebase.
- **Dependencies:** none.
- **Upstream:** nothing equivalent. Medium conflict only for `AppSidebar.tsx`.
- **Maturity:** shipped with receipts in the mission file.

## PR candidates (best first)

1. **"Mac app: reserve a draggable title-bar strip under the traffic lights"** — cluster 10, `91c369a3` rebased onto upstream's `desktop/` and `AppSidebar.tsx`. About 50 lines plus a test.
2. **"Mac app: lock down Electron fuses in the signed build"** — `363f99a4`, 7 lines in `electron-builder.release.json`. Optionally an Electron bump with e2e receipts.
3. **"Add read-aloud and dictation through a server speech operator"** — clusters 1 and 2 only. Backend `audio` module with the operator lane (drop OpenRouter, private mode, and egress coupling), the mic in `ChatInput`, and read-aloud in `AssistantMessage`. Needs a rebase of the heavily changed components and `.env.example`/docs.
4. **"Per-user dictation vocabulary"** — cluster 4, after PR 3. One migration (renumbered), user routes, client correction.
5. **"Settings → Voice: engine choice and in-browser models"** — cluster 3, behind a flag, after PR 3. It is a policy decision because of the heavy new dependencies. Not recommended before upstream agrees to them.

Not recommended: hands-free voice mode (incomplete), the Capacitor shells (enterprise-specific identity, and not yet device-verified), and our `desktop/` tree.

## README digest

- Dictation: a mic button in the composer turns speech into text at the caret (never auto-sent), using a server speech endpoint, the browser, or on-device models. A per-user vocabulary fixes names.
- Read-aloud: any answer can be read aloud with Phonon, Kokoro, Apple voices, or a server voice, with speed control and a seekable player.
- Settings → Voice picks engines and voices, installs models, and has a test bench.
- The iPhone and Android apps are Capacitor shells around the hosted web app. They add on-device dictation (Fluid Speech Mini) and read-aloud (Phonon), keyboard and safe-area handling, and a share sheet for downloads.
- Hands-free voice mode on iPhone (experimental): a native engine listens, detects the end of a turn, can be interrupted, ignores other voices, and speaks the answer clause by clause. It is still being tuned and has not been verified on a device.
- A Mac app (Electron) wraps the web app with menus, shortcuts, one-window behaviour, and a connection screen. Local mode is not in our copy.
- These speech models are downloaded on first use. The Android build needs a locally compiled native library for Phonon.
- All speech features degrade to "unavailable" when the engine or plugin is missing, so the plain web app behaves as before.
