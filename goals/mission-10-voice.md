---
readiness: approved 2026-10-09
---

# Mission 10: Voice — local, OpenRouter and self-hosted

Owner direction (2026-10-09). Supersedes the Station 6 rule "local operator
endpoints only" for testing: OpenRouter is a test lane for parity and coverage
before Mike has its own voice API, and is never available in strict private mode.

## Providers, per direction

| Provider | Speech-to-text | Text-to-speech |
|---|---|---|
| Browser built-in | Chrome on-device recognition, only with `processLocally: true` | `speechSynthesis` with the operating system's voices (Apple's own voices on a Mac) |
| Browser model (WebGPU) | Whisper via transformers.js | Kokoro via kokoro-js |
| OpenRouter | `/api/v1/audio/transcriptions` | `/api/v1/audio/speech` |
| Self-hosted | any OpenAI-compatible server (Mike's GPU later) | same |

## Scope

- Settings → Voice: provider, model and voice per direction; prices from the
  OpenRouter catalog (per minute of speech-to-text, per 1,000 characters of
  text-to-speech); a test bench that runs one recording or sentence through
  several models side by side with transcript or audio, latency and cost.
- Browser model downloads are opt-in: before the first use, ask, describing the
  setup as "about N minutes", N estimated from a small speed test (never a size
  in megabytes).
- Dictation lands in the editable composer, never auto-submits; read-aloud plays
  and stops; nothing is written to disk.

## Acceptance

- Unit tests for provider selection, pricing display, strict-private refusal of
  OpenRouter, and the download consent and estimate.
- Live: OpenRouter transcription and speech through the app; the browser
  built-in voices; one WebGPU model after consent.

## First slice, 2026-10-09 (not accepted)

Built overnight on the owner's go-ahead; nothing here is accepted.

- **Backend** (`backend/src/modules/audio/audio.openrouter.ts`): an optional
  `provider` ("operator", the default, or "openrouter") and OpenRouter
  `model` on transcription and speech. The OpenRouter lane uses the
  deployment's key, is refused in strict private mode, and accepts only
  models from OpenRouter's speech/transcription catalog (cached an hour),
  with a voice the model lists. `GET /audio/options` reports the operator's
  models and the catalog with prices normalized to the unit each model bills
  in. Responses carry provider, model and cost where known.
- **Frontend** (`frontend/src/app/lib/voice/`, Settings → Voice): per-device
  preferences (this browser's storage, since browser voices and on-device
  models are per machine); engines "This server", "OpenRouter", "This
  browser" (Web Speech recognition only with `processLocally = true`;
  `speechSynthesis` voices) and "Open model in browser" (Whisper Base via
  transformers.js, Kokoro 82M via kokoro-js; WebGPU, else WebAssembly).
  Dictation and read-aloud use the chosen engine. The browser model asks
  first: "Check how long setup takes" runs a speed test against the model
  host and reads real file sizes from the Hugging Face API, then offers
  "Setup takes about N minutes on this connection" and a set-up button; no
  size is shown and nothing downloads before that click. A test bench runs
  one sentence (or one recording) through several engines with latency and
  cost; at most four OpenRouter models per run.
- **Tests**: backend 8 OpenRouter-lane cases (price units, strict-private
  refusal, catalog validation, request shapes) beside the existing 25 audio
  cases; frontend 23 (provider selection and fallback, strict-private
  refusal, price display, setup estimate, download consent, engine routing,
  the settings page).

Live receipts:

- Backend, with the deployment key: Kokoro 82M spoke "The quarterly report
  shows the North region ahead of plan by ten percent." (71,424 bytes,
  $0.000045, 1.6 s); Qwen3 ASR 0.6B transcribed it word for word ($0.000015)
  and Voxtral Mini 3B as "... by 10%." ($0.000074).
- In Chrome on the local stack (generated localhost account), Settings →
  Voice test bench, same sentence: this browser's voices 9.0 s, on this
  device (volume set to zero for the run); OpenRouter Kokoro 82M 1.2 s,
  $0.000045; Voxtral Mini TTS 2.6 s, $0.0012; Sesame CSM 1B 4.7 s, $0.00051.
  The run found two defects, both fixed: prices under 10 cents lost
  precision ($0.016 shown as $0.02), and when the saved engine (the
  operator) was not configured, no engine looked selected and nothing said
  why.

Not done: the browser model was not downloaded live (a few hundred
megabytes into the owner's browser needs the owner's go-ahead); dictation
was not recorded live (no microphone use unattended); read-aloud from a chat
message with a non-default engine is covered by unit tests only. The
transformers.js dependency grew the staging frontend image from 2.75 GB to
3.69 GB (`podman images` on node-a); `onnxruntime-node` alone is 536 MB on
disk, unused by the browser. It also brings a
moderate `sprintf-js` advisory on a path the app never runs; trimming that
needs a Dockerfile change, left for the owner.
