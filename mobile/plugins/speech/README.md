# @mike/speech

The iPhone app's on-device speech: a Capacitor plugin (`MikeSpeech`) that
transcribes a recording with Apple's speech recognition on the phone, and
renders text to audio with Apple's voices. The web app's "This iPhone"
engines (`frontend/src/app/lib/voice/deviceSpeech.ts`) use it: dictation
records the clip as it does for every engine and hands it over; read-aloud
gets a WAV for each chunk of an answer and plays the joined file in its own
player, so it can be sought and keeps playing in the background.

- iOS 26 and later: `SpeechAnalyzer` with `SpeechTranscriber`, or
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
| `status` | `language?` (BCP 47; default the phone's) | `{ state, engine?, locale? }`; `state` is `available`, `downloadable`, `downloading` or `unavailable` |
| `install` | `language?` | the new status, after Apple's speech model for the language downloads (a system download; called only from the user's click) |
| `transcribe` | `audio` (base64), `mimeType`, `language?` | `{ text }` |
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
