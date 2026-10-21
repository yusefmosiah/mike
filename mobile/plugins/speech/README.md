# @mike/speech

The iPhone and Android apps' on-device speech (Android: see "Android" below): a Capacitor plugin (`MikeSpeech`) that
transcribes a recording with Apple's speech recognition on the phone, and
renders text to audio with Apple's voices. The web app's "This iPhone"
engines (`frontend/src/app/lib/voice/deviceSpeech.ts`) use it: dictation
records the clip as it does for every engine and hands it over; read-aloud
gets a WAV for each chunk of an answer and plays the chunks in turn in its own
player, so it can be sought and keeps playing in the background. A chunk's
audio ends at the synthesizer's `didFinish`, not at its first empty buffer:
`AVSpeechSynthesizer.write` also sends empty buffers between phrases, and
stopping there cut every chunk off after about 13 seconds.

- Fluid Speech Mini (`engine: "fluid-mini"`): FluidVoice's Core ML dictation
  model (CC BY 4.0), English only, bundled in the app and run on the Neural
  Engine through the FluidAudio package (Apache-2.0, pinned to 0.17.7 and
  loaded as its `.ultra` variant: same architecture and files). It needs iOS
  18 and the model files, which `npm run speech-model` fetches into
  `ios/Sources/MikeSpeechPlugin/FluidSpeechMini/` (gitignored; Package.swift
  copies the directory into the app). The model loads on the first dictation,
  is dropped on a memory warning, when the app goes to the background and
  after five idle minutes, and needs no speech-recognition permission. The
  package's floor is iOS 18 (see Phonon). Test: `xcodebuild test
  -scheme MikeSpeech -destination 'platform=iOS Simulator,name=iPhone 17'`
  in this directory (skipped without the model).
- Phonon (`engine: "phonon"`, read-aloud only): Gradium's Phonon 31m (Apache-2.0),
  English, a Core ML model on the Neural Engine through the xn-ptts package
  (MIT OR Apache-2.0, pinned to 0.4.0, product `ptts`, module `PhononTTS`).
  The model is not in the app: `install` downloads it
  (`PhononVoice.modelBaseURL`, a public Hugging Face repository at a pinned
  commit, every file checked against its `bundle.json`, resumable) into
  Application Support, and `remove` deletes it. `status` reports
  `not-installed`, `installing` (with `progress`), `available` (with
  `compiling` while the models still need preparing for this phone, about 10
  seconds on the first reading) or `unavailable` (iOS before 18, no download
  source configured). The package's floor is iOS 18 because xn-ptts's is.
  The model loads on the first reading, is dropped on a memory warning and
  after five idle minutes.
- Otherwise, iOS 26 and later: `SpeechAnalyzer` with `SpeechTranscriber`, or
  `DictationTranscriber` on hardware without it. These never send audio off
  the device.
- `SpeechTranscriber` punctuates on its own. `DictationTranscriber` behaves
  like keyboard dictation: punctuation comes from spoken commands ("period",
  "comma"). The iOS simulator has only `DictationTranscriber`.
- Earlier iOS: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`, only
  when the language is supported on the device. Apple's server recognition is
  never used.

| Method | Options | Resolves |
| --- | --- | --- |
| `status` | `language?` (BCP 47; default the phone's), `engine?` (`"fluid-mini"` or `"phonon"`; absent means Apple's recognizer, so an older web build keeps working) | `{ state, engine?, locale? }`; `state` is `available`, `downloadable`, `downloading` or `unavailable`; for `"phonon"`: `{ state, engine: "phonon", progress?, compiling? }` with `state` `not-installed`, `installing`, `available` or `unavailable` |
| `install` | `language?`, `engine?` (a no-op for `"fluid-mini"`, which ships in the app; `"phonon"` downloads its model and resolves when it is done, while `status` reports the progress) | the new status, after Apple's speech model for the language downloads (a system download; called only from the user's click) |
| `remove` | `engine` (`"phonon"` only) | the new Phonon status; the model's files are deleted |
| `transcribe` | `audio` (base64), `mimeType`, `language?`, `engine?` (`"fluid-mini"` ignores `language`), `vocabulary?` (up to 100 names and terms of at most 64 characters, the person's first; set as `contextualStrings` on `SFSpeechRecognitionRequest` and `AnalysisContext` for `SpeechAnalyzer`; `"fluid-mini"` ignores it; an older app build ignores it too) | `{ text }` |
| `startLive` | `engine` (`"fluid-mini"`) | nothing, once recording has started. Records with `AVAudioEngine` and transcribes as the person speaks (`LiveDictation.swift`); audio stays in memory. Asks for the microphone if needed (`permission-denied` if refused). Text arrives as `liveTranscript` events: `{ confirmed, volatile }` (the whole text so far; `ended: true` when an interruption, a lost input or the app going to the background stopped it, keeping the text) and `{ level }` (0 to 1, about ten a second). `status` reports `live: true` for `"fluid-mini"` in builds that have this |
| `stopLive` | none | `{ text }`, the final text (after an interruption, the text kept then) |
| `cancelLive` | none | nothing; recording stops and everything is discarded |
| `voices` | none | `{ voices: [{ id, name, language, quality }] }`; `quality` is `default`, `enhanced` or `premium` |
| `speak` | `text` (up to 20,000 characters), `voice?` (an `id`, or a Phonon voice name with `engine: "phonon"`), `language?`, `engine?` (`"phonon"`; rejects `not-installed` until the model is downloaded) | `{ audio, mimeType: "audio/wav" }`, 16-bit mono PCM from `AVSpeechSynthesizer.write` |

Hands-free voice mode (`docs/voice-chat.md`, contract in
`docs/voice-chat-contract.md`): `voiceStatus`, `voiceInstall`, `voiceStart`,
`voiceStop`, `voiceSpeak`, `voiceEndAnswer` and `voiceCancelAnswer`, with every
event on the `voiceEvent` listener. One `AVAudioEngine` with Apple's voice
processing (`VoiceAudioEngine.swift`); Silero VAD, Parakeet EOU 120M (320 ms,
re-armed on every `<EOU>`, `EouStream.swift`) and Smart Turn v3.2
(`SmartTurn.swift`) feed the pure `TurnPolicy`; a committed turn is
transcribed by the warm Fluid Speech Mini; answers are spoken clause by clause
through Phonon into the engine's player node (`ClauseQueue.swift`,
`VoiceEngine.swift`). `voiceInstall` downloads VAD, EOU and Smart Turn from
their upstream Hugging Face repositories at pinned commits, each file checked
against its SHA-256 (`VoiceModels.swift`), into Application Support, plus
Phonon through its own install. The tests in `TurnPolicyTests`,
`ClauseQueueTests`, `VoiceContractTests` and `VoiceModelsTests` need nothing;
`VoiceModelIntegrationTests` runs the models on the fixture clip when
`TEST_RUNNER_MIKE_VOICE_MODELS` names a directory holding them (`vad/`,
`eou/`, `smart-turn/`, laid out as the install writes them).

Rejections carry a `code`: `not-installed`, `unavailable`, `permission-denied`
(speech recognition turned off, older iOS only), `unsupported-audio` (WebM,
unreadable), `invalid-audio`, `too-long` (over 25 MB, or text over 20,000
characters), `empty-text`, `install-failed` (Phonon's download) or `failed`. The web app shows its own message for
each code.

The clip (or the rendered speech) is written to a temporary file for the
length of the call and deleted afterwards; nothing is logged. Only the plugin
class may carry an `@objc(...)` name: the Capacitor CLI registers every such
name it finds as a plugin.

## Android

`android/` implements the same contract for dictation and read-aloud
(`MikeSpeechPlugin.java`; design and measurements in
[docs/android-speech.md](../../../docs/android-speech.md)). Hands-free voice
mode is not implemented there: the plugin does not list `voiceStatus`, so the
web app hides voice mode on Android.

- Fluid Speech Mini (`engine: "fluid-mini"`): the model's ONNX build
  (FluidVoice-Labs/fluid-speech-mini-onnx, about 300 MB, 2- and 4-bit
  `MatMulNBits` weights) on ONNX Runtime 1.31's CPU provider, four threads;
  `FluidModel.java` ports the model's reference `transcribe.py` (log-mel,
  chunked front end, encoder, greedy TDT). It is not in the app: `status`
  reports `downloadable` (with `downloadBytes`), `downloading` (with
  `progress`) or `available` (with `live: true` and `removable: true`);
  `install` downloads it from Hugging Face at a pinned commit, checks every
  file's size and SHA-256 (`ModelPack.java`, `ModelInstaller.java`, resumable)
  into the app's no-backup files; `remove` deletes it. `prepare` loads and
  warms it. `transcribe` decodes the clip with MediaExtractor and MediaCodec
  (AAC/MP4, Opus/WebM, WAV, MP3) to 16 kHz mono. `startLive`, `stopLive` and
  `cancelLive` record with AudioRecord (`VOICE_RECOGNITION`, 16 kHz, asking
  for the microphone if needed) and transcribe in sliding windows with the
  iPhone's live configuration (`SlidingWindow.java`: 3 s chunks, 3 s left and
  1.5 s right context, the volatile tail refreshed about once a second),
  sending the same `liveTranscript` events; the app leaving the foreground
  ends a live dictation and keeps its text (`ended: true`). The model is
  dropped after five idle minutes, in the background and on memory pressure.
  Inference sits behind `FluidBackend.java` so an accelerated backend can be
  added later. ONNX Runtime's own telemetry provider (it starts Microsoft's
  telemetry client at app launch) is removed in the plugin's manifest and
  telemetry is turned off on the environment.
- Phonon (`engine: "phonon"`): xn-ptts 0.4.0's C library (`libptts_ffi.so`,
  arm64, called through JNA, `Phonon.java`) on the CPU. The library is built
  from the pinned xn-ptts source by `npm run phonon:android` (Rust, cargo-ndk
  and the NDK) into `android/src/main/jniLibs/` (gitignored); without it
  `status` reports `unavailable`. The model is the upstream
  gradium/phonon-31m-en q8 weights plus the eight English voices the web app
  offers, pinned and checked like Fluid Speech Mini (about 67 MB): `status`
  reports `not-installed` (with `downloadBytes`), `installing` (with
  `progress`), `available`; there is no `compiling` step on Android. `speak`
  returns a 24 kHz 16-bit mono WAV, like the iPhone's.
- Without `engine`, `speak` and `voices` use the phone's own text-to-speech
  engine (`SystemVoice.java`, `synthesizeToFile`), offering only voices that
  need no network. Dictation without `engine` (the iPhone's Apple
  recognizer) has no Android counterpart: `status` reports `unavailable` and
  `transcribe` rejects `unavailable`.

Tests: `./gradlew :mike-speech:testDebugUnitTest` in `mobile/android` runs
the JVM tests (resampling, log-mel against the reference script's numbers,
token decoding, the sliding window, the download and its checks against a
local server). `SpeechOnDeviceTest` (androidTest) runs both models on a phone
with the fixture clip and reports latency and memory; its header has the
commands.
