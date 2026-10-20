# Phonon for read-aloud

Design for adding Phonon text-to-speech beside the voices Mike already has.
Status: implemented. Nothing is removed: the deployment's speech server,
OpenRouter, the browser's voices, Kokoro and Apple's voices all stay.

## The model

- Phonon 31m (Gradium, built on Kyutai's Pocket TTS): English, about 41M
  parameters, 24 kHz mono, streams 80 ms chunks.
  https://huggingface.co/gradium/phonon-31m-en (Apache-2.0, ungated; pin
  commit `52433c4`). Not the Phonon 40m models: CC BY-NC 4.0 and gated.
- Voices: https://huggingface.co/gradium/phonon-voices (Apache-2.0, ungated;
  `voices.jsonl` lists name, language and file). Ready-made voices only; no
  cloning.
- Runtime: https://github.com/gradium-ai/xn-ptts, MIT OR Apache-2.0, release
  v0.4.0 (2026-10-20). Two weeks old and its API has already changed once:
  pin exact versions everywhere.

## Browser: a second model for the "webgpu" engine

Today the `webgpu` read-aloud engine runs Kokoro (`browserModels.ts`,
`browserModels.engine.ts`) after the person consents to the download.

- Add Phonon as the engine's second speech model, chosen with the speech
  preference's `model` (`"kokoro"` or `"phonon"`). New choices default to
  Phonon; an existing stored choice without a model keeps Kokoro.
- npm `phonon-tts` pinned to `0.4.0` exactly. `PhononTTS.load({ lang: "en",
  model: "hf://gradium/phonon-31m-en@<commit>", device: "auto" })`: WebGPU
  with q8 weights (64.5 MB) where the browser has a real adapter, the CPU
  otherwise. Files come from Hugging Face and are cached by the package in
  the Cache API. Nothing is served from node-a.
- No COOP/COEP headers: without cross-origin isolation the CPU build runs on
  one thread, which is acceptable; isolation would break other cross-origin
  loads across the app.
- Same consent, progress and error handling as Kokoro (`consented("speech")`,
  `BrowserModelConsentError`, the setup progress callback). The consent text
  states the download size.
- `synthesizeSentence` keeps its contract (one sentence in, a WAV `Blob`
  out): use `tts.synthWav(text, { voice })`. Load once, keep the instance,
  `dispose()` on the same idle rule Kokoro uses. Streaming within a sentence
  is not needed now.
- Voices: the English entries of `voices.jsonl`, loaded on first use with
  `addVoice(name, url)` (URL pinned to a commit of `phonon-voices`). Settings
  shows a short curated list (about 8 voices, chosen by listening, stored as
  a constant) rather than the whole catalogue.
- Next.js: confirm the package's worker (`new URL('./worker.js',
  import.meta.url)`) and its `.wasm` files bundle under this repo's Next build
  (`npm run build --prefix frontend`) and the Docker image. If they don't,
  copy the package's files to `public/` at build time and pass `workerUrl` /
  `wasmUrl`.

## iPhone: a second model for the "device" engine

Today the `device` engine reads aloud with Apple's voices through the
`MikeSpeech` plugin's `speak` (`OnDeviceVoice.swift`, a WAV back as base64).

- Add the Swift package `https://github.com/gradium-ai/xn-ptts.git`, exact
  version `0.4.0`, product `ptts` (module `PhononTTS`). Excluded architecture
  `x86_64` for the app target if the build needs it.
- Model: downloaded on the phone, not bundled, so the app does not grow.
  Host the release's Core ML bundle (`phonon-31m-en-coreml.zip` from
  v0.4.0, unzipped, with its `bundle.json`; curated English voices only if
  the bundle allows dropping the rest) in a public Hugging Face repo,
  `mosiah/phonon-31m-en-coreml`, with an Apache-2.0 model card crediting
  Gradium. Never node-a. The app downloads it with
  `PhononModels.download(from:progress:)` from a URL pinned to that repo's
  commit (`resolve/<commit>/`), which checks every file against
  `bundle.json` and resumes an interrupted download. This is the phone's
  first request to a host other than the firm's server: it fetches public
  model files only and sends no user content.
- The download happens only after the person chooses Phonon (or confirms
  it the first time read-aloud would use it): Settings shows the size
  (about 160 MB, about twice that on disk once compiled), progress, and a
  way to remove it. Until it is installed, read-aloud uses Apple's voices.
  The plugin gains `install({engine: "phonon"})` with progress events and
  `remove({engine: "phonon"})`; `status` reports `not-installed`,
  `installing`, `available` or `unavailable`.
- `PhononVoice.swift` beside `OnDeviceVoice.swift`: `@available(iOS 18, *)`
  under `#if canImport(PhononTTS)`; installs and loads lazily on first use,
  keeps the instance, unloads on a memory warning and after 5 minutes idle
  (as `FluidSpeechMini.swift` does). `speak({text, voice, engine:
  "phonon"})` returns `{audio, mimeType: "audio/wav"}` from
  `tts.synthesize(text)`. The first load compiles the models (about 10 s);
  `status({engine: "phonon"})` reports `available`, `unavailable` (Phonon not built in,
  model missing) and whether the first use will compile, so the web app can
  say so.
- Web side: `speakOnDevice` passes `engine`; the device engine's speech
  `model` is `"phonon"` or `"apple"`, defaulting to Phonon once the app
  reports it installed, else Apple. Non-English read-aloud uses Apple's
  voices. An older app build ignores the option and speaks with Apple.

### iOS 18 is the app's minimum

xn-ptts declares iOS 18, and Swift Package Manager refuses a dependency whose
floor is above the package using it, so the speech plugin and the app's
deployment target are iOS 18 (`mobile/scripts/configure-ios.mjs`). iOS 17
phones can no longer install the app. Every iPhone that runs iOS 17 can run
iOS 18, and Fluid Speech Mini needed 18 already.

## Settings → Voice

- Read-aloud: on the iPhone app a choice between Phonon and Apple's voices;
  in the browser, under the on-device engine, a choice between Phonon and
  Kokoro. A voice picker for Phonon with the curated list. Follow
  `docs/design-system.md` and the existing layout; update its loading state.
- Credit line: "Phonon by Gradium", linking the model card (Apache-2.0).

## Credits and notices

`CREDITS.md`: Phonon 31m (Apache-2.0) and xn-ptts / `phonon-tts` (MIT or
Apache-2.0). Keep the Apache NOTICE text with the bundled model.

## Acceptance

- Browser: Settings → Voice, choose Phonon, consent, and an answer reads
  aloud; WebGPU used where available (`tts.device`), CPU otherwise; Kokoro
  still works when chosen.
- iPhone (iOS 18 device): choosing Phonon downloads it with progress, then
  it reads an answer aloud; a model not yet downloaded or a failed
  download falls back to Apple's voices; removing it frees the space.
- Frontend unit tests for model selection, defaults, fallback and the
  English-only rule; the frontend coverage gate stays green.
- `npm run build --prefix frontend` and `docker build -f frontend/Dockerfile .`
  pass with the new package.

## Not changing

The backend `/audio` routes, the speech server, OpenRouter, dictation, the
Word add-in and the Mac app.
