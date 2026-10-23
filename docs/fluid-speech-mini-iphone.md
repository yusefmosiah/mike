# Fluid Speech Mini for iPhone dictation

Design for on-device dictation with Fluid Speech Mini in the iPhone app.
Status: approved for implementation. Scope: the iPhone app only; browsers,
the Mac app and the Word add-in are unchanged.

## The model

- Fluid Speech Mini (FluidVoice Labs): English speech-to-text, a distilled
  student of NVIDIA Parakeet TDT 0.6B v3. Core ML build:
  https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-coreml (253 MB:
  Preprocessor, Encoder, Decoder, JointDecision `.mlmodelc`, vocab JSON,
  config, LICENSE, NOTICE). Needs iOS 18; runs on the Neural Engine; about
  277 MB of RAM per 15 s window. Batch, not streaming: 16 kHz mono, 15 s
  windows.
- Called through the Swift package FluidAudio
  (`AsrModels.load(from:, version: .fluidParakeetMini)`, then
  `AsrManager.transcribe(url)`). The model card names the
  `altic-dev/FluidAudio` fork and says upstream `FluidInference/FluidAudio`
  also loads it as a Parakeet v3 model.
- Licence: CC BY 4.0. Credit "Fluid Speech Mini by FluidVoice", link the
  licence, keep LICENSE and NOTICE with the files.

## Mike today

- `frontend/src/app/lib/voice/engines.ts` dispatches a recording to an
  engine; the iPhone app defaults to `device` (`preferences.ts`), which calls
  the Capacitor plugin `MikeSpeech` (`deviceSpeech.ts`: `status`, `install`,
  `transcribe` with base64 audio and mime type, returning `{text}`).
- Native: `mobile/plugins/speech/ios/Sources/MikeSpeechPlugin/` uses Apple's
  SpeechAnalyzer (iOS 26) or SFSpeechRecognizer. `Package.swift` floor is
  iOS 15.
- `useDictation.ts` records AAC for the device engine, then transcribes the
  whole clip (no partial results).
- The phone talks only to the firm's Mike server (`mobile/README.md`), so it
  cannot download from Hugging Face.

## Design

### Delivery: bundled in the app

The model ships inside the app, so dictation works offline from the first
launch and needs no server endpoint or download UI.

- A script (`mobile/scripts/fetch-speech-model.mjs`, run by `npm run sync`
  and documented in `mobile/README.md`) downloads the pinned model files from
  Hugging Face at a fixed revision (commit hash, not `main`), verifies each
  file's SHA-256 against a checked-in manifest, and places them where the
  Xcode project copies them into the app bundle. Re-runs are no-ops when the
  files match. The model files are never committed (add them to
  `.gitignore`).
- LICENSE and NOTICE are bundled with the model.

### Native

- Add FluidAudio as a Swift package dependency, pinned to a tag or commit.
  Use upstream `FluidInference/FluidAudio` if it loads this model; otherwise
  the fork. Check and record its licence.
- `FluidSpeechMini.swift` beside the existing sources: loads the model from
  the bundle once (lazily, on first dictation), keeps it while the app is in
  the foreground, and unloads it on a memory warning and after 5 minutes
  idle.
- Keep the plugin's floor at iOS 15: the new code is
  `@available(iOS 18, *)` and compiled under `#if canImport(FluidAudio)` if
  needed, so older devices keep Apple's recognizer.
- Bridge: the existing methods gain an optional `engine` argument
  (`"fluid-mini"`; absent means today's Apple recognizer, so an older web
  build keeps working). `status({engine:"fluid-mini"})` reports
  `available` or `unavailable` (iOS < 18, model missing from the bundle);
  `transcribe({audio, mimeType, engine:"fluid-mini"})` decodes the AAC clip
  to 16 kHz mono with AVFoundation (a temporary file, as the existing code
  does) and returns `{text}`. Errors use the existing codes.
- No speech-recognition permission is needed for this engine (microphone
  only, which the web view already has).

### Web app

- `deviceSpeech.ts`: pass `engine` through; feature-detect support (an older
  app build lacks it) the same way `deviceVoiceSupported` does.
- `engines.ts` / `preferences.ts`: the `device` engine uses Fluid Speech
  Mini when the app reports it available, else Apple's recognizer. Store the
  choice as the device engine's `model` (`"fluid-speech-mini"` or
  `"apple"`), defaulting to Fluid Speech Mini. Non-English dictation
  languages use Apple's recognizer: the model is English only.
- Settings → Voice: on the iPhone app, a choice between "Fluid Speech Mini"
  and "Apple", and the credit line "Fluid Speech Mini by FluidVoice" linking
  the CC BY 4.0 licence. Follow `docs/design-system.md` and AGENTS.md (no
  literal product name).

## First step: a spike that gates the rest
- **Spike result (2026-10-21, on this Mac, Core ML):** use upstream
  `FluidInference/FluidAudio` (0.17.7, 503b4bd1), **not** the
  `altic-dev/FluidAudio` fork (main @ 7d44355). The fork's long-audio path is
  broken: on a 31 min LibriSpeech stream it emitted 3,671 words against 4,634
  reference — **22.4% WER with twelve whole spans of 10–39 s silently dropped**,
  while the same weights through upstream's chunking returned **2.05% WER and
  zero dropped spans**. On isolated ≤15 s clips the fork is clean (1.51% WER),
  so the defect is confined to its `ChunkProcessor` / `AsrChunkTokenMerger`
  stitching — precisely the path a >30 s dictation crosses. The model itself is
  good: 1.51% isolated WER vs Parakeet 0.6B v3's 1.92%, and its output carries
  punctuation and capitals.
- Upstream loads the Core ML repo unchanged **if** the joint file is presented
  as `JointDecisionv3.mlmodelc` (the repo ships `JointDecision.mlmodelc`; a
  symlink or a copy at bundle time satisfies it). `AsrModels.loadLocal(from:
  dir, version: .v3)` + `AsrManager.transcribe(url, decoderState:)` works.
- Reproduced with the two CLIs in `/tmp/asr-lab` (`fluidcli` = fork,
  `fluidcli-upstream` = upstream) and `~/.cache/parakeet-bench/stream-200.wav`.

Before the full build, confirm on this Mac (simulator; Core ML runs on the
CPU there, which is fine for correctness):

1. Which FluidAudio (upstream or fork, which version) loads the model, and
   its licence.
2. A fixture clip (a short English recording; generate one with macOS `say`
   into an AAC `.m4a`) transcribes correctly.
3. Whether the output has punctuation and capitals. If not, report it and
   stop before changing the default; Apple's recognizer stays the default and
   Fluid Speech Mini becomes an option.
4. The iPhone app's real deployment target (the generated Xcode project).

## Acceptance

- Simulator: dictation through the app with Fluid Speech Mini returns the
  fixture's text.
- An iOS < 18 build or a missing model reports `unavailable`, and dictation
  falls back to Apple's recognizer.
- Frontend unit tests for engine selection, feature detection, fallback and
  the English-only rule.
- The fetch script verifies hashes and refuses a mismatch.
- The credit line is shown in Settings → Voice on the iPhone app.

## Not changing

- Browsers, the Mac app, the Word add-in and the backend `/audio` route.
- Recording (still record, then transcribe; no partial results).
