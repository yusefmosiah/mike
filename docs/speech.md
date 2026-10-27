# Speech endpoints

The audio module serves dictation transcription and read-aloud synthesis
against the deployment's own OpenAI-compatible speech operator. It is
ephemeral in both directions: no bytes and no text are stored in the database.

## Surface

- `POST /audio/transcriptions` — JSON with a base64 audio payload (not
  multipart), up to 25 MB of audio. Answers a transcript; malformed audio is
  a 400, an absent operator a 503, and an operator failure a 502.
- `POST /audio/speech` — synthesize text with a requested voice/model and
  return audio bytes.
- `GET /audio/options` — the enabled voices/models for the current
  deployment.

The clients and their models are described elsewhere:
[Voice chat on the device](voice-chat.md),
[Voice chat: contract between the parts](voice-chat-contract.md),
[Live dictation on the iPhone](live-dictation-iphone.md),
[Phonon for read-aloud](phonon-read-aloud.md) and
[Speech on Android](android-speech.md).

State as of 2026-10-27; re-read `backend/src/modules/audio/` and
`backend/.env.example` before relying on limits, routes or the speech
operator configuration.
