# Hands-free voice mode in the browser: plan

Status: planned 2026-10-25. Phase 1 implemented on `feat/web-voice-mode`
(engine in `frontend/src/app/lib/voice/web/`, dispatch in `voiceEngine.ts`,
synthetic end-to-end spec `e2e/voice-web.spec.ts`, passing in headless
Chromium on Linux). Not yet tried on real devices or in Safari and Firefox.
Differences from this plan, as built:

- The turn policy runs on the main thread; the worker keeps only the ring
  buffer and Silero, and posts each frame's probability.
- Speech without words interrupts only while the answer is being worked on
  (`thinking`); while it plays, the microphone is muted (half duplex) and
  "Tap to interrupt" is the way in.
- Tier B uses Whisper on the CPU (no Moonshine yet); with Web Speech (tier C)
  recognition starts at speech onset.
- Silero is downloaded after consent from a pinned Hugging Face revision with
  a checksum, not self-hosted; ONNX Runtime is the copy that
  `@huggingface/transformers` already brings, copied to `public/voice-web/ort/`.
- The speech-server choice appears in Settings only when the deployment has a
  speech server.
- Headless Chromium crashes on `speechSynthesis.speak` and on
  `SpeechRecognition.available`; the silent voice prime is skipped under
  automation, and recognition is asked about only where tier C could apply.

## Owner decisions (2026-10-25)

- **Next priority: full-duplex barge-in.** "Tap to interrupt" stays on the web
  for now ("if it's needed for web I guess, but not ideally"); automatic
  barge-in while an answer plays (phase 2 below) is the next thing to build.
- **Server speech is opt-in.** The deployment's speech server is used by voice
  mode in a browser only when the person turns it on in Settings → Voice
  (`voiceMode.serverSpeech`, default off). No path falls back to it silently:
  `planWebVoice` returns tier D only when the setting is on, and the engine
  uses the server only for a tier D plan. Where the deployment has no speech
  server the setting is hidden, so a browser that needs the server is told
  "Voice mode isn’t available in this browser." instead of being pointed to
  that setting (the engine asks `/audio/options` only when a plan would need
  the server).
- **Phone browsers get a prompt, not a block.** The voice button stays. On an
  iPhone, iPad or Android phone browser (not the native app, not a computer),
  the first tap opens a modal (`VoiceAppModal`): voice mode works best in the
  app, with "Get the app" (shown only when `appUrl` is set in
  `packages/brand/brand.json`; the stock install has none, as the app is
  distributed through enterprise MDM) and "Use voice mode in this browser",
  which continues into the usual consent and download flow. That choice is
  remembered (`voiceMode.phoneBrowser`), after which the button starts voice
  mode directly.
- **Models still download from Hugging Face** after consent (pinned revisions
  with checksums), as built in phase 1.

Read with `docs/voice-chat.md` (the native design; its "Browser" section at
L704–724 is refined here) and `docs/voice-chat-contract.md` (the contract the
web engine implements unchanged).

## What exists

- `frontend/src/app/hooks/useVoiceChat.ts` holds all conversation logic
  (turns, `ClauseCutter`/`SpeakableStream`, barge-in cancel, `continues`,
  spoken steps) and talks to the engine only through the free functions and
  `onVoiceEvent` in `frontend/src/app/lib/voice/voiceEngine.ts`. Those all go
  through the Capacitor `bridge()`; `voiceChatSupported()` (L163) is what the
  voice button keys off (ChatInput.tsx L949–950, useVoiceChat.ts L251).
- Browser models: `browserModels.ts` / `.engine.ts` (Whisper Base, Kokoro,
  consent, WebKit WASM runtime, one-model-at-a-time on iPhone, crash marker),
  `browserModels.phonon.ts` (Phonon TTS, Apache-2.0, 64.5 MB q8, WebGPU or CPU,
  `synthWav(text)` per clause; `clauses.ts` is tuned for it),
  `browserSpeech.ts` (on-device-only Web Speech + `speechSynthesis`),
  `engines.ts` + `mikeApi.ts` (`transcribeAudio` L3953, `synthesizeSpeech`
  L3999) for the server.
- No cross-origin isolation, and it should stay that way (it would break OAuth
  popups, model CDN loads, Sentry): single-thread WASM everywhere.
- `webgpuAvailable()` (browserModels.ts L84–86) only checks `"gpu" in
  navigator`; WebKit is forced to WASM because of an ORT JSEP bug (L15–27).
- `TurnPolicy.swift` is a pure value driven by timestamped events; porting it
  is mechanical and its Swift test traces can become shared JSON fixtures.

## Tiers, detected at runtime (`web/capabilities.ts`)

Probes: secure context + `getUserMedia`; `AudioWorklet` + `WebAssembly`;
WebGPU adapter non-null, not a fallback adapter, limits big enough, a
`requestDevice()` smoke test; WebKit / iPhone from `browserModelRuntime()`;
`deviceMemory`/`hardwareConcurrency` as hints; a prior crash.

| Tier | When | Listening | Words | Speaking |
|---|---|---|---|---|
| A | WebGPU passes, non-WebKit | Silero + Smart Turn (WASM worker) | Whisper Base (later Fluid Speech Mini) | Phonon (WebGPU) |
| B | No WebGPU (Safari with it off, Firefox), WebKit desktop | Silero + Smart Turn | Moonshine (WASM) | `speechSynthesis` (Kokoro opt-in only) |
| C | iPhone/iPad browsers, low memory, models failed | Silero + silence rule | on-device Web Speech, else server with consent | `speechSynthesis` |
| D | Nothing loads, server configured, person agrees | Silero, local | `POST /transcriptions` | `POST /speech` |

Each piece can fail and drop a tier. Plain-text tier sentences, no model names,
downloads as "about N minutes", never MB. For Safari with WebGPU off, say how
to turn it on (verify the current Settings wording first).

## Audio pipeline

getUserMedia (EC/NS/AGC on; read back `getSettings().echoCancellation` as the
policy's `echoCancelled`) → AudioContext at native rate → AudioWorklet
resamples to 16 kHz, 512-sample frames → voice worker (own ORT, plain WASM):
ring buffer, Silero v5 (direct ONNX, not `@ricky0123/vad-web`, which would pull
a second ORT), `TurnPolicy` port, Smart Turn v3.2 cpu ONNX (BSD-2, 8.7 MB,
log-mel front end) → on commit, the utterance → STT → `turn` event.

Self-host ORT wasm and the small models under `public/` (no CDN).

End of turn: phase 1 is a silence rule (start 800–1000 ms, tune); phase 2 adds
Smart Turn (pause 500 ms, threshold 0.6, re-ask every 750 ms, ceiling 3000 ms:
the contract defaults).

Barge-in: phase 1 is half-duplex (mic gated while speaking, "Tap to
interrupt"). Phase 2: duck on first loud VAD frame, pause after hold, confirm
by duration, resume after a false start; full-duplex only when echo
cancellation is on or the person says they use headphones. Play TTS through
`<audio>` elements (two alternating, preloaded), not Web Audio, because
Chrome's canceller is reported not to cancel Web Audio output (re-measure).

## STT and TTS

STT is batch per utterance (VAD already cut it): Whisper Base (wired) for A,
Moonshine tiny/base (MIT, ~28/63 MB, English) for B, server for D. Fluid
Speech Mini WebGPU later (needs a newer ORT than transformers.js 3.8.1 pins:
decision needed).

TTS is clause by clause through a TS `ClauseQueue` (render ahead 1–2, play in
`clauseId` order, drop all on cancel/barge-in): Phonon (A), `speechSynthesis`
(B/C), `/speech` (D). `interrupted.fraction` from the playing element.

## Integration

A `VoiceBackend` interface in `voiceEngine.ts`; today's Capacitor code becomes
`nativeBackend`, the new engine `webBackend` in
`frontend/src/app/lib/voice/web/`. The exported functions keep their names and
dispatch to the active backend, so `useVoiceChat`, `ChatInput` and the setup UI
keep working. `voiceChatSupported()` stays synchronous (cheap checks only).
The web backend emits the contract's `VoiceEvent`s exactly. The `AudioContext`
and `<audio>` elements are primed synchronously inside the voice button's tap.

UI: neutral wording instead of "phone", the tier sentence, a browser mic-denied
message, "Tap to interrupt", a headphones setting.

## Models, privacy

Sizes: Silero ~2 MB, Smart Turn 8.7 MB, Whisper 206 MB, Moonshine 28/63 MB,
Phonon 64.5 MB. Cache Storage with pinned revisions and checksums, ask for
persistent storage after consent, a "remove downloads" action. Nothing
downloads before the person's click. On-device by default; the server tier is
an explicit, stored choice with plain wording; OpenRouter never. No recordings
or transcripts stored.

## Phases

0. Spike on real hardware: AEC residual for `<audio>` vs Web Audio playback in
   Chrome/Safari/Firefox; Silero/Smart Turn WASM latency; Phonon + Whisper on
   one GPU. (Needs a person at the machine.)
1. Half-duplex, silence rule, existing models (~1,800 lines): capabilities,
   capture worklet + resampler, VAD worker, turn policy (silence + max turn),
   clause queue + player, web backend + event mapping, STT/TTS wiring,
   `voiceEngine.ts` dispatch, UI wording, preferences, unit tests, a Playwright
   fake-mic spec.
2. Smart Turn and automatic barge-in (~700 lines), shared Swift/TS fixtures,
   metrics.
3. Tiers and polish: Moonshine for B, spoken steps, crash/device-lost
   recovery, mobile-browser rules, settings, prewarm.
4. Quality: Fluid Speech Mini, STT-confirmed barge-in, live partials,
   threaded build, Kokoro voice.

## Open questions for the owner

1. Server speech (tier D): offered by default, or only by an explicit setting?
   (Plan: explicit setting.)
2. Half-duplex plus headphones acceptable as launch behaviour on speakers?
3. Mobile browsers: offer voice mode best-effort, or point to the iPhone app?
4. English-only models (Moonshine, Fluid Speech Mini) acceptable, given Whisper
   is multilingual?
5. ORT versions: second ORT copy for Fluid Speech Mini, or upgrade
   transformers.js in its own change?
