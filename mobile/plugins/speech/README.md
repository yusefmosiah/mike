# @mike/speech

The iPhone app's on-device speech: a Capacitor plugin (`MikeSpeech`) that
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
  package's floor is iOS 17 because FluidAudio's is. Test: `xcodebuild test
  -scheme MikeSpeech -destination 'platform=iOS Simulator,name=iPhone 17'`
  in this directory (skipped without the model).
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
| `status` | `language?` (BCP 47; default the phone's), `engine?` (`"fluid-mini"`; absent means Apple's recognizer, so an older web build keeps working) | `{ state, engine?, locale? }`; `state` is `available`, `downloadable`, `downloading` or `unavailable` |
| `install` | `language?`, `engine?` (a no-op for `"fluid-mini"`, which ships in the app) | the new status, after Apple's speech model for the language downloads (a system download; called only from the user's click) |
| `transcribe` | `audio` (base64), `mimeType`, `language?`, `engine?` (`"fluid-mini"` ignores `language`) | `{ text }` |
| `voices` | none | `{ voices: [{ id, name, language, quality }] }`; `quality` is `default`, `enhanced` or `premium` |
| `speak` | `text` (up to 20,000 characters), `voice?` (an `id`), `language?` | `{ audio, mimeType: "audio/wav" }`, 16-bit mono PCM from `AVSpeechSynthesizer.write` |

Rejections carry a `code`: `not-installed`, `unavailable`, `permission-denied`
(speech recognition turned off, older iOS only), `unsupported-audio` (WebM,
unreadable), `invalid-audio`, `too-long` (over 25 MB, or text over 20,000
characters), `empty-text` or `failed`. The web app shows its own message for
each code.

The clip (or the rendered speech) is written to a temporary file for the
length of the call and deleted afterwards; nothing is logged. Only the plugin
class may carry an `@objc(...)` name: the Capacitor CLI registers every such
name it finds as a plugin.
