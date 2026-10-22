# Voice turn-taking: what the field does, and what to change

2026-10-22. A synthesis of six research reports, kept in
`voice-turn-taking-2026-10-22/` with their sources:

| Report | Topic |
|---|---|
| `00-brief.md` | The brief all six researchers worked from |
| `01-full-duplex-models.md` | End-to-end full-duplex models and benchmarks |
| `02-duplex-as-interface.md` | A duplex model as the interface onto a text LLM |
| `03-end-of-turn.md` | End-of-turn detection |
| `04-barge-in.md` | Barge-in, backchannels and echo |
| `05-speaker-separation.md` | Other voices: personal VAD, verification, addressee |
| `06-frameworks-practice.md` | LiveKit, Pipecat, Unmute and others, as built |

Most figures are vendor-run or come from single-author preprints; the reports
mark which. LiveKit's eot-bench is LiveKit's own harness (one row was
reproduced by a third party). openai.com refused the researchers' fetches,
so what is said about GPT-Live rests on press coverage and OpenAI's developer
forum.

The pipeline these reports compare against is the one in
`docs/voice-chat.md` as of commit 17696ea6. They raise three complaints
about it:

- Turns end too slowly. Before that commit they ended too soon.
- Interruptions fire on noise, TV and echo, or are missed.
- Other voices get through.

## The answer in short

1. **Full-duplex models are not the fix, for now.**
   - No open model runs on a phone. The open ones (NVIDIA VoiceChat 11B,
     PersonaPlex 7B, Moshi 7B, MiniCPM-o 4.5) need a 24 GB GPU or more.
   - They handle other voices badly, and they are poor at answering
     (VoiceBench: Moshi about 30 against about 70 for a plain cascade).
   - The frontier systems are closed: GPT-Live, Gemini Live, Seeduplex,
     Qwen3.5-Omni.
   - On turn-taking decisions, cascades hold their own. In the ICASSP 2026
     HumDial challenge the top four entries were cascaded or semi-cascaded.
     On Sesame's TurnBench, dedicated end-of-turn models beat Moshi and
     Gemini Live.

   What duplex models do that we can copy:
   - they decide continuously instead of after a silence;
   - they read words, prosody and silence together;
   - they know when they themselves are speaking;
   - they split a fast voice layer from a slow reasoner.
2. **Our architecture is the one the field is moving to: keep it.**
   - The 2026 designs (GPT-Live, NVIDIA's frontend/backend paper, Thinking
     Machines, Voice-Light) put a fast voice layer in front of a reasoner.
   - Most of them still let the voice model own its own context and decide
     when to delegate. Developers report it failing: in one report, 14 of 75
     GPT-Live cancel requests were never delegated.
   - GPT-Live paraphrases what the reasoner wrote. Paraphrase loses accuracy
     and numbers: MoshiRAG's spoken answers were about 5 points less accurate
     than the text they came from. That rules it out for citations.
   - So the text LLM stays the only author. The voice layer speaks its words
     verbatim and may add only a closed set of non-content sounds:
     acknowledgements, holding lines, backchannels.
3. **"Too fast" and "too slow" are two points on one curve.**
   - On eot-bench, Smart Turn v3.2 cuts people off at 35% of their mid-turn
     pauses with 300 ms of added wait, 15% at 600 ms, 10% at about 740 ms,
     and 5% at about 1,050 ms.
   - Moving thresholds only slides along that curve; we moved from one end
     to the other.
   - The way off the curve is **commit late, respond early**. Start the
     answer privately on a provisional end of turn, and release it only when
     the turn is committed (section 1).
4. **A barge-in cannot be both fast and right at its onset.**
   - TurnBench found interruptions and backchannels indistinguishable in
     their first moments. Systems that commit at onset either fire on about
     46% of backchannels or catch only about 11% of interruptions.
   - The fix is to react in two stages. Duck the answer at once (reversible),
     then stop or resume once words arrive (section 2).
   - On the iPhone, the main source of false barge-ins is echo that Apple's
     voice processing leaves behind: 200-500 ms of residue, and more at the
     start of a session.
5. **Checking whole turns against the person's voice cannot stop a TV from
   opening or holding a turn.**
   - That needs a voice detector that knows the person's voice and runs on
     every frame: a personal VAD (section 3).
   - None is available off the shelf for us; we would train one.
   - Verification on short audio has a hard floor: across 18 models, the
     equal error rate averages 31% at 0.5 s and 4.7% at 3 s. Deciding later
     helps more than a newer embedding model.

### Where we stand

Ahead of the open stacks:
- the exact heard text, from the played-sample clock, already used for the
  next turn (`spokenPrefix.ts`);
- rejection of voices that are not the enrolled person;
- everything running on the device;
- an accurate second ASR pass over the whole utterance (the open stacks
  commit their streaming transcript);
- an acknowledgement before tool work (c861b76c).

Behind them:
- speculation;
- a wait that adapts to the person;
- the VAD's 256 ms clock;
- barge-in reaction time and reversibility;
- per-stage metrics and a replay harness.

## What to change, in order

The values are starting points for the replay harness, not tested optima.

### 0. Measure first: a replay harness (days)

Every change so far has been judged by feel, which is how the policy swung
from one end to the other.

- **Log per 256 ms block:** VAD probability, the Smart Turn score (run every
  block even when the policy does not ask), `<EOU>` marks, partial words with
  times, each policy decision, and what the person did next. "Did next"
  means: went on within 3 s, barged in, typed, or corrected.
- **Keep audio** only for consenting testers.
- **Label pauses as eot-bench does.** The last pause before the answer is
  `eot`. Earlier pauses after which the same person went on are `hold`.
- **Replay causally:** the decision at time t may use only audio up to t.
  Sweep the thresholds, and plot false cut-offs per hold pause against the
  added delay (p50 and p90), per category. The categories: short answer;
  number, citation or ID; list; thinking pause; filler; breath at the end;
  TV; echo.
- **Size:** at least 800 pauses. The 200 turns planned in `voice-chat.md`
  give ±4 points on a 10% rate.
- **Public data:** seed and sanity-check with `livekit/eot-bench-data`
  (CC-BY-4.0) and the TurnBench dev split (non-commercial: evaluation only).
- **Barge-in suites:**
  - echo only: the assistant speaking alone, 3 rooms × 3 volumes × the
    speaker, receiver, headphone and Bluetooth routes;
  - TV at +5 and 0 dB;
  - about 10 speakers × 60 clips of interruptions, backchannels and
    ambiguous replies, played from a second speaker for true double-talk.

Proposed acceptance bars:

| Area | Bar |
|---|---|
| End of turn | At most 5% false cut-offs per hold pause; added delay p50 under about 600 ms, p90 under 1.2 s |
| Barge-in | At most 1 false barge-in per hour with the assistant speaking alone; audible duck within 250 ms |
| Backchannels and interruptions | At most 6% of backchannels treated as interruptions; at most 5% of real interruptions missed |

### 1. End of turn

1. **Fix the VAD clock (cheap, do first).**
   - FluidAudio's streaming VAD works in 256 ms blocks and reports
     `speechEnd` one block late. So `pauseMs` 500 means 512-768 ms of real
     silence before Smart Turn is first asked.
   - Time the silence from the last voiced frame, or from Parakeet's word
     end times, rather than from the reported end.
   - Or run Silero on its native 32 ms windows. Check whether the 256 ms is
     a FluidAudio wrapper setting rather than a limit of the model.
   - Log "last word to commit" separately from "VAD end to commit": a
     breath that VAD calls speech resets the timer.
2. **Split a provisional end from the commit, and speculate in between.**
   - **Provisional:** one block of silence and Smart Turn at 0.35 or more,
     or `<EOU>` and 0.25 or more.
   - **At the provisional end:** run Fluid Speech Mini on the utterance so
     far and start the answer privately.
   - **Nothing becomes audible, durable or side-effecting before the
     commit.** Read-only retrieval is fine; a writing tool call withdraws the
     draft.
   - **At the commit:** promote the draft if the final text matches,
     ignoring case and punctuation; otherwise start again. At most two
     drafts per turn.
   - **The arithmetic.** The delay becomes max(commit wait, provisional wait
     + L), where L is the time to the first speakable audio. For an agent
     with retrieval and a strong model, L is long, so a conservative commit
     costs almost nothing.
   - **Costs and gains:** Deepgram reports 50-70% more LLM calls for
     150-250 ms earlier answers. Endpoint Anticipation reports 505 ms saved
     at 28% wasted compute.
   - **Two ways to build the private draft**, the main engineering question:
     - (a) Send the turn at the provisional end, but hold its audio until the
       commit. A continuation then uses the existing Continue branch. This is
       cheap, but every false provisional end leaves a branch in the thread.
     - (b) A real private draft: a chat-turn mode that runs the model and
       retrieval without writing to the thread, and is promoted at the
       commit. This is cleaner, and needs backend work on the Pi turn.
     - A cheaper middle step: speculate only the idempotent prefix (prompt
       cache warm-up, query rewrite, retrieval).
3. **Replace "0.6 at 500 ms, then every 750 ms" with a threshold that falls
   as the silence grows, checked on every block.** Smart Turn costs 3.5 ms.
   - Commit at 0.85 or more from 400 ms of silence, 0.7 from 600 ms, 0.55
     from 900 ms, 0.4 from 1.3 s and 0.25 from 2 s. Keep the 3 s hard limit.
   - For comparison, Pipecat asks Smart Turn once at 200 ms with 0.5.
     LiveKit commits at 0.3 s when its model is confident and waits up to
     2.5 s when it is not.
   - Smart Turn's "incomplete" verdict is weak evidence: 52-59% precision
     in production, against 95-96% for "complete".
4. **Add word and context rules.**
   - The assistant just asked a yes/no question and the reply is a short
     closed answer ("yes", "no", "go ahead"): commit at 300-400 ms.
   - The transcript ends in a conjunction, a preposition or a filler: need
     1.5-2.5 times the silence.
   - Digits, spelled letters, citations or dates, or the assistant asked for
     an identifier or a list: wait at least 1.2 s whatever the score. In
     eot-bench's English set, 126 of 705 pauses fell inside numbers, letters
     or emails, and legal dictation is likely worse.
5. **Learn each person's pause from Continue events.**
   - Every Continue is a measured false end of turn. Keep an exponential
     moving average of those pauses (α about 0.9) as the person's silence
     floor, clamped to 400 ms–1.2 s. This is LiveKit's dynamic endpointing.
   - Persist a slower profile for people who pause a lot.
6. **Later:**
   - Fine-tune Smart Turn on our hard cases: breath-ended pauses, fillers,
     digit strings, audio after echo cancellation. Its training code is open.
   - Benchmark p99lab turn-1-mini (5.3M parameters, Apache-2.0, ONNX,
     October 2026, unproven) against it and stack the two.
   - LiveKit's turn detectors are far better on eot-bench, but their licence
     allows use only inside LiveKit Agents.
   - Deepgram Flux, AssemblyAI and the others are cloud services, so they
     fall outside the privacy remit.

**Don't:**
- cut the pause to 200-300 ms without speculation (that was the original
  cut-off failure);
- trust `<EOU>` alone (third parties measured it at 0.6-1.4 s after
  speech, and it loses words);
- speak a filler on a provisional end, which would make false ends audible.

### 2. Barge-in

1. **Duck first, decide later.**
   - **Candidate:** VAD at 0.6-0.7 for two hops, the echo gate passes (item
     3), and the speaker check vetoes only when it is confident.
   - **On a candidate:** lower the answer by 15 dB over about 80 ms, within
     100-250 ms of onset. Keep the stream and the model running. Ducking also
     lowers the echo at the microphone by about the same amount, just when
     the decision is being made.
   - **Stop** (ramp down over 40 ms, cancel, cut the heard text at the
     played sample) on any of: a stop word; two content words that do not
     match what was played; 1.2 s of speech that passes the speaker check
     and does not echo.
   - **Resume** (un-duck over 250 ms) on any of: only backchannel words,
     then 700 ms with nothing more; no words within 1.5 s; an echo match;
     the speaker check rejects the voice.
   - **At 3 s of ducking:** stop if there was speech in the last 300 ms,
     otherwise resume.
   - This replaces today's "hold after 700 ms of speech". The person hears a
     reaction in about 0.2 s instead of about 1 s, and an echo or a cough
     costs nothing.
2. **One word for "stop".**
   - These stop playback on their first clean partial: stop, wait, hold on,
     hang on, no, nope, pause, sorry, actually, cancel, never mind.
   - Backchannels (mm-hm, uh-huh, yeah, right, okay) resume unless more
     words follow.
   - "Yeah, but…" stops at the first word after the backchannel.
   - Treat a short reply as a turn in three cases: the clause just played
     ended in a question; it was the final clause; or the audio ended less
     than 1 s ago.
   - Keep the lists as per-language data files, English first.
3. **Harden against echo.**
   - **(a) Widen the text gate.** Compare partials with everything played in
     the last 6-8 s plus the clause prepared next, not only the current
     clause. Use fuzzy matching of words in order: an echo is 60% or more of
     the words matching, in runs of two.
   - **(b) Add a relative level gate.** We know what was played, so predict
     the echo level at the microphone, calibrated per route and volume.
     Require speech at least 6 dB above it. One iPhone measurement had echo
     at −33 dB and real interruptions at −23 to −29 dB, so fixed levels are
     brittle.
   - **(c) Raise the thresholds when echo cancellation is still settling:**
     the first 3 s of a session, and 500-800 ms after a route change.
   - **(d) Treat Phonon's voice as a known impostor** in the speaker check.
   - **(e) Experiment with FluidAudio's LocalVQE** (Core ML, beta,
     Apache-2.0) after Apple's processing, on the barge-in path only. Keep it
     only if it cuts false barge-ins on the echo suite at least threefold.
4. **Later:** a small fusion classifier (3-10M parameters, under 10 ms, Core
   ML and ONNX).
   - Inputs: audio, VAD, the speaker score's trend, level against the
     predicted echo, correlation with the played audio, and partial words
     against the played text.
   - Outputs: interrupt, backchannel, other voice or noise, echo.
   - No published classifier uses the reference audio or the assistant's
     text, and that is where we can do better.
   - Krisp's model is a licensed SDK with no confirmed iOS build. LiveKit's
     adaptive interruption runs only in their cloud.

### 3. Other voices

1. **Decide later on longer turns (days, no new model).** Score
   sequentially as the turn goes on, and calibrate by duration. Feed a soft
   "is it the person" score to the turn and barge-in policies instead of
   dropping turns at 1 s. Expected effect: misses on turns over 1.5 s fall
   from about 10% towards 5-6%.
2. **When unsure, keep the words rather than lose them.** Put an uncertain
   turn in the composer as a draft rather than discarding it. Answering the
   TV is annoying; dropping the person is worse.
3. **Train a personal VAD (3-6 weeks, probably after launch).**
   - It labels every frame as silence, the person, or other speech,
     conditioned on our fused voice embedding. pVAD 2.0 with the 2026
     Foreground VAD recipe; 0.2-1.1M parameters, under 2 MB.
   - Train it on TV-like audio: broadcast and drama with music, loudspeaker
     EQ, room responses, and the person 6 dB quieter to 12 dB louder than
     the TV.
   - The turn manager then opens turns and runs its timers only on the
     person's frames, which stops a TV from holding a turn open.
   - Published figures are promising (background false alarms 0.05-0.40
     against Silero's 0.8 or more), but nobody has tested a TV at 0 dB.
4. **Benchmark newer voice models** (ReDimNet2, MIT; ERes2NetV2) against
   WeSpeaker and CAM++ on our 0.5, 1 and 2 s trials. Expect modest gains.
5. **Not now:**
   - target-speaker extraction: the best online systems score TER about 0.7
     on real conversations (REAL-TSE 2026);
   - streaming diarization: it labels speakers by order of arrival, not
     identity;
   - Krisp and ai-coustics: server-side or phoning home; use them only as
     offline references in the harness;
   - Apple Voice Isolation: apps cannot switch it on; we already point
     people to the system mic-mode picker.
   - **Correction to `voice-chat.md`:** Pipecat's "Audience" is a 33M text
     classifier for addressees in game dialogue, not a side-talk or TV
     detector. Drop it from the "later" list. The slot it was meant to fill
     is a directedness check at commit. Either let the model decline a turn
     that wasn't addressed to it, or add a small classifier trained on our
     logs.

### 4. The conversation layer

1. **Tag each turn with how it came in.** Modality (voice, typed or
   pasted), any merged turns, whether the speaker was verified, and what
   happened in a barge-in. Add a standing instruction: voice turns are
   machine transcriptions and may garble names, citations, statute numbers
   and amounts, so confirm before relying on one that would change the
   legal meaning. Input and output modality are separate. A typed turn goes
   straight to the thread and ducks or stops speech.
2. **The heard prefix:** we already keep it. Check that the model-facing
   copy drops the unheard remainder and carries an interruption marker. The
   PACE preprint reports 25% → 96% accuracy on "the second one" and "where
   did you stop" questions with exactly this. The UI keeps the full answer.
3. **Gaps while the agent works:** we already acknowledge before tool work.
   Add a watchdog so that silence after a holding line cannot run on.
   Developers report 55-58 s of silence after GPT-Live's holding line. Speak
   progress only when something changes, and never imply success before the
   event that shows it.
4. **Idle:** a user-idle prompt 7-15 s after the answer ends (LiveKit uses
   15 s, Unmute 7 s).

### 5. With GPUs, later

- **Shadow end-of-turn votes.** Run SoulX-Duplug, and later a duplex model
  (VoiceChat 11B, PersonaPlex), on recorded sessions. Read only their "would
  speak now" signal as an extra vote, logged beside ours. These models
  over-trigger at pauses, so they never decide.
- **A server loop for web and Android.** Kyutai STT 1B (with its semantic
  VAD) or Voxtral Realtime, plus Smart Turn, behind the same provisional and
  commit interface. Detection and reaction stay on the device for the
  iPhone.
- **NVIDIA's frontend/backend recipe.** It trains the duplex front end to
  repeat the backend's text verbatim, which is the closest match to our
  design. No released checkpoint was confirmed.

## GPT-Live

Nothing above needs it. To hear the ceiling, the ChatGPT app's voice mode is
GPT-Live (consumer launch 2026-07-08), so a listening comparison needs no
setup. Credentials on node-a would matter only to run it through the API
(2026-09-10) on our recorded test sessions, as a reference row in the
harness. That is lab use only, never production.
