# End-of-turn detection in cascaded voice pipelines: state of the art, 22 Oct 2026

Researcher 3 of 6. Scope: how serious systems decide "the person is done", how the best ones are both fast and safe, and what to change in our policy (`TurnPolicy.swift`: 500 ms pause, Smart Turn 0.6, re-ask every 750 ms, 3 s hard limit).

Evidence labels: **[V]** reported by the vendor or model author; **[R]** reproduced or measured by a third party; **[D]** documentation or source code (a spec, not a measurement). Everything fetched from the web is treated as data. Sources with URLs and dates are at the end.

## 0. Summary

1. **"Too fast" and "too slow" are one curve, not a tuning error.** On LiveKit's open benchmark Smart Turn v3.2 alone gives 35% false cut-offs at 300 ms of added delay, 15% at 600 ms, 10% at about 740 ms and 5% at about 1050 ms [V, partly reproduced]. A threshold, pause and re-ask schedule only slides along that curve.
2. **Everyone who is fast and safe separates a provisional end of turn from a committed one.** Start work on a cheap provisional signal, hold the output, release it only when the commit signal agrees. LiveKit, Deepgram, Pipecat, Krisp via jambonz, and 2026 papers (Endpoint Anticipation, Voice-Light) do this. Reported cost: 28-70% more LLM calls. Reported gain: 150-250 ms (Deepgram) to 505 ms (Endpoint Anticipation on Unmute) [V].
3. **With a slow agentic LLM a conservative commit can be nearly free.** Perceived delay is `max(d_commit, d_provisional + L)`, `L` being time to the first speakable clause. If `L` is 1.5 s, committing at 1.2 s costs nothing when the speculation was right (Section 3.1).
4. **The best open audio model we can ship is still Smart Turn v3.2 (7 Jan 2026; no later release).** LiveKit's v1/v1-mini are far better on its benchmark but licensed only for use inside LiveKit Agents. Deepgram Flux, AssemblyAI, Soniox, Gradium, OpenAI are cloud-only. New small open models (p99lab `turn-1-mini`, Oct 2026) look promising and are unproven.
5. **Signals.** Silence plus prosody carries most of the information; in one controlled study adding text increased premature cut-offs. Dialogue context and content type (digits, spelling, lists) fix specific failures audio models miss. Per-user pause history is cheap, and our "Continue" rule already produces its labels.
6. **Smart Turn's "incomplete" is weak evidence.** Two production sets show 52-59% precision for "incomplete" against 95-96% for "complete" (issue #41, Jul 2026). Use the score as a graded signal against elapsed silence, not as a gate.

## 1. Why the policy oscillates: the operating curve

LiveKit's eot-bench (open harness and data, Jun 2026) scores every pause inside a user turn: the last is `eot`, earlier pauses of 100 ms or more are `hold`. Models are scored causally, then a sweep over `threshold`, `action_delay` (minimum silence) and `timeout` (maximum silence) finds the best trade-off. English, lower is better:

| Model | False cut-offs @300 ms | @600 ms | Delay @5% cut-offs | @10% | Runs |
|---|---|---|---|---|---|
| LiveKit Turn Detector v1 | 9.9% | 4.5% | 543 ms | 295 ms | LiveKit cloud |
| JoinIn AI Baton | 12.3% | 4.8% | 577 ms | 350 ms | closed, hosted |
| Deepgram Flux | 12.9% | 9.9% | 1151 ms | 548 ms | cloud |
| ultraVAD (Llama-8B) | 27.7% | 11.9% | 899 ms | 663 ms | GPU server |
| LiveKit v1-mini | 27.8% | 12.1% | 1070 ms | 698 ms | CPU, LiveKit licence |
| **Smart Turn v3.2** | **35.2%** | **14.8%** | **1051 ms** | **739 ms** | on-device |
| VAP (silent agent) | 46.9% | 14.6% | 1131 ms | 749 ms | research code |
| AssemblyAI | 49.4% | 14.6% | 1049 ms | 713 ms | cloud |
| VAD (silence only) | 55.6% | 21.7% | 1600 ms | 1000 ms | - |
| p99lab turn-1-mini (n=400, author-run) | 22.6% | 9.6% | 849 ms | 581 ms | CPU, ONNX |

All [V] (LiveKit ran them; turn-1-mini's intervals overlap v1-mini's). A third-party pull request reproduced Smart Turn's 35.2% exactly [R]. "Delay" is the dead air after the true end including the policy wait, not compute time. The English set is 400 turns with 705 pauses.

Reading it for us:
- Smart Turn's frontier: 10% false cut-offs costs about 740 ms of added delay, 5% costs about 1050 ms. Our budget is under 800 ms median from end of speech to first sound, and the LLM has not started in those figures. The wait alone uses the whole budget.
- With `k` pauses per turn and a per-pause rate `f`, `1-(1-f)^k` of turns are cut at least once: 27% at 10% and three pauses.
- A better detector moves the curve (LiveKit v1 is far below Smart Turn), but we cannot license it (Section 6).
- Mid-turn pauses are not short. In the same data 126 pauses were inside numbers, letters or emails and 68 were longer than 1 s; turn-1-mini at 300 ms cut 27 of the former and 40 of the latter. Legal dictation (citations, clause numbers, thinking aloud) is likely worse.
- Humans leave about 200 ms between turns (Stivers et al. 2009, secondary source) and pause within their own turns for longer, so they predict ends rather than detect silence. Section 3 imitates that.
- Sesame's TurnBench (Aug 2026; 30 h studio dialogue, recall under an FPR cap of 0.15) agrees: Smart Turn v3 recall 0.752 at FPR 0.047, 1017 ms median; OpenAI server VAD recall 0.955 but FPR 0.525; OpenAI semantic VAD recall 0.303 at FPR 0.018; Kyutai semantic VAD 0.773 / 0.059 / 1007 ms; VAP 0.845 / 0.055 / 368 ms. Many rows are self-submitted.

## 2. The detectors and what each uses

**Pipecat Smart Turn.** Whisper-Tiny encoder plus linear head, about 8M parameters, audio only; input is the last 8 s of the turn (zero-padded at the front); output P(complete).
- Versions: v3 (11 Sep 2025); v3.1 (3 Dec 2025, more human audio, better quantization); v3.2 (7 Jan 2026, short-utterance data, cafe/office noise, a training padding bug fixed; "40% fewer short-utterance errors" [V] with no baseline). I found nothing newer: the Hugging Face org's last Smart Turn update is 7 Jan 2026 and a GitHub PR of 22 Oct 2026 still points at v3.2.
- Data: `smart-turn-data-v3.2-*` (about 270k train and 31.5k test examples per the v3.1 card); partners Liva AI, Midcentury, MundoAI. About 78% of the test set is synthetic and none is telephony (third-party reading).
- Reported [V]: 92.6% accuracy (CPU build), 4.7% false "complete", 2.6% false "incomplete" over 31.5k samples; English 94.3%; only 90 human-conversation samples (8.9% false complete). Weak languages: Vietnamese 81%, Bengali 84%, Marathi 88%, Chinese and Arabic 89%.
- Failure cases: "incomplete" precision 52-59% (issue #41); one report of the score for the same speech rising from about 0.4 at 800 ms of trailing silence to 0.89 at 1.3 s, which the maintainer says should not happen (issue #32, open); on simulated 8 kHz phone audio false "complete" rose from 9.9% to 18.1% (Hindi 15.1% to 28.6%), mostly fixed by an augmented fine-tune (issue #42); weak on very short clips; no number-entry mode; no dialogue context.
- Pipecat's own use [D]: VAD `stop_secs` 0.2 s, Smart Turn run on each VAD stop, "complete" at P > 0.5, and if "incomplete" the turn ends at 3.0 s of silence; turn-stop timeout 5 s. We start at 500 ms, use 0.6, and re-ask every 750 ms.

**LiveKit.** The text model (Qwen2.5-0.5B on the STT transcript, 396 MB) is deprecated, removal planned for Agents 2.0. **Audio v1** (17 Jun 2026): an audio encoder feeds an adapter into a fine-tuned LLM (semantic branch), a second encoder with a recurrent layer captures timing and prosody, a fusion head combines them; it sees only the current turn. **v1-mini** is the same design, quantized and pruned, on CPU. No training data or limitations are published; v1-mini is near chance on Romanian (AUC 0.565, issue #14), so unlisted languages are a risk.

**Deepgram Flux** (1 Oct 2025). One STT model emits `StartOfTurn`, `EndOfTurn` and, if `eager_eot_threshold` is set, `EagerEndOfTurn` and `TurnResumed` [D]. `eot_threshold` 0.5-1.0 (default 0.7), eager 0.3-0.9, `eot_timeout_ms` 500-60,000 (default 5000). Own claims [V]: about 30% fewer false interruptions, EndOfTurn p50 about 260 ms, p95 about 1.5 s. Cloud only.

**AssemblyAI.** Universal-Streaming: confidence threshold 0.4 plus `min_turn_silence` 400 ms, acoustic fallback at `max_turn_silence` 1280 ms. Universal-3.6 Pro Streaming decides from transcript punctuation with presets [D]. Cloud only.

**Speechmatics.** Silero VAD, then a silence countdown multiplied by cues [D]: very slow pace about 3.0x, slow about 2.0x, trailing "um/uh" about 2.5x, no sentence end 1.5x or more, Smart Turn "complete" about 0.1x, "incomplete" about 1.7x. Presets 0.25-1.0 s.

**Krisp turn-taking** (`krisp-viva-tp-v3`): audio only, per 20 ms frame, meant for Voice-Isolated audio; licensed SDK, no public numbers, no stated iOS build. **TEN Turn Detection:** Qwen2.5-7B text, English/Chinese, needs an ASR transcript, too large.

**Parakeet realtime EOU 120M (ours).** RNNT with an `<EOU>` token. Model card: EOU latency p50/p90/p95 = 160/280/320 ms on TTS speech with 3 s trailing silence [V]; no precision or recall. A Dec 2025 thread shows inconsistent marks when audio is fed as ad hoc chunks. A Sep 2026 paper on another base model (Qwen3-ASR-0.6B LoRA) argues the usual EOU-token precision/recall trade-off is an artefact of "clairvoyant" labels using future audio; with causal labels it gets 0.97 boundary recall at 0.39 s median and 0.3 false fires per speech-minute [V]. Our EOU weakness may be partly training, not fundamental.

**Kyutai semantic VAD / Unmute** (May 2025). The 1B STT has heads giving the probability of no voice activity at future horizons per 20 ms frame. Unmute smooths `prs[2]`, ends the turn above **0.6**, interrupts the bot below **0.4**, and uses a VAD cooldown of 3 s [D, code]. **Flush trick:** the STT has a 500 ms delay, so on a pause the client has the server process buffered audio at about 4x real time, leaving about 125 ms of wait. Rust server, GPU only.

**OpenAI Realtime.** `server_vad`: threshold 0.5, `silence_duration_ms` 500, `prefix_padding_ms` 300. `semantic_vad`: a classifier on the words; `eagerness` low/medium/high/auto sets a maximum wait, no numbers documented.

**VAP (Voice Activity Projection).** Self-supervised prediction of future speech activity from both speakers' audio (CPC encoder, small transformer, 100 Hz). Ekstedt and Skantze (SIGDIAL 2022) show it uses intonation. It needs both channels, and we know our own TTS channel exactly. Mediocre on user-to-agent data (table above), top non-submitted entry on TurnBench.

**Newer (2025-2026), mostly small shops or papers:**
- *turn-1-mini* (Oct 2026): 5.3M parameters, audio only, log-mel limited to 4 kHz, 20 ms frames, Apache-2.0, 7 MB int8 ONNX, 1.3 ms per 160 ms step on one M4 Pro core; English only; no Core ML; scores uncalibrated [V].
- *VoxTurn* (Oct 2026): Qwen3-ASR-0.6B plus LoRA (0.8B), answers end of turn, resume within 0.5 s, dialogue state, interruption vs backchannel and invalid input in one pass, 8.3 ms on an L40S; 11.5% @300 ms English; in a Pipecat replay cut-offs fell from 45.3% to 16.7% [V].
- *Pype Cue v1* (12 Oct 2026): a Gemma-4-E4B text model reading the agent's question and what the caller already gave, labelling pauses DONE / LIKELY_DONE / MID_THOUGHT / HOLDING, fused with Smart Turn scores: 7.5% at 600 ms vs 14.8% for Smart Turn alone, 719 ms at the 5% budget [V]; GPU served, Apache-2.0.
- *ultraVAD* (Sep 2025): audio plus dialogue history; 77.5% vs 63.0% for Smart Turn v2 on a context-dependent set [V].
- *Voxtral TurnHead*: 2.4M head on a frozen 4B recogniser; alone it catches 38.7% of casual trailing-off endings, so needs a 1 s fallback [V].
- Research: Easy Turn (4 states), FastTurn, XTurnix, X2-Turn, Next-Turn (predicts time to next speech onset; +25.9 points accuracy within 320 ms [V]), Namo and TurnSense (small text models).

## 3. Fast and safe: commit late, respond early

### 3.1 The arithmetic

Let `d_p` be the silence at which a provisional end fires, `d_c` the silence at which commit fires, `L` the time from provisional start to the first speakable audio.
- Sequential delay = `d_c + L`. Speculative delay = `max(d_c, d_p + L)`. Saving = `min(L, d_c - d_p)`.
- Example: `d_p` 300, `d_c` 1000, `L` 900 gives 1200 ms instead of 1900 ms. For any `L` of at least `d_c - d_p`, raising `d_c` up to `d_p + L` is free. Our agent (retrieval, tools, strong model) has a longer `L` than the chatty models vendors benchmark, so the safe side of the curve is cheap. The price is wasted work when the person resumes.

### 3.2 How each system does it

| System | Provisional trigger | Held until commit | If the person resumes | Cost and limits |
|---|---|---|---|---|
| LiveKit `preemptive_generation` (default on) | final STT transcript | LLM early; TTS only if `preemptive_tts` (default off) | cancel and replace if transcript or context changed | max 3 retries per turn; skipped above 10 s of speech; docs warn it is not always faster [D] |
| Deepgram Flux eager | `EagerEndOfTurn` at 0.3-0.5 | LLM draft | `TurnResumed` cancels; final transcript is guaranteed equal to the eager one | +50-70% LLM calls, 150-250 ms earlier [V] |
| Pipecat `EagerUserTurnStopStrategy` | the STT service's predicted end | response hidden from user and context; draft PR #6151 adds a TTS gate that pre-synthesizes and holds audio | withdrawn on resumed speech, mismatched text (`NormalizedMatch` ignores case and punctuation), a tool call, or 5 s timeout; one speculation per turn | wasted TTS is billed [D] |
| Krisp via jambonz | `earlyGeneration: true` | LLM prompt | undocumented | - |
| Voice-Light (Sep 2026) | 160 ms of low speech probability | text and PCM private under generation ids; promoted after final ASR and transcript checks; case, punctuation or whitespace changes keep the work, lexical changes kill it | if already audible: duck to -15 dB over 450 ms, pause by 500 ms, resumable up to 800 ms | 9 of 13 traced turns promoted speculation: 667 ms median vs 1,513 ms, observational [V] |
| Endpoint Anticipation (Jun 2026) | 25M model predicts the end up to 960 ms ahead (Unmute run) | about 10 LLM tokens rendered to a TTS cache that is never played | cache dropped | 1195 to 690 ms (-505 ms), 28.4% redundant computation [V] |
| RelayS2S (Mar 2026) | turn detected | fast path drafts a prefix, a verifier commits or falls back | falls back to the cascade | -479 ms first-chunk latency, 99% of text quality [V] |

Shared rules: (1) nothing speculative becomes audible, durable or side-effecting before commit (Pipecat withdraws on any tool call); (2) promotion needs a normalized text match, else restart from the full new transcript; (3) bound the waste: 1-3 speculations per turn, skip very long utterances, time out stale ones; (4) the played-sample clock is the truth of what was heard (we already do this).

### 3.3 When a provisional answer is already being spoken

Nobody ships audible speculation on purpose, so this only follows a **false commit**.
- Pause, don't kill: LiveKit pauses on VAD speech and, with `resume_false_interruption` (default true), resumes from the same place if no transcript appears within `false_interruption_timeout` (2 s). Voice-Light ducks, pauses, and resumes the same generation for backchannels; it discards only when a floor-taking probability exceeds 0.82 or speech lasts 900 ms. Our `holdSpeechMs` 700 / `falseStartMs` 1500 rule is the same idea.
- Same-speaker continuation is not an interruption: LiveKit's dynamic endpointing counts "user resumes right after the agent starts" as a false end of turn and raises the pause floor (Section 4). Our Continue rule (3 s, re-transcribe both stretches as one) is the right mechanism; it lacks the learning and a quick, quiet cancel.
- A spoken filler or "bridge" masks latency (a Jul 2026 field study with a Japanese robot found fixed fillers and context-aware prefaces both cut first-response latency), but it makes false commits audible. I would not do it for a legal assistant.

### 3.4 Let the LLM judge completeness

Pipecat's *Filter Incomplete User Turns* has the LLM start every reply with ● (complete), ◐ (incomplete, re-prompt after 5 s) or ○ (incomplete, wait 10 s); the marker is stripped and the bot stays silent on ◐/○. Added to a speculative call it is a context-aware vote at no extra latency or model. Costs: a voice-only protocol in the prompt (the shared thread must not depend on it) and a model that follows it. A separate small judge on our server avoids touching the main prompt.

## 4. Combining signals, adaptive timeouts, what matters most

- **Acoustic plus prosody wins in the one controlled study I found.** "Less can be More" (Sep 2026; 33 h of 8 kHz human calls, 261K-parameter fusion head over frozen encoders): acoustic+prosodic F1 0.930, 7.8% false alarms, 400 ms median; adding text raised false alarms to 10.7-14.6%; text alone F1 0.29. Pitch fall and silence duration drove the gain. Caveats: one English telephony domain, 13.8% WER, MiniLM text features.
- **Text and context help specific cases.** LiveKit v1 argues only the acoustic branch separates "one large pizza..." finished from unfinished. Cue adds the agent's question; ultraVAD gains most on context-dependent turns; Gradium reports digit strings no longer cut off (qualitative). Reconciliation: audio carries completion cues, context says what should come next.
- **Lexical cues are cheap.** Speechmatics multipliers, Vapi rules (0.1 s after punctuation, 0.5 s after a number, 1.5 s with no punctuation, floor 0.4 s) and AssemblyAI U3 Pro's punctuation approach reduce to the same idea.
- **Weak learned detectors can lose to a timer.** Voice-Light's learned adapter reached 12.5% recall at 2.7% false cut-offs; a 640 ms Silero timer got 95.6% at 2.7% on the same 37 hold cases; Smart Turn at threshold 0.95 got 20.7% recall at 13.5% (possible training overlap). Small sets with few long pauses flatter timers.
- **Combiner inputs available on-device now:** Smart Turn P against silence; `<EOU>` flag; silence from the last voiced word; last words of the partial (conjunction, preposition, filler, hanging number); speech rate over 2 s; utterance length; expected answer type from the assistant's last message (yes/no, number, name, list, open); session pause history.
- **Adaptive timeouts.** *LiveKit dynamic endpointing* (Python): the minimum delay is an EMA (`alpha` 0.9) of intra-user pauses, learned only from (a) the user resuming with no agent turn between and (b) the user interrupting within the min delay of the agent starting; clamped to [`min_delay`, `max_delay`], rising only above the configured floor [D, source read 22 Oct 2026]. *Speechmatics ADAPTIVE:* base countdown times multipliers. Deepgram and AssemblyAI give presets only (Flux "high reliability" 0.85 / 8 s; AssemblyAI "conservative" 0.7 / 800 ms / 3600 ms, aimed at healthcare, sales, legal). I found no published measurement of pause differences for older or non-native speakers.

## 5. Tuning numbers in real deployments

| System | Settings (defaults unless stated) |
|---|---|
| LiveKit text/VAD | `min_delay` 0.5 s, `max_delay` 3.0 s, fixed; Silero `min_silence` 0.55 s; interruption `min_duration` 0.5 s; `false_interruption_timeout` 2 s |
| LiveKit audio v1 | `min_delay` 0.3 s, `max_delay` 2.5 s; per-language `unlikely_threshold`; commits if no prediction within about 1 s |
| LiveKit STT mode | `min_delay` stacks on the provider's endpointing (AssemblyAI advises 0) |
| Pipecat | VAD `stop_secs` 0.2; Smart Turn P > 0.5; fallback 3.0 s; no-model `user_speech_timeout` 0.6 (0.8 s minimum wait); turn stop timeout 5 s |
| Deepgram Flux | `eot_threshold` 0.7; low-latency preset eager 0.4 / eot 0.7 / 6000 ms; complex-pipeline 0.4 / 0.85 / 7000 ms |
| AssemblyAI | aggressive 0.4 / 160 / 400 ms; balanced 0.4 / 400 / 1280; conservative 0.7 / 800 / 3600; U3 Pro 100 ms check, 1000 ms forced |
| Speechmatics | fast 0.25 s, fixed 0.5, adaptive 0.7, smart_turn 0.8, scribe 1.0 |
| Vapi / Ultravox | `waitSeconds` 0.4, punctuation 0.1, number 0.5, none 1.5 / `turnEndpointDelay` 0.384 s |
| Gradium | horizon 2 at 0.5 (snappy 0.3; thinking pauses horizon 3 at 0.5; noisy phone 0.6 for 3 steps) |
| Kyutai Unmute | end at EMA > 0.6, interrupt below 0.4 |
| Voice-Light | min delay 560-640 ms, timeout 800 ms, speculative open at 160 ms |

**How quality is measured.** eot-bench: false cut-offs at fixed latency budgets and latency at fixed false-cutoff rates, per hold pause, Pareto frontier over `threshold`/`action_delay`/`timeout`. TurnBench: recall within a -0.25 to +3 s window under an FPR cap of 0.15, signed latency at p10/p50/p90, one frozen operating point tuned on dev. Endpoint Anticipation: realized anticipation, premature rate, expected redundant computation. Qwen3-ASR turn paper: false fires per speech-minute. Flux: eager-then-resumed vs eager-then-end ratio. Voice-Light: final VAD endpoint to first audio (758 ms median, 36 turns). Evalgent suggests 3% (clean) and 5% (noisy) premature-cutoff pass marks; one vendor's opinion.

## 6. On-device feasibility

| Candidate | Size / runtime | Licence | iPhone? | Verdict |
|---|---|---|---|---|
| Smart Turn v3.2 | 8 MB ONNX; Core ML about 17 MB; 3.5 ms (ours) | BSD-2-Clause | yes (running) | keep; fine-tune |
| turn-1-mini | 5.3M; 7 MB int8 ONNX; 1.3 ms/step on an M4 core | Apache-2.0 | ONNX Runtime CPU; no Core ML yet; untested on iPhone | evaluate, stack |
| Parakeet EOU 120M | Core ML, about 224 MB (320 ms build) | NVIDIA Open Model | yes (running) | feature, not authority |
| LiveKit v1-mini, v1, text | CPU / hosted / 396 MB | LiveKit Model License: "can only use them together with the LiveKit Agents framework"; no standalone use; no training other models | no | not permitted |
| Flux, AssemblyAI, Soniox, Gradium, Cartesia, OpenAI | cloud | commercial | no | breaks privacy remit; references only |
| Krisp TT | SDK on servers | licence + API key | undocumented | ask for iOS build only if open options fail |
| Kyutai STT-1B semantic VAD | 1B, Rust server | check card | no (GPU) | server option |
| Voxtral TurnHead | 2.4M head + frozen 4B | Apache-2.0 | no | server option |
| VoxTurn | 0.8B, 1.9 GB GPU | model licence unclear (paper CC BY-NC-SA) | no | server, licence check |
| Cue v1 / ultraVAD | 4B-8B LLM | Apache-2.0 / check | no | our-GPU dialogue context |
| Namo, TurnSense | 135-300 MB text | Apache-2.0 | feasible, text only | low priority |
| VAP | small transformer + CPC | unverified | probably, with conversion | research |

## 7. Evaluation plan from our own recordings

`docs/voice-chat.md` plans "about 200 recorded turns". That is too few: the 95% interval on a 10% rate is about ±4 points at 200 pauses and ±2 at 800, and the turn-1-mini claims blur at 400 turns.
1. **Capture** opt-in dogfood sessions on device or our infrastructure. Per 256 ms block log VAD probability, Smart Turn score (run every block even if policy asks less often), `<EOU>` marks, partial words with times, policy decisions, and what the person did next (resumed within 3 s, barged in, typed, corrected). Policy tuning needs only these traces (the docs already replay traces through `TurnPolicy`); model comparison needs audio, kept for consenting testers only.
2. **Label like eot-bench.** Each silence of 100 ms or more inside a user turn is a candidate; the last before the answer is `eot`, earlier ones followed by the same speaker are `hold`. Continue events give false-commit labels free but miss people who gave up and typed, so add a human or LLM-assisted relabel of a sample (TurnBench: triple annotation, kappa 0.78). Tag categories: short answer, number/ID/citation, list, thinking pause, filler, pasted text read aloud, breath at end, TV or room noise, non-native speech.
3. **Replay causally** (the score at pause time `t` may use only audio up to `t`), sweeping `threshold`, `action_delay`, `timeout`. Plot false cut-offs per hold pause against mean and p90 added delay, per category. First confirm our corpus reproduces Smart Turn's public numbers.
4. **Report** false cut-offs per hold pause and per speech-minute; delay p50/p90/p99 from the last voiced word to commit and to first audio; share of turns over 1.5 s; speculation start, promote and wasted rates; false commits after audio started; Continue firings per hour.
5. **Seed with public data:** `livekit/eot-bench-data` (CC-BY-4.0, 14 languages), TurnBench (30 h test, 104 h labelled train, studio English), Smart Turn test sets. They lack legal vocabulary, TTS echo and our AEC: a regression guard, not a target.
6. **Mine hard negatives** (breath-ended pauses, fillers, thinking pauses, digit strings, quiet tails) for a Smart Turn fine-tune (training code and data format are open; mix public data to avoid forgetting) and for a small stacking model (logistic regression or gradient-boosted trees) over the Section 4 features.

## 8. Takeaways for our pipeline

Ranked by expected impact per effort. Values are starting points for the replay harness, not tested optima.

**1. Split provisional from commit and speculate behind a held gate.** Fixes "too slow" without more cut-offs.
- Provisional `P`: VAD silence of at least one block (256 ms) and Smart Turn P(complete) at least 0.35, or `<EOU>` and at least 0.25. At `P`: run Fluid Speech Mini on the utterance so far; start the LLM with a speculative flag; optionally pre-render the first clause with Phonon into a hold buffer (cheap, but watch Neural Engine contention with the EOU stream).
- Hold: no audio, no durable user message, no side-effecting tool until commit. Read-only retrieval is fine; a writing tool call withdraws the speculation.
- Promote at commit if the normalized final text equals the speculative text, else restart. At most 2 speculations per turn.
- Expect +30-60% LLM calls (Deepgram 50-70%, Endpoint Anticipation 28%) and a saving of `min(L, d_c - d_p)`, plausibly 400-700 ms. Check provider prompt-cache hits. If cost bites, speculate only the idempotent prefix (query rewrite, retrieval, cache warm-up).

**2. Replace "0.6 at 500 ms, re-ask every 750 ms" with a threshold that decays with silence, evaluated every block.** Smart Turn costs 3.5 ms. Commit `C` starting curve: P at least 0.85 from 400 ms of silence; 0.7 from 600 ms; 0.55 from 900 ms; 0.4 from 1.3 s; 0.25 from 2.0 s; hard limit 3 s. Pipecat uses 0.5 at 200 ms with a 3 s fallback; ours is stricter early until speculation is in, looser late. Test issue #32 on our data: if the score rises with appended silence the curve is natural; if not, score only the audio up to the last voiced word.

**3. Add a lexical and dialogue-context layer (small, on-device).**
- Last assistant message asked a yes/no or confirmation and the transcript is a short closed-class answer (yes, no, correct, go ahead; up to 3 words): `C` at 300-400 ms.
- Transcript ends in a conjunction, preposition, filler or hanging clause: multiply the required silence by 1.5-2.5 (Speechmatics).
- Digits, spelled letters, citations, dates, or an assistant request for an identifier or list: at least 1.2 s of silence whatever the score.
- Optionally let the speculative call emit a ●/◐/○ completeness marker (Section 3.4) or use a small judge on our server later.

**4. Per-user adaptation from the Continue rule.** On each Continue event record the gap; keep an EMA (`alpha` about 0.9) and set the session's silence floor to it, clamped to [400 ms, 1.2 s]; persist a slower profile for people who often pause. Cap the effect so adaptation cannot drift everyone toward long waits.

**5. Remove mechanical delay in the plumbing.**
- 256 ms VAD blocks mean `pauseMs` 500 is 512-768 ms of real silence before the first check; time silence from the last voiced word (Parakeet word times) or get a finer-hop VAD.
- Run the final transcription at `P`, not after commit (Kyutai's flush idea).
- A breath that VAD calls speech resets the silence timer and makes turns slow; log "last word end to commit" separately from "VAD end to commit".

**6. Improve the acoustic model before buying one.** Fine-tune Smart Turn v3.2 on our hard negatives and narrowband/AEC conditions; benchmark turn-1-mini on the same replay and stack both with `<EOU>` and the lexical features. Do not plan on LiveKit v1/v1-mini (licence) or any cloud detector (privacy). Treat small-shop numbers (turn-1-mini, VoxTurn, Cue) as claims until reproduced.

**7. Soften the false commits that remain.** Keep the Continue rule but cancel gently: duck to -15 dB over about 450 ms, pause within 500 ms, keep the generation for 800 ms, merge on a same-speaker continuation, record the heard prefix. Show a quiet "still listening" state when `P` has fired but `C` has not.

**8. Later, with GPUs:** a dialogue-aware server judge (Cue-style) or ASR-integrated pause head (Kyutai-style) for web and Android.

**Avoid:** shortening the pause to 200-300 ms without speculation (the original cut-off failure); treating Smart Turn "incomplete" as proof of mid-thought; relying on `<EOU>` alone; tuning on a set with few long pauses.

**Acceptance:** accept a change only if it improves the frontier: at most 5% false cut-offs per hold pause, p50 added delay under about 600 ms, p90 under 1.2 s, wasted speculation under 40% of turns.

## Sources (fetched 22 Oct 2026; dates are publication dates where known)

- eot-bench and data: https://github.com/livekit/eot-bench ; https://huggingface.co/datasets/livekit/eot-bench-data ; https://github.com/livekit/eot-bench/issues/14 ; reproduction: https://github.com/kadirnar/voice-agent-next/pull/109
- LiveKit v1 (17 Jun 2026): https://livekit.com/blog/solving-end-of-turn-detection ; docs https://docs.livekit.io/agents/logic/turns/turn-detector/ , https://docs.livekit.io/agents/logic/turns/tuning/ , https://docs.livekit.io/reference/agents/turn-handling-options/ , https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/ ; licence https://huggingface.co/livekit/turn-detector/blob/main/LICENSE ; source `livekit-agents/livekit/agents/voice/endpointing.py` in https://github.com/livekit/agents
- Pipecat Smart Turn: https://github.com/pipecat-ai/smart-turn (commits to 29 Jan 2026; issues #32 19 Nov 2025, #41 8 Jul 2026, #42 18 Aug 2026) ; https://huggingface.co/pipecat-ai ; https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/ (Sep 2025) ; https://www.daily.co/blog/improved-accuracy-in-smart-turn-v3-1/ (3 Dec 2025) ; https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/ (7 Jan 2026) ; https://docs.pipecat.ai/server/utilities/turn-detection/smart-turn-overview ; https://docs.pipecat.ai/server/utilities/turn-management/user-turn-strategies ; https://docs.pipecat.ai/api-reference/server/utilities/turn-management/filter-incomplete-turns ; https://github.com/pipecat-ai/pipecat/pull/5690 ; https://github.com/pipecat-ai/pipecat/pull/6151 ; third-party reading of Smart Turn's benchmark: https://www.evalgent.com/blog/pipecat-interruption-strategy-smart-turn
- Deepgram: https://developers.deepgram.com/docs/flux/configuration ; https://developers.deepgram.com/docs/flux/voice-agent-eager-eot ; https://deepgram.com/learn/introducing-flux-conversational-speech-recognition (1 Oct 2025) ; https://www.evalgent.com/blog/deepgram-flux-vs-nova-3
- AssemblyAI https://assemblyai.com/docs/streaming/universal-streaming/turn-detection ; Speechmatics https://github.com/speechmatics/speechmatics-academy/tree/main/basics/08-voice-agent-turn-detection ; Soniox https://soniox.com/docs/stt/rt/endpoint-detection ; Vapi https://docs.vapi.ai/customization/voice-pipeline-configuration
- Krisp https://sdk-docs.krisp.ai/docs/krisp-turn-taking-v2-blog ; https://docs.pipecat.ai/pipecat/features/krisp-viva ; https://docs.jambonz.org/self-hosting/overview/krisp-turn-taking ; TEN https://github.com/ten-framework/ten-turn-detection
- NVIDIA https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1 (+ discussion 7, Dec 2025) ; https://huggingface.co/FluidInference/parakeet-realtime-eou-120m-coreml
- Kyutai https://kyutai.org/stt/ ; https://github.com/kyutai-labs/unmute ; https://gradium.ai/blog/semantic-vad ; OpenAI https://developers.openai.com/api/docs/guides/realtime-vad
- Models: https://huggingface.co/p99lab/turn-1-mini (Oct 2026) ; https://arxiv.org/html/2610.21150 (VoxTurn) ; https://wavect.io/blog/cue-turn-detection-phone-numbers (12 Oct 2026) ; https://huggingface.co/speakrail/Voxtral-Mini-4B-Realtime-2602-TurnHead ; https://www.ultravox.ai/blog/ultravad-is-now-open-source-introducing-the-first-context-aware-audio-native-endpointing-model (9 Sep 2025)
- Papers: https://arxiv.org/abs/2609.11066 (11 Sep 2026) ; https://arxiv.org/abs/2609.04225 ; https://arxiv.org/abs/2606.13450 ; https://arxiv.org/abs/2609.20995 (17 Sep 2026) ; https://arxiv.org/abs/2603.23346 ; https://arxiv.org/abs/2503.23439 ; https://arxiv.org/abs/2607.23204 (25 Jul 2026) ; https://arxiv.org/abs/2606.18094 ; https://arxiv.org/abs/2604.01897 ; https://arxiv.org/abs/2610.04400 ; https://arxiv.org/abs/2509.23938 ; https://arxiv.org/abs/2209.05161
- TurnBench (25 Aug 2026): https://www.sesame.com/blog/turnbench ; https://turnbench.sesame.com/ ; https://arxiv.org/abs/2608.25218
- Human timing (secondary): https://cognitionandculture.net/blogs/icci-blog/universals-in-turn-taking-in-conversation-pnas-paper/index.html
- Our code and docs (read only): `mobile/plugins/speech/ios/Sources/MikeSpeechPlugin/TurnPolicy.swift`, `docs/voice-chat.md`
