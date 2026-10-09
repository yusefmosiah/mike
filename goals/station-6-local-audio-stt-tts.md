---
definition_version: 4
readiness: intent
---

# Local audio (dictation and read-aloud): retained scope

**Incomplete. This file is retained intent, not implementation authorization and
not acceptance.** Original Station 6 was written as landed; the accounting found
the endpoints and frontend hooks exist but were never run against a real speech
operator. Baseline: HEAD `4f0f186`, working tree dirty with unrelated Mission 2
WIP; no mutation is authorized from here.

## Intended outcome

Private local voice: a visible mic records dictation that lands in the editable
composer draft (never auto-submitted), and responses can be read aloud sentence
by sentence through the deployment's own STT/TTS operator — no audio or
transcript sent to public cloud browser speech APIs.

## What exists now (source, not acceptance)

- `backend/src/modules/audio/`: authenticated `POST /audio/transcriptions`
  (JSON `audio_base64` + `mimetype`, 25 MB cap) and `POST /audio/speech`
  (text ≤ 4,000 chars, `mp3`/`wav`/`opus`). The client route is JSON, not
  multipart; the service itself forwards multipart to the operator.
- `audio.service.ts` calls an OpenAI-compatible operator configured only from
  env (`MIKE_STT_BASE_URL` / `_API_KEY` / `_MODEL`, default
  whisper-large-v3-turbo; `MIKE_TTS_BASE_URL` / `_API_KEY` / `_MODEL` /
  `_VOICE`, defaults tts-1 / alloy) — no cloud default, so an unconfigured
  deployment answers 503. Requests pass through the shared egress gate and
  buffers never touch disk.
- Frontend: `useDictation.ts` (MediaRecorder → `transcribeAudio`);
  `ChatInput.tsx` mic control inserting the finished transcript at the caret as
  ordinary editable text; `useReadAloud.ts` sentence-by-sentence playback with
  play/stop; `AssistantMessage.tsx` read-aloud control; `mikeApi.ts`
  `transcribeAudio` / `synthesizeSpeech`.
- Tests on disk (source-implemented evidence only): `audio.routes.test.ts`,
  `useDictation.test.ts`, `useReadAloud.test.ts`, `ChatInput.dictation.test.tsx`.

## Open acceptance outcomes

- No run against a real local STT/TTS operator in the recorded environment (no
  operator endpoint configured); real transcription and real synthesized
  playback are unobserved.
- Visible mic, record/stop, draft-without-autosubmit, read-aloud
  play/stop/interruption, and format handling on the real phone and desktop
  surfaces.

## Constraints retained

- Zero audio retention on disk (ephemeral in-memory buffers).
- Dictation populates the editable prompt box and must never auto-submit.
- Local operator endpoints only; no public cloud browser speech APIs.

## Current mapping

Mission 3 audio slice — the original request split audio into its own outcome;
STATUS.md agenda item 3 / TRIAGE.md: "Real private STT/TTS operator, correct
formats, editable draft without autosubmit, interruption/stop, phone/desktop
surface proof. No real speech endpoint receipt reviewed."
