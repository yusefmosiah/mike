# Speech on Android

The Android app's on-device dictation and read-aloud: the Android side of the
`MikeSpeech` plugin (`mobile/plugins/speech/android/`), with the same
JavaScript contract as the iPhone's (`mobile/plugins/speech/README.md`). The
web app's "This phone" engines (`frontend/src/app/lib/voice/deviceSpeech.ts`)
use it unchanged, apart from a download step for Fluid Speech Mini and
platform-neutral wording. Hands-free voice mode is not implemented on Android
yet (see "Android (next)" in `voice-chat.md`).

## What runs where

| | iPhone | Android |
| --- | --- | --- |
| Dictation model | Fluid Speech Mini, Core ML, bundled | Fluid Speech Mini, ONNX build, downloaded on request (about 300 MB) |
| Runtime | FluidAudio on the Neural Engine | ONNX Runtime 1.31, CPU provider, 4 threads |
| Live dictation | FluidAudio's sliding window | `SlidingWindow.java`, same configuration |
| Other dictation | Apple's recognizer | none (the deployment's speech server) |
| Read-aloud model | Phonon 31m, Core ML, downloaded | Phonon 31m, q8 GGUF, downloaded (about 67 MB) |
| Runtime | xn-ptts Swift package | xn-ptts C library (`libptts_ffi.so`) through JNA |
| Other read-aloud | Apple's voices | the phone's text-to-speech engine, offline voices only |

Fluid Speech Mini: FluidVoice publishes an ONNX build
(FluidVoice-Labs/fluid-speech-mini-onnx) with a reference script,
`transcribe.py`. `FluidModel.java` ports it: log-mel features (checked against
the script's numbers in a JVM test), the convolutional front end in 50-frame
chunks, the encoder, and greedy token-and-duration decoding with the
prediction and joint networks. On the fixture clip it gives the script's
transcript word for word. sherpa-onnx was not used: its Parakeet TDT support
expects NeMo's export (encoder, decoder, joiner with metadata), not this
build's split graphs and packed 2- and 4-bit `MatMulNBits` weights, and the
port is a few hundred lines. ONNX Runtime's XNNPACK provider was measured
and is slower here (below): the encoder's `MatMulNBits` layers run on the CPU
provider either way. NNAPI is deprecated and not used.

Phonon: xn-ptts 0.4.0 has no published Android library for the CPU (its
Snapdragon QNN AAR is an unpublished source preview), so
`npm run phonon:android` builds `ptts-ffi` from the pinned tag and commit with
cargo-ndk, following the repository's `android/build.sh` for arm64 only
(dotprod and fp16 required, as there). The iPhone's model mirror holds Core ML
files the CPU runtime cannot read, so Android downloads the upstream
gradium/phonon-31m-en q8 weights and the eight English voices the web app
offers, at the commits the browser engine already pins.

### The model's shapes and precision, and the backend seam

All four graphs take dynamic shapes: the front end `[1, T, 128]` log-mel
frames, the encoder `[1, F, 1024]` (F = T/8) plus a length, the prediction
network one token and its `[2, 1, 640]` LSTM state, the joint network one
encoder frame and one prediction output. An accelerator that needs static
shapes (ONNX Runtime's QNN provider on the Hexagon NPU) would need the
encoder re-exported for fixed windows (for example 15 s, padded and masked).
Activations are fp32. The encoder's weights are 264 `MatMulNBits` layers (118
at 2 bits, 146 at 4 bits, `com.microsoft` domain); its other initializers
are fp32. The front end, prediction and joint networks keep a few fp16
initializers cast to fp32 at run time.

`FluidBackend.java` is the seam for an accelerated backend: `FluidModel`
(ONNX Runtime CPU, `ort-cpu`) is the only implementation, and
`FluidSpeechMini.backend` is the factory the runtime loads from. The plan is
to pick a backend by a benchmark when the model is installed (each candidate
transcribes the fixture, its text must match the CPU backend's, the fastest
is kept per device and model revision).

### ONNX Runtime's telemetry is removed

ONNX Runtime's Android package (1.31) declares a ContentProvider,
`ai.onnxruntime.TelemetryInitializer`, that loads the library and starts
Microsoft's telemetry client (1DS, `ai.onnxruntime.telemetry.HttpClient`)
every time the app launches, whether or not a model is ever used, and asks
for `ACCESS_NETWORK_STATE`. The app must talk only to the firm's server, so
the plugin's manifest removes both (`tools:node="remove"`) and `FluidModel`
also calls `OrtEnvironment.setTelemetry(false)`. The merged manifest of the
debug build has neither; after the change the app's launch logs show no
ONNX Runtime activity (before, the telemetry client's finalizer failed in the
log). Check the merged manifest again on every ONNX Runtime upgrade.

## Downloads

Both models are downloaded only when the person asks (Settings → Voice), from
Hugging Face URLs pinned to a commit, into the app's no-backup files
(`speech-models/`). `ModelInstaller.java` fetches into `<name>.partial`,
resumes with a `Range` request, checks each file's size and SHA-256, and moves
the folder into place only when every file has passed; a revision marker
written last makes a folder from another commit count as not installed.
`remove` deletes the folder and any partial download.

The web app shows the download as a setup step: `status` for `fluid-mini`
reports `downloadable` with `downloadBytes`, `downloading` with `progress`,
then `available` with `removable`. Until it is downloaded, dictation in the
Android app defaults to the deployment's speech server; choosing "This phone"
in Settings offers the download, and a dictation on the phone before it says
so.

## The app

`npm run android:configure` keeps only the `arm64-v8a` native libraries
(`MIKE_ANDROID_ABIS` widens it): ONNX Runtime ships four ABIs, about 140 MB.
The debug APK is about 59 MB, of which ONNX Runtime is 34 MB and Phonon's
library 7.7 MB; a minimal ONNX Runtime build with only this model's operators
would shrink it.

## Measurements

Moto g stylus 5G (2023): Snapdragon 6 Gen 1 (4 × Cortex-A78 and 4 ×
Cortex-A55), 3.5 GB of RAM, Android 14. `SpeechOnDeviceTest` on the 8.0 s
fixture clip (a synthetic voice; numbers vary by about ±30% from run to run
with the phone's temperature):

| | |
| --- | --- |
| Fluid Speech Mini download (300 MB, fast connection) | 13 s |
| Decoding the clip (AAC to 16 kHz) | 0.4–1.0 s |
| Model load | 0.8–1.2 s |
| Warm-up (one second of silence) | 1.2–2.4 s |
| Transcription, warm | 2.5–3.8 s, real-time factor 0.32–0.47 |
| Threads: 2 / 4 / 6, XNNPACK with 4 | RTF 0.40 / 0.32 / 0.45 / 0.74 |
| Live: first text after the start | 2.0–2.6 s |
| Live: text after stop (11 s dictation) | 3.0–4.1 s |
| Phonon download (67 MB) | 4 s |
| Phonon load and first sentence | 1.0 s |
| Phonon, an 8.6 s paragraph | 2.1–2.6 s, 3.4–4× real time |
| The phone's own voice, one sentence | 0.6 s |

Memory (`dumpsys meminfo` and `Debug.MemoryInfo` of the test process):

| | PSS | Native heap |
| --- | --- | --- |
| Neither model | 37–52 MB | 2–3 MB |
| Fluid Speech Mini loaded | 400–454 MB | 120–145 MB |
| Fluid Speech Mini, peak during an 8 s transcription | RSS 542 MB (VmHWM) | |
| Phonon loaded | 320 MB | 272 MB |
| Both loaded | 612–641 MB (RSS 687 MB) | 320–340 MB |

With both loaded, 245 MB of the PSS is the encoder's weights mapped from the
model file (clean pages the system can drop and read again); the private dirty
memory is about 350 MB. The phone had 0.9–1.4 GB available with nothing of
ours running, so both models fit next to the web view, but not with much
room: the app drops Fluid Speech Mini after five idle minutes, when it goes
to the background and on memory pressure, and Phonon after five idle
minutes and on memory pressure.

## Not done yet

- Hands-free voice mode (VAD, end-of-turn, echo cancellation; `voice-chat.md`).
- Dictation in languages other than English on the phone (Android's own
  recognizer would need `SpeechRecognizer` with an audio-file source).
- Phonon on the Snapdragon NPU (xn-ptts's QNN preview).
- A device test of the plugin through the web view itself: the deployed web
  app needs a login, so the on-device test calls the plugin's classes directly.
