# Voice chat on the device

Status: design for discussion (2026-10-20), revised for hands-free from the
first build. Not approved for building.
Target: the iPhone app first; Android next (the architecture is chosen so it
ports); the browser on the GPU after that.

"Voice chat" means a cascaded conversation: the person speaks, on-device
speech-to-text turns it into text, the assistant answers through the normal
chat turn (tools, retrieval, inline citations, durable runs), and on-device
text-to-speech speaks the answer, hands-free, with the person able to
interrupt. Speech-to-speech models are out of scope.

## The answer in short

Yes: detection, interruption and echo cancellation sit *around* the speech
models, not inside them, so Fluid Speech Mini and Phonon stay. The design is
hands-free from the first build: no push-to-talk stage. The hard problems
(the shared audio engine, echo, the end of a turn, barge-in) are coupled, and
a push-to-talk stage would skip all of them, so it would teach us little.

The pipeline, every part on the device:

- **One audio engine** with Apple's voice processing, so the echo canceller
  hears Phonon as its reference.
- **Listening, in two passes:**
  - NVIDIA's Parakeet realtime EOU 120M streams a rough transcript every
    320 ms. It gives the live text on screen, the words that confirm a
    barge-in, and an end-of-utterance token.
  - Silero VAD tracks speech and silence.
  - Pipecat's Smart Turn v3.2 confirms that a pause is the end of the turn.
  - When the turn is committed, Fluid Speech Mini transcribes the whole
    utterance once. Its text is what the assistant receives.
- **Speaking, clause by clause:** the streaming answer is cut into clauses,
  and each clause becomes one Phonon call. Exactly one clause is prepared
  ahead while another plays. The played-sample clock records what the
  person actually heard.
- **Barge-in:** speech plus words that are not the assistant's own stops
  playback within tens of milliseconds, cancels the answer, and keeps the
  part that was heard.

Volocal, an open-source iPhone app, wires most of this end to end. It uses
Parakeet EOU on the Neural Engine, Pocket TTS on Core ML, one shared engine
with voice processing, barge-in, and speaks sentence by sentence. Its gaps
are our improvements:

- It ends a turn on the EOU token alone, with no VAD and no Smart Turn.
- It barges in on any two-word partial, including echo or a TV.
- It speaks whole sentences, not clauses.
- It sends the rough streaming transcript to the model.

Pipecat and LiveKit run the loop on a server, which would give up keeping
audio on the device, so we do not use them.

## What we have

| Piece | iPhone app | Browser | Server |
|---|---|---|---|
| Speech to text | Fluid Speech Mini on the Neural Engine; warmed on mic press; live partials via FluidAudio's sliding window (`docs/live-dictation-iphone.md`) | Fluid Speech Mini ONNX on WebGPU (`mosiah/fluid-speech-mini-onnx-webgpu`); Whisper | OpenAI-compatible route |
| Text to speech | Phonon on the Neural Engine, downloaded and compiled on install (`docs/phonon-read-aloud.md`) | Phonon (`phonon-tts`, own WebGPU backend in a worker); Kokoro | OpenAI-compatible route |
| Vocabulary | correction of names in every transcript | same | — |
| Chat turn | SSE stream; tools; inline citations; durable runs that resume (`docs/resume-interrupted-answers.md`) | same | — |

## Architecture

```
 native voice engine (Swift; Kotlin later)    web app (shared TS)          server
 ┌──────────────────────────────────────┐    ┌───────────────────────┐   ┌────────────┐
 │ audio engine + voice processing       │    │ conversation           │   │ chat turn   │
 │ VAD · EOU stream · Smart Turn         │──▶ │  turn ⇄ chat turn (SSE)│──▶│ (SSE, tools,│
 │ endpointing + barge-in policy         │    │  speakable text        │◀──│  citations) │
 │ Fluid Speech Mini final pass          │◀── │  clause cutting        │   └────────────┘
 │ clause queue → Phonon → player node   │    │  spoken-prefix record  │
 │ played-sample clock                   │    │  screen                │
 └──────────────────────────────────────┘    └───────────────────────┘
```

The split follows time. Anything that must react inside an audio frame lives
in the native voice engine:

- deciding that speech started or a turn ended;
- confirming a barge-in and stopping playback;
- knowing which sample is playing.

The engine does not wait on the web view for any of this. The web app owns
everything about the conversation:

- the chat turn;
- making text speakable and cutting it into clauses;
- the voice prompt;
- what was heard;
- the screen.

These are the parts Android and the browser share. The previous draft put
every policy in TypeScript. Moving the audio-timed ones native removes a
web-view round trip from barge-in and keeps working when the web view is
busy rendering a streaming answer.

- **Native policies are tested with recorded audio.** The VAD, EOU and Smart
  Turn outputs are fed as event traces, and the timer and threshold logic is
  replayed against them. The same traces later check the Kotlin engine.
- **The thresholds are one configuration object** that the web app passes on
  start. Tuning them needs no native release.

### States and events

States: `idle`, `listening`, `user-speaking`, `confirming-end`, `thinking`,
`speaking`. The engine owns the transitions inside a turn. The web app sees
them as events.

Engine → web app:

- `state(name)`
- `partial(text)`: the EOU stream, shown live.
- `turn(text, audioMs)`: the Fluid Speech Mini final text.
- `bargeIn`
- `clausePlayed(id)`
- `interruptedAt(clauseId, fraction)`
- `idleTimeout`
- `routeChanged`
- `interruption(began|ended)`
- `metrics(stageTimings)`

Web app → engine:

- `start(config)`, `stop()`
- `speak(clauseId, text, final)`
- `endAnswer()`: the answer is complete; return to listening after the last
  clause.
- `cancelAnswer()`: the server turn failed.

## The iPhone design

### Audio session and engine

- One `AVAudioEngine` for the whole conversation. Session `.playAndRecord`,
  mode `.voiceChat`, options `.defaultToSpeaker` (and Bluetooth options;
  iOS 26's `.bluetoothHighQualityRecording` for AirPods, to be tested).
- `inputNode.setVoiceProcessingEnabled(true)` before reading any format;
  rebuild the graph on a route or configuration change (stale formats crash
  `start()`); test on devices only (the simulator reports 0 input channels).
- Phonon plays through an `AVAudioPlayerNode` on that engine: we take
  `tts.stream(text)`'s 80 ms Float32 24 kHz chunks and schedule them
  ourselves. `PhononPlayer` cannot be used: it owns a private engine and
  sets the session itself (if ever used, `configureSession: false`).
- Set `voiceProcessingOtherAudioDuckingConfiguration` to the minimum.
  Expect quieter, more telephone-like speech while voice processing is on;
  that is by design.
- The microphone tap is converted to 16 kHz mono and fanned out to VAD,
  end-of-turn and STT.

### Listening

All four streams run all the time on the 16 kHz mono tap:

1. **Silero VAD** (FluidAudio, Core ML) does three things:
   - provides speech and silence with hysteresis;
   - opens the end-of-turn check after a 200-300 ms pause;
   - bounds the utterance for the final pass.

   FluidAudio's streaming VAD reports `speechEnd` one 256 ms block late
   (FluidAudio #1007). Use a smaller hop or our own hysteresis over its
   probabilities.
2. **Parakeet EOU 120M at 320 ms** (`StreamingEouAsrManager`) emits the
   following:
   - partial text every 320 ms (English, lower case, no punctuation; about
     5% WER on LibriSpeech test-clean);
   - an `<EOU>` token, with a median of 160 ms after speech per NVIDIA's
     synthetic test.

   It is the same model Volocal runs on an iPhone 15. Two problems to code
   around, both from #1007 and both unchanged on FluidAudio `main`:
   - After a mid-sentence `<EOU>`, later words are lost until `reset()`.
   - Some pauses decode words twice.

   Our engine therefore treats `<EOU>` only as a candidate. It re-arms the
   model itself: fresh caches, replaying audio from the token. We do not rely
   on `reset()` timing.
3. **Smart Turn v3.2** (BSD-2, Core ML port about 17 MB, about 3.5 ms on
   Apple silicon) runs once per candidate (a VAD pause or `<EOU>`) on the
   turn's last 8 s.
   - At 0.5 or more, the turn ends.
   - Below 0.5, keep listening.
   - A hard limit ends the turn after about 2 s of silence whatever the
     models say.
4. **Fluid Speech Mini final pass:** on commit, transcribe the VAD-bounded
   utterance (already warm). It is about 25 ms per 15 s window on a Mac, to
   be measured on the iPhone. Then apply the dictation vocabulary.
   - Fluid Speech Mini is the most accurate of these models: 4.54% average
     WER.
   - It is trained to follow the main speaker when others talk: 10.9% WER
     against Parakeet v3's 20.4% with background voices, self-reported.

   This is the text the assistant receives. The live partials are replaced
   by it on screen.

Live dictation today uses Fluid Speech Mini's sliding window, which gives
text every 3 s. In voice mode the EOU stream replaces it, so the sliding
window stays for dictation only.

**Runner-up, if the EOU model misbehaves beyond the re-arm fix:** Nemotron
Speech Streaming 0.6B at 560 ms (`StreamingNemotronAsrManager`).

- **For it:** punctuated, about 2.3% WER on test-clean.
- **Against it:** no EOU token, so the end of a turn rests on Silero and
  Smart Turn alone. It also takes about 600 MB, and another conversion fails
  to compile for the Neural Engine on an iPhone 14 Pro Max on iOS 27.2
  (speech-swift #503).

Apple's SpeechAnalyzer is the zero-memory fallback for partials. It has no
end-of-utterance signal.

### Echo and barge-in

- Voice processing cancels most echo but not all, so a barge-in needs
  confirmed speech, not just sound. Both conditions must hold:
  - **(a)** VAD speech for at least about 300 ms;
  - **(b)** at least two words in the EOU partials that do not match the
    clause being played (compare against its text).

  That avoids Volocal's failure, where any two-word partial interrupts,
  including the assistant's own leaked echo or a TV. Reference figures from
  Krisp (vendor-measured):
  - VAD alone treats 66% of backchannels ("mm-hm", "right") as
    interruptions;
  - a three-word rule cuts that to 3.6%, but takes about 1.5 s.
- **On a confirmed barge-in:**
  - stop the player node and cancel the Phonon task;
  - bump the turn token so any clause still in flight is dropped (Volocal's
    `turnRevision`, applied on every path, which Volocal misses on one);
  - report `interruptedAt`;
  - the web app cancels the chat turn and records what was heard.
  The person's speech is already being transcribed, so their next turn
  continues without a gap.
- **False start** (VAD speech but no words within about 1.5 s): pause
  playback rather than stopping it, and resume if nothing follows (LiveKit's
  default behaviour).
- **Echo fallback**, if voice processing leaves too much at loudspeaker
  volume: FluidAudio's LocalVQE (4.8M parameters, 16 ms, beta, needs the
  played audio as its reference; not stacked on voice processing). A last
  resort is a voice match: FluidAudio's CAM++ speaker embedding, enrolled
  from the person's first turns, as a third barge-in condition.

### Speaking

Phonon streams audio out but cannot take text in while it speaks. Each call
fills its prompt once and generates until its end, and none of its APIs
accepts appended text. So the web app cuts the streaming answer into
clauses, and the engine speaks one clause per call.

- **Cutting:**
  - after `.`, `!` or `?` followed by whitespace, guarded by our abbreviation
    list (legal text breaks the "next word is capitalised" rule Volocal
    uses);
  - at `,`, `;`, `:` or a dash once the clause has at least 5-6 words (never
    under 4: Phonon reads very short texts poorly);
  - at about 24-30 words at the most, well inside the 48-token prompt limit.

  The first clause may be shorter, so sound starts sooner. Make text
  speakable before cutting, so a citation or number is never split. End a
  clause that stops mid-sentence with a comma, so its intonation stays open
  (Phonon adds a full stop otherwise).
- **Scheduling:** one Phonon instance, loaded and warmed when voice mode
  starts. Prepare the next clause while one plays; Phonon runs about 12× real
  time with first audio in 16-37 ms (Gradium's figures, iPhone 16 Pro). The
  80 ms chunks go on our own `AVAudioPlayerNode` (`PhononPlayer` owns a
  private engine). Add a short crossfade at clause seams, because each call
  starts fresh, and test for clicks.
- **Stopping:** cancel the consuming task (breaking the loop alone does not
  stop Phonon's producer) and stop the node. Phonon notices at the next
  80 ms frame, so it stops in tens of milliseconds (inferred from the
  source).
- **Speed:** Phonon's rate and temperature are fixed when the iPhone bundle
  is exported, so a speech-rate setting is a playback time-stretch
  (`AVAudioUnitTimePitch`).
- **What was heard:** Phonon gives no word timings. Clause boundaries are
  exact, because they are sample counts.
  - Inside the interrupted clause, estimate the position by syllable weight
    and snap back to the last whole word.
  - If the estimate proves too rough, run Fluid Speech Mini over the played
    audio to align it.

### Models in memory and on the Neural Engine

| Model | Memory | Runs |
|---|---|---|
| Fluid Speech Mini | about 280 MB | once per turn |
| Parakeet EOU 120M | about 300 MB (speech-swift's figure; to be measured) | continuously, every 320 ms |
| Phonon 31m | about 95 MB | while speaking |
| Smart Turn v3.2 | about 17 MB | once per candidate pause |
| Silero VAD | under 2 MB | continuously |

About 700 MB in all, which fits a 6 GB iPhone alongside the web view; we
measure it.

One developer reports that iOS 27 runs Neural Engine predictions one at a
time, even across models (unconfirmed; Apple has not replied). If so, the EOU
stream and Phonon queue behind each other while the assistant speaks. Both
are well inside real time, but Instruments decides. Fallbacks:

- VAD and Smart Turn on the CPU (already cheap there);
- Phonon on the CPU (first audio about 55 ms).

### Lifetime

Voice mode runs in the foreground with the screen awake. Locked-screen
conversation needs the audio background mode and an App Review explanation
(Guideline 2.5.4); later, if wanted. Handle interruptions (calls, Siri) and
media-services resets by ending the turn cleanly and rebuilding the engine.

## The conversation layer

- **Speak while the answer streams.** Make the streaming text speakable,
  cut it into clauses (rules under "Speaking") and send each clause to the
  engine as soon as it is complete.
- **Speakable text.** Before synthesis, in code:
  - Strip markdown, links and citation markers.
  - Expand what Phonon's English rules miss:
    - "§" and "¶";
    - "v." and "et al.", "e.g." and "i.e.";
    - "Inc.", "Corp.", "Ltd.", "No.", "Art." and "Sec.";
    - "U.S.C." and "Fed. R. Civ. P.";
    - pinpoints like "12(b)(6)" (Phonon turns brackets into commas);
    - "id." and "supra".
  - Phonon deletes en and em dashes, so replace them with a comma, or "to" in
    a range.
  - Read ordinals and dates (Phonon's date and time rules are off by
    default).
  - Keep a pronunciation list; the dictation vocabulary is a start.
  - Tables, code and long quotes become "it's on the screen".
- **Voice prompt.** Added to voice turns: one or two sentences for a direct
  answer, one question at a time, summary first then offer detail, no
  markdown, cite the main source aloud in words ("clause 4 of the lease"),
  everything else on screen. OpenAI's voice prompting guide is the best
  reference.
- **Tool calls.** When a tool call starts, the app says a short fixed phrase
  ("Checking the lease…") or plays an earcon, rather than relying on the
  model to say one first (production reports show model fillers arriving
  late).
- **Interrupted answers.** Keep two things per assistant message: the full
  text (for the record) and the spoken prefix with an `interrupted` mark.
  The next turn's context uses the spoken prefix, so the model knows what
  the person heard, from the engine's `interruptedAt` (exact per clause,
  estimated within the clause).
- **Latency target.** Under about 800 ms (median) from the end of speech to
  the first sound; tail under 1.5 s. Stages: end-of-turn 200-600 ms; final
  pass tens of milliseconds (to be measured); model's first token 250-600 ms
  (more with tools); Phonon tens of milliseconds. Log each stage per turn
  and report medians and tails from the device.

## The screen

- **Starting and ending:** a voice mode button in the composer starts a
  hands-free conversation; one control ends it. Afterwards the conversation
  is an ordinary chat.
- **No push-to-talk or tap to interrupt:** the person interrupts by
  speaking. The end control and the system's audio controls are the manual
  way out.
- **States:** listening, thinking and speaking are shown in words and shape,
  not colour alone.
- **Live text:** the person's live transcript is replaced by the final text
  when the turn ends. The answer's text grows as it is spoken, with an
  interrupted answer marked where speech stopped. Citations appear as chips
  on screen.
- **Accessibility:** VoiceOver and Phonon must not talk over each other.
  Everything spoken is also on screen as text. The speech rate setting is
  kept.

## Android (next)

- Audio: `MODE_IN_COMMUNICATION`, capture with `VOICE_COMMUNICATION` (Oboe
  where possible), speech played with `USAGE_VOICE_COMMUNICATION` so the
  platform canceller has the reference; route to the speaker explicitly
  (`setCommunicationDevice`). Platform echo cancellation quality varies
  between manufacturers, so the canceller sits behind an interface with a
  software fallback (WebRTC's AEC3; a Rust port exists).
- Models: NNAPI is deprecated; NPUs are per chip (LiteRT's NPU API covers
  Qualcomm, MediaTek, Tensor), so the CPU is the baseline and the NPU an
  opt-in fast path for known chips. Fluid Speech Mini ONNX on ONNX Runtime
  (or sherpa-onnx) for the final pass; sherpa-onnx's Nemotron streaming
  560 ms build for partials (Android has no Parakeet EOU build yet, so the
  end of a turn is Silero plus Smart Turn); Phonon's Rust runtime on the CPU (Gradium
  claims 6× real time on one core) or its QNN build on Snapdragon (in the
  v0.4.0 release); Silero VAD and Smart Turn via ONNX.
- Same conversation core, same event traces.

## Browser (after Android)

- Speech to text: Fluid Speech Mini on WebGPU (ORT-web) for the final pass,
  utterances cut by VAD. There is no browser build of a cache-aware
  streaming model yet. Partials come from re-decoding the open utterance
  (parakeet.js-style windows) or from Moonshine streaming; measure both.
  The end of a turn is Silero plus Smart Turn (ONNX).
- Text to speech: Phonon's WebGPU stream in its worker.
- VAD: Silero via `@ricky0123/vad-web` on WASM, in its own worker, kept off
  the GPU; its bundled ONNX Runtime kept separate from ours.
- Echo: Chrome's canceller does not cancel Web Audio output (only
  `<audio>` elements and WebRTC remote audio); Safari and Firefox do. In
  Chrome, play speech through a media element (or a local WebRTC loopback);
  check `getSettings()` at runtime; half duplex otherwise.
- Two GPU users in one page (ORT's device and Phonon's in its worker) means
  two devices on one GPU: check `adapter.limits` first, keep transcription
  dispatches short, buffer 300-500 ms of speech ahead, and measure Phonon
  while transcription runs.
- Mobile browsers: foreground only; iOS Safari's echo-cancellation crackle
  (WebKit 326286) makes the iPhone app, not Safari, the iPhone path.

## Risks and how we settle them

These are tuning questions for the whole loop, measured on the device with
the loop running, not reasons to build it in stages.

| Risk | How we settle it |
|---|---|
| Voice processing leaves echo at loudspeaker volume | Phonon at full volume through the speaker; count false barge-ins per 10 minutes; LocalVQE comparison |
| The end of a turn cuts people off or lags | About 200 recorded turns with mid-sentence pauses, replayed through EOU only, Silero + Smart Turn, and EOU + Smart Turn; cut-offs per 100 turns against silence after the last word |
| EOU stream loses or repeats words (#1007) | The same recordings through our re-arm; compare with Fluid Speech Mini's text |
| Barge-in fires on echo, backchannels or a TV | The 300 ms + two-foreign-words rule against Volocal's rule, with a TV on; add the voice match only if needed |
| iOS 27 serialises the Neural Engine | Instruments: the EOU stream and Phonon together; CPU fallbacks |
| Memory and heat over a long conversation | 20 minutes of conversation on the oldest supported iPhone |
| Clause seams sound choppy | Listening comparison of whole sentences against clauses, with and without a trailing comma and crossfade |
| What was heard drifts | Interrupt at random points; compare the estimate with alignment of the played audio |
| Side conversations start turns or barge in | Count them on the device; if common, score each final turn with Pipecat's Audience (addressee classifier, 33M, Apache-2.0, Core ML, about 6 ms; built for games, so measure on our speech) with two cards, the assistant and someone else in the room, and drop turns addressed elsewhere |
| Tool turns feel slow | Stage timings on real legal questions with retrieval |
| Licences | Fluid Speech Mini CC BY 4.0 (credit needed); Parakeet EOU and Nemotron under NVIDIA's Open Model License (read before shipping); Smart Turn BSD-2; Silero MIT; Phonon 31m Apache 2.0 |

## Order of work

The first build is the whole hands-free loop on the iPhone. The steps below
are an order to write the code in, not stages to ship:

1. **Native voice engine:** the shared audio engine with voice processing,
   the four listening streams, the endpointing and barge-in policies, the
   clause queue and player node, the played-sample clock and the turn token.
   Each stage logs its timings. Policy tests replay recorded event traces.
2. **Conversation in the web app:**
   - speakable text and clause cutting;
   - the voice prompt;
   - the chat turn wired to the engine's events;
   - the spoken-prefix record on the server;
   - the voice mode screen.
3. **Tuning on the device:** the table above, with the loop running end to
   end. Thresholds come from the web app's configuration, so tuning needs no
   app release.
4. **Latency work:**
   - start the chat turn speculatively on a probable end, cancelled if the
     person goes on (never running tools before the turn is confirmed);
   - fixed phrases while a tool runs.
5. **Android, then the browser,** on the same conversation code and event
   traces.

## As built (native)

The iPhone voice engine is in `mobile/plugins/speech/ios/Sources/MikeSpeechPlugin/`
(`VoiceAudioEngine`, `EouStream`, `SmartTurn`, `TurnPolicy`, `ClauseQueue`,
`VoiceEngine`, `VoiceModels`, `VoiceContract`) and implements
`docs/voice-chat-contract.md`. It has run in the iOS simulator only (unit
tests, and the listening models on the fixture clip); nothing has been tried
on a device yet, so every threshold above is still untuned. Where it differs
from the design:

- **Smart Turn needs no feature code.** The Core ML port
  (`aufklarer/Smart-Turn-v3.2-CoreML`) has the Whisper front-end inside the
  model: zero-mean, unit-variance normalisation of the window and an 80-bin
  log-mel (n_fft 400, hop 160). Its input is raw 16 kHz audio,
  `audio [1, 128000]`, with the most recent sample last and zeros in front.
  So there is no Accelerate log-mel to write or check against a reference;
  the tests check the window instead (its length, alignment and truncation).
- **The EOU model runs outside `StreamingEouAsrManager`.** The manager reports
  `<EOU>` only after its own 1.28 s debounce, and it hides the per-chunk
  token. `EouStream` drives FluidAudio's public pieces (the NeMo mel
  spectrogram, the 320 ms loopback encoder, `RnntDecoder`, `Tokenizer`) chunk
  by chunk, as the manager does internally. On every `<EOU>` it re-arms:
  - it starts fresh encoder caches and decoder state;
  - it replays the audio from just after the last decoded token's 80 ms frame;
  - it keeps the text so far.
  `<EOU>` is a candidate only if that state decoded words. An `<EOU>` with no
  words moves on one 320 ms shift, so the stream always advances. On the
  fixture clip with 1.5 s of silence inserted mid-sentence, the words after
  the pause are kept and none is decoded twice (`VoiceModelIntegrationTests`).
- **The VAD resolution is 256 ms.** FluidAudio's Silero model takes a fixed
  4096-sample block (plus 64 samples of context), so a smaller hop would need
  another model. `TurnPolicy` applies its own hysteresis to the raw
  probabilities, with the threshold for speech and the threshold minus 0.15
  for silence. It times silence from the start of the first silent block, so
  a pause is known at the end of that block, not one block later. As a
  result:
  - `pauseMs` below 256 has the effect of 256;
  - `bargeInSpeechMs: 300` needs two speech blocks, so 512 ms.
- **Barge-in compares against two clauses.** The partial's words are
  normalised (case, accents and apostrophes folded; letters and digits only).
  A word is foreign only if it is in neither the clause playing nor the one
  before it, because the EOU stream lags by about half a second and echo of
  the previous clause is still arriving when the next one starts. Nor is a
  word of the person's own turn being answered: the same lag delivers that
  turn's last words after the commit, and a breath while they arrive used to
  read as a barge-in and cancel the answer before it began. Words count
  from the start of the speech run, and up to `falseStartMs` after it, because
  the words of a short "stop" arrive after the VAD has seen it end.
- **False starts:**
  - when (a) holds without (b), playback is paused;
  - playback resumes `falseStartMs` after the speech began if the words never
    came;
  - this happens at most once per speech run;
  - while thinking there is nothing to pause, so only a full barge-in counts.
- **The committed turn is not a barge-in candidate.** Its last words often
  reach the EOU stream after the commit, and earlier they could have
  interrupted the answer they asked for. Only a new speech onset can barge in.
- **What is transcribed:**
  - the final pass gets the VAD bounds widened by 200 ms before and 300 ms
    after;
  - audio under 1 s is padded with silence (FluidAudio's minimum);
  - an empty result sends no `turn`, and the engine goes back to listening;
  - while the final pass runs, no timers run.
- **A cut turn.** A turn cut at `maxTurnMs` while the person is still speaking
  is committed. The speech that follows counts as a new run, so it can barge
  in on the answer to the cut turn.
- **Speaking:**
  - Phonon is the read-aloud instance (`PhononVoice.Runtime.beginVoice`), held
    for the whole conversation and warmed at start with one word.
  - The engine holds each 80 ms chunk until the next one arrives, so the last
    chunk of a clause is known. Each clause gets a 5 ms fade in and a 5 ms fade
    out. Clauses never overlap, so these are fades, not a crossfade.
  - Each chunk is scheduled at an explicit sample time on the player node's
    timeline: straight after the previous chunk, or 30 ms ahead of the render
    position after an underrun. The clause's sample ranges are therefore
    exact.
  - The played-sample clock is the player time at `lastRenderTime`, less the
    session's output latency and IO buffer, so `clauseStarted` and
    `interrupted.fraction` describe what was heard.
  - If an answer is interrupted while its clause is still being synthesised,
    `fraction` is measured against the samples generated so far.
- **The one-ahead rule.** A clause starts synthesising only when every clause
  before it has started playing and no other synthesis is running.
- **Graph rebuilds.** A configuration change rebuilds the graph, which empties
  the player. Clauses not fully heard are synthesised again from their start,
  and `clauseStarted` is not sent twice. If the input is gone the engine ends
  with `route`.
- **Why voice mode ends:**
  - `interruption`: calls, Siri, a media-services reset, and the app going to
    the background (voice mode is foreground only);
  - `route`: no input left;
  - `error`: a model failed while listening.
- **Session options.** `.voiceChat` with `.defaultToSpeaker` and
  `.allowBluetoothHFP`. `.bluetoothHighQualityRecording` is not set until it
  is tested with AirPods. Other audio is ducked at
  `AVAudioVoiceProcessingOtherAudioDuckingConfiguration` level `.min`, with
  advanced ducking off.
- **`voiceStatus.available`:**
  - also requires at least 5 GB of physical memory (a 6 GB iPhone), from the
    memory table above;
  - `fluid-mini` can be reported missing but cannot be downloaded (it ships in
    the app);
  - `downloadBytes` is about 405 MB when nothing is installed: VAD 1.1 MB,
    EOU 224 MB (the `320ms` folder only), Smart Turn 16.8 MB and Phonon
    163 MB.
- **Downloads.** Each model comes from its upstream repository at a pinned
  commit, and every file is checked against a SHA-256 recorded in
  `VoiceModels.swift`. The files are staged and moved into
  `Application Support/MikeVoice/models/<name>/`, which is excluded from
  backup. Each model is then loaded once so Core ML prepares it. Phonon uses
  its existing install.
- **Metrics stages (ms):**
  - `endOfSpeechToCommit`, on the audio clock;
  - `smartTurn`, the inference that decided;
  - `finalPass`;
  - `utterance`, the length of the VAD-bounded speech;
  - `firstClauseSynthesis`;
  - `commitToFirstAudio`, from `turn` to the first heard sample of the first
    clause, polled every 10 ms.

  They are sent once per turn: at first audio, or when the turn ends without
  any. `os_log` gets stage names and numbers only, never text or audio.
- **Call order.** The plugin runs the voice calls one after another, in the
  order the web app made them, so a clause cannot overtake an earlier one.
- **`voiceSpeak.final` is ignored.** The contract does not say what it means.
  The answer ends only with `voiceEndAnswer`. The contract should define
  `final` or drop it.
- **`voiceRemove()`.** Takes no arguments. It deletes the VAD, EOU and Smart
  Turn models, cancels an install in progress, and resolves the
  `voiceStatus` payload. Phonon keeps its own `remove`. Interrupted
  downloads leave `<name>.partial-<rev12>` staging folders; each install
  deletes the ones from other commits.
- **Rejection codes added:**
  - `busy`: returned by `voiceRemove`, by read-aloud `speak`, and by Phonon
    `remove` while voice mode runs. Read-aloud never re-voices or queues
    behind a conversation.
  - `cancelled`: `voiceStart` lost to a `voiceStop` sent after it. Stop
    takes effect at once, even while the start is waiting for models.
- **The audio graph.** Rebuilds bump an epoch. A clause synthesised for an
  older graph is dropped, not scheduled. While playback is held for a
  possible barge-in, the played position is cached, because the player has
  no clock while paused. A rebuild keeps the hold. Every hold is released
  when the turn commits or the answer ends. Audio-session notifications are
  handled on one serial queue, never under the rebuild lock. A failed
  rebuild ends voice mode only after 250 ms, so a concurrent interruption
  gives the reason. The background still ends with `interruption`; there is
  no separate `background` reason.
- **Limits.**
  - The microphone stream keeps the newest 200 buffers. Dropped audio is
    reported as the metrics stage `micDroppedMs`.
  - The transcript held outside a turn is capped at 200 words.
  - `maxTurnMs` is capped at 120 000. A larger value falls back to the
    default.

## Sources

Silero VAD licence: https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE ·
FluidAudio (VAD, EOU, LocalVQE): https://github.com/FluidInference/FluidAudio,
https://docs.fluidinference.com/asr/streaming, https://github.com/FluidInference/FluidAudio/pull/930 ·
Parakeet EOU: https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1 ·
Smart Turn: https://github.com/pipecat-ai/smart-turn, https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML ·
End-of-turn benchmark: https://github.com/livekit/eot-bench ·
Interruption prediction figures: https://krisp.ai/blog/voice-ai-turn-taking-interruption-prediction/ ·
Turn options and defaults: https://docs.livekit.io/reference/agents/turn-handling-options.md,
https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/ ·
Interruptions and context: https://docs.pipecat.ai/pipecat/fundamentals/interruptions ·
Voice prompting: https://developers.openai.com/api/docs/guides/voice-prompting ·
Latency budget: https://elevenlabs.io/blog/voice-agent-latency-optimization ·
Voice processing and ducking: https://developer.apple.com/videos/play/wwdc2023/10235, https://developer.apple.com/forums/thread/829753 ·
iOS 27 Neural Engine report: https://developer.apple.com/forums/thread/850110 ·
Prior art: https://github.com/fikrikarim/volocal, https://github.com/soniqo/speech-swift ·
EOU streaming problems: https://github.com/FluidInference/FluidAudio/issues/1007 ·
Nemotron streaming: https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b, https://github.com/soniqo/speech-swift/issues/503 ·
Fluid Speech Mini: https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-coreml ·
Kyutai Unmute (interruption and what was heard): https://github.com/kyutai-labs/unmute ·
Browser streaming STT: https://github.com/ysdede/parakeet.js, https://arxiv.org/abs/2602.12241 ·
Phonon player: https://github.com/gradium-ai/xn-ptts (ios/PhononTTS) ·
Android: https://developer.android.com/ndk/guides/neuralnetworks/migration-guide, https://developers.google.com/edge/litert/next/npu ·
Browser echo: https://lists.w3.org/Archives/Public/public-webrtc-logs/2019Apr/0334.html, https://bugs.webkit.org/show_bug.cgi?id=326286 ·
WebGPU devices: https://developer.chrome.com/blog/new-in-webgpu-140, https://github.com/gpuweb/gpuweb/wiki/implementation-status.

Figures from vendors and forums are marked as such above; none has been
measured on our devices yet.
