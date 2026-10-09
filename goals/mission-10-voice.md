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
