# Live dictation on the iPhone

Design for showing Fluid Speech Mini's transcript while the person is still
speaking, so a long dictation (a minute or more) is mostly transcribed by the
time they stop. Status: implemented (see "As built" at the end). Scope: the iPhone app's "This iPhone"
dictation engine with Fluid Speech Mini. Apple's recognizer, the browser
engines and the server engines keep recording a clip and transcribing it at
the end.

## Today

`useDictation.ts` records the whole clip in the web view (MediaRecorder,
AAC), and only on stop sends it as base64 to the `MikeSpeech` plugin's
`transcribe`, which decodes it and runs `AsrManager.transcribe` over 15 s
windows. Nothing can be transcribed before the person stops, because the
plugin has no audio until then. The model now loads and warms up when
recording starts (`prepare`), so the wait after stopping is the transcription
of the whole clip: short for a sentence, growing with a long dictation.

## Design: record natively and transcribe as the audio arrives

FluidAudio 0.17.7 has `SlidingWindowAsrManager`: it takes
`AVAudioPCMBuffer`s as they are recorded (`streamAudio`), transcribes
overlapping windows with left and right context, and publishes
`transcriptionUpdates` with a confirmed part (text that will not change) and
a volatile tail; `finish()` returns the final text. It loads the same
`AsrModels` we already load (`loadModels(_:)`).

### Native (`mobile/plugins/speech`)

- `LiveDictation.swift`, `@available(iOS 18, *)`, under
  `#if canImport(FluidAudio)`:
  - Records with `AVAudioEngine` (input tap), converts to 16 kHz mono and
    feeds `SlidingWindowAsrManager`. Audio session `.playAndRecord` with
    `.measurement` mode while recording; restored afterwards. Audio stays
    in memory and is never written to disk or logged.
  - Reuses the loaded and warmed model from `FluidSpeechMini.Runtime`
    (one model in memory, not two); the runtime does not unload while a
    live dictation runs.
  - Config: FluidAudio's default sliding-window settings to start with;
    record the values in the code. Tune only if the first device test shows
    a problem (lag too long, words cut at seams).
- Plugin methods:
  - `startLive({engine: "fluid-mini"})`: asks for the microphone if needed,
    starts recording and transcribing, resolves when recording has started.
    Rejects with the existing codes (`permission-denied`, `unavailable`,
    `failed`).
  - Event `liveTranscript` via `notifyListeners`: `{confirmed, volatile}`,
    the whole text so far each time (simple for the web side; a minute of
    speech is a few kilobytes), and `{level}` about ten times a second for
    the recording indicator.
  - `stopLive()`: stops recording, calls `finish()`, resolves `{text}`.
  - `cancelLive()`: stops and discards.
  - Interruptions (a call, another app taking the microphone, the app going
    to the background) end the dictation as if stopped: the text so far is
    kept, and the web app is told with a `liveTranscript` event marked
    `ended: true`.
- `status({engine: "fluid-mini"})` adds `live: true` so the web app can tell
  a build that has it from one that does not.

### Web app

- `deviceSpeech.ts`: `liveDictationSupported()`, `startLiveDictation(onUpdate)`,
  `stopLiveDictation()`, `cancelLiveDictation()`, wrapping the plugin and
  its listener (removed on stop, cancel and unmount).
- `useDictation.ts`: when the engine is "device", the model is Fluid Speech
  Mini, the language is English and the app reports `live`, use live
  dictation instead of MediaRecorder; otherwise unchanged. The hook exposes
  the live text (`confirmed` and `volatile`) alongside the existing
  `recording`, `elapsedMs` and `error`.
- Composer (`ChatInput.tsx` and wherever dictation is shown): while
  recording, show the live text in the dictation area above the input:
  confirmed text in the normal colour, the volatile tail muted, scrolled to
  the end; the vocabulary matcher applied to the confirmed part. On stop,
  the final text (vocabulary applied) is inserted into the composer as
  today. Follow `docs/design-system.md`; long text wraps; the area has a
  maximum height and scrolls. The live region is `aria-live="polite"` on the
  confirmed text only, so a screen reader is not flooded by the tail.
- Cancel discards, as today.

## Acceptance

- On an iPhone, a 90-second dictation shows text within a few seconds of
  speaking and keeps up; stopping inserts the final text within about a
  second.
- The final text of a fixture recording through the live path matches the
  clip transcription closely (a unit test in the plugin feeds the fixture's
  samples through the live pipeline and compares with `transcribe`).
- An app build without `live`, Apple's recognizer, a non-English language
  and the browser keep today's behaviour (frontend unit tests).
- Interruptions keep the text so far; the microphone is released on stop,
  cancel, interruption and when the page unmounts.

## Not changing

Apple's recognizer path, the browser and server engines, Phonon, the
vocabulary list, the backend.

## As built

Deviations from the design above:

- One warm model. `SlidingWindowAsrManager.loadModels(_:)` only builds a light
  `AsrManager` around the `AsrModels` it is given (it assigns the same Core ML
  model objects; nothing is loaded or specialised again). `FluidSpeechMini.Runtime`
  now keeps the `AsrModels` it loaded (and `prepare` warmed) and hands them to
  the live session (`beginLive` / `endLive`, which hold the runtime's
  `running` count so it cannot unload during a dictation). The sliding-window
  manager is never `cleanup()`ed, so it does not touch the shared models.
- Window configuration. FluidAudio's default (11 s chunk + 2 s right context)
  produces nothing until 13 s of audio, which would miss "text within a few
  seconds". The live config is chunk 3 s, left context 3 s, right context
  1.5 s (window 7.5 s, inside the model's 15 s input), confirmation after 6 s:
  first text about 4.5 s in, then a window every 3 s. Recorded in
  `LiveDictationSession.config`; tune on a device if words are cut at the seams.
- The recording indicator does not show the input level. The plugin sends
  `{level}` about ten times a second and the web wrapper passes it on, but the
  composer does not render it (a re-render of the composer ten times a second
  was not worth a pulsing dot).
- Added a Cancel (X) button beside Stop while recording, and `cancel()` on
  `useDictation` for every engine; the design's "cancel discards" had no
  control to hang on.
- The live text appears in the composer's own text input, not in a separate
  area above it. When recording starts, `ChatInput` remembers the text before
  and after the caret (or selection); on every update the textarea shows
  before + confirmed + volatile + after, with a space added only where words
  would run together (`lib/voice/liveComposer.ts`), and stays scrolled to the
  newest text. The textarea is `readOnly` until the dictation ends, and the
  placeholder reads "Listening…" while nothing is there yet. On Stop the final
  text replaces the live text in place (caret after it); on Cancel, or when
  stopping fails or returns nothing, the composer returns exactly to what it
  was. The text stays in place, read-only, while the final text is collected.
  A visually hidden `aria-live="polite"` region carries the confirmed text
  only, so the textarea's changing value does not flood a screen reader. There
  is no separate bar.
- An app build in the background: the app going to the background ends the
  dictation like an interruption (the model is then unloaded after the idle
  limit rather than at once, because it was in use when the background
  notification arrived).
