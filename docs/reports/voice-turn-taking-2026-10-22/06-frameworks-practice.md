# Voice-agent systems and engineering practice, October 2026

Researcher 06 of 6. Topic: how the leading open-source and production stacks wire the cascaded pipeline, compared with ours (see `context.md`). Everything below was retrieved on 2026-10-22.

Evidence tags used throughout:
- **[src]** I read the source code. Cloned HEADs: LiveKit Agents `7a7547e4` (2026-10-22), Pipecat `1c6e4571` (changelog top is v1.13.0, 2026-10-18), Kyutai Unmute `e348e567` (2026-09-09), Vocode `e054c33a` (2024-11-15, abandoned).
- **[doc]** Official docs.
- **[V]** Vendor-reported number, not independent.
- **[paper]** Paper or preprint. **[3p]** Third-party blog or benchmark.

---

## 0. Summary of what matters

1. **The mainstream answer to "too eager vs too slow" is not a better threshold; it is speculation.** LiveKit (default on), Pipecat (`EagerUserTurnStopStrategy` plus `SpeculationGate`), Deepgram Flux (`EagerEndOfTurn`) and Voice-Light all start the LLM (optionally TTS) at an early, low-confidence end-of-turn candidate, keep the result private, and either promote it when the transcript is unchanged or cancel it when the user resumes. This lets the final commit be conservative without the user paying for it. We have no equivalent.
2. **Our commit gate is more conservative and later than every framework default.** Pipecat runs Smart Turn once at 0.2 s of VAD silence (threshold 0.5), with a 3 s fallback. LiveKit's audio detector commits at 0.3 s and waits up to 2.5 s only when the model says "unlikely". Voice-Light opens a speculative candidate at roughly 160 ms of silence and commits with a 560-640 ms minimum delay and an 800 ms timeout. We start at 500 ms behind a 256 ms VAD block that reports one block late, then re-ask every 750 ms. The frameworks look aggressive because speculation and resume machinery sit behind them.
3. **No end-of-turn detector is good enough to be the only gate.** On LiveKit's eot-bench [V], Smart Turn v3.2 has 35.2% false cutoffs at a 300 ms latency budget and 14.8% at 600 ms. The best model (LiveKit v1, not self-hostable) has 9.9% and 4.5%. A plain silence VAD needs about 1.6 s to reach 5%. An independent bench (Codebridge, Aug 2026) found a 680 ms mid-sentence pause defeated every endpointer tested.
4. **Barge-in best practice is reversible.** LiveKit pauses (not stops) on VAD onset, resumes after 2.0 s with no transcript, and has a 3 s echo warm-up. Voice-Light ducks to -15 dB over 450 ms, pauses by 500 ms, and commits only on a floor-take probability above 0.82 or about 900 ms of sustained speech. Our hold after 700 ms of speech is slower than any of them.
5. **We are ahead on "what was heard" and on other-voice handling.** Played-sample clock beats LiveKit's syllable-rate estimate, Vocode's character proportion and Unmute's synthesized-text stream. None of the open stacks has enrolled-speaker verification.
6. **Best-in-class measured voice-to-voice is about 650-900 ms, not 500.** Sub-500 ms is a vendor target. Endpointing is the largest controllable stage. For our tool-using text agent, LLM time-to-first-token plus retrieval will dominate, so speculation, cache pre-warming and bridge speech matter more than shaving the VAD.

---

## 1. The systems

### 1.1 LiveKit Agents (Python 1.5-1.7, TS 1.2+) [src][doc]

Turn handling is one options object (`TurnHandlingOptions`). Defaults below are read from `voice/turn.py`.

| Setting | Default |
|---|---|
| Endpointing `min_delay` / `max_delay` | 0.5 s / 3.0 s (fixed mode). With the audio turn detector: 0.3 s / 2.5 s |
| Dynamic endpointing `alpha` | 0.9 (EMA) |
| Interruption `min_duration` / `min_words` | 0.5 s / 0 (words need STT) |
| `false_interruption_timeout` / `resume_false_interruption` | 2.0 s / True |
| `backchannel_boundary` | (1.0, 1.0) s |
| Preemptive generation | on; `preemptive_tts` False; `max_speech_duration` 10 s; `max_retries` 3 |
| `aec_warmup_duration` | 3.0 s (none for outbound SIP or simulations) |
| `user_away_timeout` | 15 s |
| Silero plugin VAD | activation 0.5, `min_silence_duration` 0.55 s, `min_speech_duration` 0.05 s, prefix padding 0.5 s (the inference VAD uses 0.25 s silence) |

Sources: https://docs.livekit.io/reference/agents/turn-handling-options/, https://docs.livekit.io/agents/logic/turns/tuning/, https://docs.livekit.io/agents/logic/sessions/, https://github.com/livekit/agents (`voice/turn.py`, `voice/endpointing.py`, `voice/agent_activity.py`, `voice/agent_session.py`).

**End of turn.** The audio turn detector v1 (announced 2026-06-17; audio-only, fused semantic and acoustic branches, uses only the current user turn) streams predictions while the user talks. In `audio_recognition.py`, if `P(EOT) < unlikely_threshold` the delay becomes `max_delay` (2.5 s); otherwise `min_delay` (0.3 s). That is a two-level policy, and a prediction that has not arrived in about 1 s is skipped. `v1` runs on LiveKit Cloud; `v1-mini` is open-weight (LiveKit Model License, not Apache) for CPU, about 244 MB RSS. There is also a `backchannel_probability` output. Deprecated: the text detector (Qwen2.5-0.5B, 396 MB, 50-160 ms). Sources: https://docs.livekit.io/agents/logic/turns/turn-detector/, https://livekit.com/blog/solving-end-of-turn-detection.

**Dynamic endpointing** (`voice/endpointing.py`) learns `min_delay` from the user's own behaviour with an EMA clamped to [min, max]. It learns from (a) pauses between utterances with no agent turn between, and (b) "immediate interruption" cases, where the user resumed right after the agent began, which proves the earlier pause was a false end of turn. Backchannel-only overlaps are excluded from learning, and a 0.25 s grace period handles TTS leading silence. This is our "Continue" rule turned into per-user adaptation.

**Preemptive generation** (`on_preemptive_generation`): on a final STT transcript, before the turn is confirmed, start the LLM (not TTS by default). It is cancelled if later interim or final transcripts are no longer equivalent (`_transcripts_equivalent`), capped at 3 attempts per turn, and skipped if the user has already spoken for over 10 s. LiveKit warns it "doesn't always reduce latency", so it surfaces wasted generations in traces.

**Interruption.** Two modes. `vad`: on speech start (after `min_duration`, and `min_words` if set) the agent pauses the audio output, goes to "listening", and arms the false-interruption timer. A final transcript or committed turn then stops the paused speech. If 2.0 s pass with no transcript, it resumes and emits `agent_false_interruption`. Resume requires an audio sink that can pause. `adaptive` (LiveKit Cloud only; self-hosted gets a dev allowance, then falls back to VAD): a CNN over the first few hundred ms of overlap classifies interruption versus backchannel. Vendor numbers [V]: 86% precision and 100% recall at 500 ms of overlap, inference 30 ms or less, median 216 ms to trigger, rejects 51% of VAD barge-ins, trained on hundreds of hours of human conversation. Source: https://livekit.com/blog/adaptive-interruption-handling. The `backchannel_boundary` cooldown suppresses adaptive backchannel verdicts for the first and last second of an agent turn, because there the model can mistake a real interruption for a backchannel and late transcripts are real turns.

**What was heard.** On interrupt, `agent_activity.py` takes `playback_ev.synchronized_transcript` and writes it to chat history as the assistant message with `interrupted=True`. If the audio never played, the message is empty. The synchronizer (`transcription/synchronizer.py`) uses TTS word timings when the plugin supplies them (Cartesia, ElevenLabs, Rime, Speechify). Otherwise it estimates by syllable rate: a prior of 3.83 syllables per second, refined from pushed text over pushed audio duration, applied to the sink's `playback_position`. Disable with `sync_transcription=False`; opt into aligned timing with `use_tts_aligned_transcript`. Source: https://docs.livekit.io/agents/build/text/.

**Observability.** Per-turn `e2e_latency` (user stopped to agent started), `EOUMetrics` (`end_of_utterance_delay`, `transcription_delay`, `on_user_turn_completed_delay`), LLM `ttft`, TTS `ttfb`, `InterruptionMetrics`, OpenTelemetry traces with an `eou_detection` span carrying chat context, probability, threshold and delay, discarded preemptive turns, and session audio recordings with replay in Cloud. Source: https://docs.livekit.io/deploy/observability/data/. Simulation: LLM-driven simulated users with an LLM judge (https://livekit.com/blog/testing-voice-agents-with-agent-simulations).

**Tool-time filler.** In a tool, `async with ctx.with_filler(source, delay=..., interval=..., max_steps=...)` waits for a continuous idle `delay` (session idle, nobody speaking), then speaks the string or callable result, optionally repeating (`voice/events.py`, `voice/filler_scheduler.py` at the HEAD I read).

### 1.2 Pipecat (1.13, BSD-2) [src][doc]

Start strategies and stop strategies are composable. Defaults (https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies, verified in `src/pipecat/turns/`):

| Setting | Default |
|---|---|
| VAD (Silero) | confidence 0.7, start 0.2 s, stop 0.2 s, min_volume 0.6 |
| Start | `VADUserTurnStartStrategy` + `TranscriptionUserTurnStartStrategy` (interruptions on) |
| Stop | `TurnAnalyzerUserTurnStopStrategy(LocalSmartTurnAnalyzerV3)` |
| Smart Turn | runs once at VAD stop, last 8 s, `prediction = p > 0.5`, `stop_secs` fallback 3.0 s, `pre_speech_ms` 500 |
| Safety net | `user_turn_stop_timeout` 5.0 s |
| `MinWordsUserTurnStartStrategy` | 1 word when bot silent; example config uses 3 while bot speaks |
| Alternative stop | `SpeechTimeoutUserTurnStopStrategy` 0.6 s |

Important details from `turn_analyzer_user_turn_stop_strategy.py`: the commit waits for a finalized transcript or an STT p99 deadline (`ttfs_p99_latency`) anchored to the true end of speech (`frame.timestamp - stop_secs`), not to when VAD reported it. Smart Turn model: v3.2, Whisper-Tiny encoder plus linear head, about 8M parameters, 8 MB int8 CPU or 32 MB fp32 GPU, 23 languages, about 10 ms to under 100 ms on CPU ([repo](https://github.com/pipecat-ai/smart-turn)). Set `PIPECAT_SMART_TURN_LOG_DATA` to dump each analysed segment as WAV labelled complete or incomplete, which is a ready-made hard-example collector. No Smart Turn v4 found. An addressee or "Audience" model: I could not find one in the Pipecat source, docs or search; treat that as unverified.

**New in 2026 and relevant:**
- `EagerUserTurnStopStrategy` plus `SpeculationGate` (`turns/speculation_gate.py`): inference starts on an eager end-of-turn from the STT (Deepgram Flux style), the response frames are held (states OPEN, HOLDING, DROPPING) and released only when the turn is confirmed. Matching is `NormalizedMatch` (ignores case and punctuation) or exact. Cancel on resume, on transcript mismatch, or after `speculation_timeout` 5 s. Nothing reaches the user or the context until confirmed.
- `LLMTurnCompletionUserTurnStopStrategy` / `FilterIncompleteUserTurnStrategies`: the LLM itself judges completeness. It prefixes its reply with one marker, complete / short-incomplete (wait 5 s, then re-prompt) / long-incomplete (wait 10 s). Realtime services unsupported ([doc](https://docs.pipecat.ai/api-reference/server/utilities/turn-management/filter-incomplete-turns)).
- `KrispVivaIPUserTurnStartStrategy`: proprietary Krisp interruption-prediction model (audio-only, intent to take the floor vs backchannel), threshold 0.5 ([doc](https://docs.pipecat.ai/pipecat/features/krisp-viva)). Krisp's results are vendor claims with no precision or recall published.
- User mute strategies (always, first speech, until first bot complete, during function calls) and `UserIdleController` (timeout 0 = off).
- `EmptyUserTurnConfig`: if an interruption fires but no transcript follows, prompt the user to repeat (`max_consecutive_recoveries` 1). That is their false-start handling.
- Pipecat Evals (1.4.0+, https://docs.pipecat.ai/pipecat/fundamentals/evaluations/overview): YAML scenarios, scripted or LLM-persona users, text or audio mode, `within_ms` latency budgets, `send_after` barge-ins, LLM judge. No quantitative turn-taking metrics.

**What was heard.** TTS word timestamps become `TTSTextFrame`s with a PTS. The output transport releases them on its clock (`_clock_queue` keyed by PTS), and the assistant aggregator closes the turn with `interrupted=True` on an `InterruptionFrame`. So the context holds roughly what was played.

**TTS chunking.** `TextAggregationMode.SENTENCE` (default) or `TOKEN` (stream tokens to providers that accept them); services include Kokoro, Piper, Pocket TTS, Moonshine and Whisper locally.

**Observability.** `UserBotLatencyObserver` decomposes a turn into named spans: endpointing wait (attributed to the VAD `stop_secs` setting), transcription, turn detection, LLM inference, turn-completion, first text, text aggregation, TTS, first audio. Spans no service measures are labelled as "pipeline". Also `TurnTrackingObserver`, OpenTelemetry `turn_trace_observer`, and `AudioBufferProcessor` for recordings.

### 1.3 Kyutai Unmute [src][paper]

Architecture: Rust WebSocket workers for STT, TTS and an OpenAI-compatible LLM server (vLLM); Python handler for turn logic ([repo](https://github.com/kyutai-labs/unmute), MIT). GPU needs: about 16 GB VRAM total (LLM 6.1, STT 2.5, TTS 5.3 GB). Kyutai says TTS latency goes from about 750 ms on one L40S to about 450 ms on separate GPUs [V]; a "sub-second" total is claimed.

Turn logic in `unmute_handler.py` (I read it):
- The STT model has a built-in semantic VAD head. The handler reads one of its pause heads (`prs[2]`) as an EMA with 10 ms attack and release (effectively raw). **Pause (end of turn) when it exceeds 0.6.** While the bot speaks, **interrupt when it falls below 0.4**, but only after the first 3 s of the session (echo cancellation warm-up on Mac). Any ASR word during bot speech interrupts immediately, even inside that 3 s.
- Once a pause is declared it **flushes the STT** by feeding zeros faster than real time to drain the model's 0.5 s delay, then calls the LLM. The log reports the flush as RTF.
- Interruption is a hard stop. TTS and LLM tasks are removed and an interruption character is appended to the assistant message. There is no resume.
- `USER_SILENCE_TIMEOUT` 7 s injects a "..." user message so the model can prompt.
- The assistant history is built from the TTS's word-level text messages (aligned to generated audio), not from playout acknowledgement.
- LLM words are streamed one at a time into the TTS (`rechunk_to_words`), relying on the TTS model's own text lookahead.
- All timing uses `audio_received_sec()` (samples received), not wall clock, so a recorded file can be replayed deterministically (`audio_input_override`). A recorder logs client and server events as JSONL and, by design, not user audio; it deletes the recording if consent is withdrawn. Prometheus histograms exist per stage (STT TTFT, TTS TTFT, vLLM TTFT, durations).

Research built on it: "Endpoint Anticipation" (Interspeech 2026) predicts turn end up to 2.56 s ahead to start LLM and TTS early, reporting 505 ms average latency reduction and 28.4% more speculative computation ([arXiv 2606.13450](https://arxiv.org/abs/2606.13450)). Kyutai STT 1B (en/fr, 0.5 s delay, CC-BY-4.0): https://huggingface.co/kyutai/stt-1b-en_fr. DSM paper (1.8B TTS variant: 150 ms at batch 1 on an H100): https://arxiv.org/abs/2509.08753.

### 1.4 Voice-Light (Sep 2026 preprint, open) [paper]

The closest published system to ours: a cascaded design with full-duplex mic, reversible playback and private speculation ([arXiv 2609.20995](https://arxiv.org/abs/2609.20995), single author; the latency study is three sessions, 36 turns, one operator, so a case study, not a user study). Its design rules, from the PDF text:
- Silero gives the immediate onset. On user speech during playback the browser fades toward -15 dB over 450 ms and pauses by 500 ms. This is reversible. A floor-take probability above 0.82 commits cancellation. A non-floor-feedback probability above 0.82 resumes the same generation without adding a user turn. Sustained speech commits floor-taking after 900 ms. Generation and TTS budgets are held after 350 ms of unresolved overlap. Paused audio stays resumable at most 800 ms. Empty or slow final ASR gets a 120 ms grace.
- Speculation: after 80 ms of low Silero speech probability, the adapter gets a further 80 ms to open a speculative candidate; a Silero fallback may start at 160 ms. Text and PCM carry generation IDs and stay private until the final ASR agrees. Case, punctuation, whitespace and apostrophe changes preserve the work; lexical changes invalidate it.
- History is built only from audio ranges the browser acknowledges every 80 ms.
- **Negative result worth remembering:** a learned completion head on shared Nemotron features had 2.70% false cutoff but only 12.53% EOT recall on a locked real-conversation test, versus 95.60% for a tuned Silero timing policy (LiveKit v1-mini 91.50% / 2.70%; Smart Turn v3.2 20.72% / 13.51%, with a caveat about training-data overlap). The synthetic-trained head ranked well on synthetic data (AUROC 0.93) and near chance on human labels (0.56). So: tuned timing plus a deadline is a hard baseline; evaluate any learned detector on real held-out conversation first.
- Latency: median 758 ms from final VAD endpoint to first server audio (range 528-1,652 ms; 836 ms to browser render). In the 13 fully traced turns, median endpoint commitment was 502 ms, LLM first word 336 ms, TTS first PCM 444 ms. Nine of 13 promoted speculation: 667 ms median, versus 1,513 ms for the four without. The authors state this is confounded and not a causal 846 ms speedup.

### 1.5 TEN Framework [doc]

Repo https://github.com/TEN-framework/ten-framework (extensions for STT/LLM/TTS, Agora-centric examples, Apache-2.0 "with additional restrictions"). Two useful pieces:
- **TEN VAD** (https://huggingface.co/TEN-framework/ten-vad): 16 kHz, 10 ms or 16 ms hop, 306-731 KB library, iOS arm64 and Android and WASM builds, RTF 0.005 on an iPhone 8 and 0.021 on an iPhone 6, versus Silero RTF 0.0127 on a Xeon (Silero ~2.2 MB). Claims faster speech-to-silence transitions than Silero [V, own test set]. License "Apache 2.0 with additional conditions": read `LICENSE` before using.
- **TEN Turn Detection** (https://huggingface.co/TEN-framework/TEN_Turn_Detection): Qwen2.5-7B text classifier with three classes: finished, unfinished, **wait** (the user told the agent to hold off, e.g. "shut up"). English and Chinese, Apache-2.0. Too heavy for the phone, but the explicit "wait" class is a good design cue.

### 1.6 Managed or hosted knobs worth knowing

- **Ultravox** (speech-native LLM, hosted VAD settings; https://docs.ultravox.ai/noise/understanding-vad): `turnEndpointDelay` 0.384 s, `minimumTurnDuration` 0 s, `minimumInterruptionDuration` 0.09 s, `frameActivationThreshold` 0.1 (32 ms frames). Guidance: change the endpoint delay first, one parameter at a time. It feeds audio to the LLM and yields text, so it does not fit our "text thread is the agent" rule.
- **Deepgram Flux** ([config](https://developers.deepgram.com/docs/flux/configuration), [eager EOT](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot)): `eot_threshold` 0.7 (0.5-1.0), `eager_eot_threshold` off (0.3-0.9), `eot_timeout_ms` 5000. Presets: "medical or legal ... formal" 0.85 / 8000 ms; "RAG, tool-calling" eager 0.4, EOT 0.85, 7000 ms. Eager mode: 150-250 ms earlier for 50-70% more LLM calls [V]. Their tuning metric to copy: the ratio of Eager-then-Resumed to Eager-then-EndOfTurn.
- **OpenAI Realtime**: `server_vad` example values 0.5 / 300 ms prefix / 500 ms silence; `semantic_vad` has an `eagerness` dial (low, medium/auto, high) that sets the maximum wait ([doc](https://developers.openai.com/api/docs/guides/realtime-vad)). A user-visible patience setting is a precedent.
- **Vocode** [src]: abandoned after 2024-11-15 but still a clean reference. Time-based endpointing 0.4 s; `interrupt_sensitivity` low or high, where low treats up to 3 words or a regex list of backchannels as non-interruptions; heard text estimated as `text[: seconds / seconds_per_char]` (`get_message_up_to`).

### 1.7 On-device and mobile stacks

- **Volocal** ([repo](https://github.com/fikrikarim/volocal), MIT): iPhone 15, Parakeet EOU on the Neural Engine (no separate VAD), Qwen3.5-2B via llama.cpp on the GPU (about 32 tok/s), PocketTTS on CPU/GPU (about 80 ms to first audio), about 1.2 GB runtime. One shared `AVAudioEngine` with voice processing on both nodes; barge-in with turn-revision guards; sentence buffer at `.!?:;` with 200 characters max. It trusts the EOU token alone and publishes no end-to-end latency. Its README says moving STT and TTS off Metal to the Neural Engine fixed contention and dropouts.
- **FluidAudio and speech-swift**: FluidAudio ([README](https://github.com/FluidInference/FluidAudio)) lists streaming Parakeet EOU, Silero VAD (256 ms hop), LS-EEND online diarization (100 ms updates), and **LocalVQE**, a 4.8M-parameter beta echo canceller that takes the TTS stream as far-end reference (16 ms latency; on a synthetic subset near-end word recall went from 44.1% to 77.6% and far-end leakage from 34.0% to 1.1% [V, README]). speech-swift ([repo](https://github.com/soniqo/speech-swift)) wraps Smart Turn v3.2 CoreML with Silero in a `VoicePipeline` state machine and also ships LocalVQE-AEC, but gives no barge-in logic or end-to-end latency.
- **Apple SpeechAnalyzer (iOS 26)** ([WWDC25 277](https://developer.apple.com/videos/play/wwdc2025/277/)): volatile and final results, per-run `audioTimeRange`, models in system storage outside app memory, a separate `SpeechDetector` VAD module. No end-of-turn semantics; `finalizeAndFinishThroughEndOfInput()` ends a session. I found no iOS 27 changes to the Speech framework. A third-party measurement reports 0.3-0.5 s to the first volatile result when warm [3p].
- **Google/Android**: ML Kit GenAI Speech Recognition has a basic mode and an advanced Gemini-Nano mode (Pixel 10), streaming partial and final flows, and nothing published about endpointing ([blog, Jul 2026](https://android-developers.googleblog.com/2026/07/android-on-device-inference.html)). `RecognizerIntent` silence-length extras are hints that recognizers may ignore. I found no Google turn-taking documentation to borrow from.

---

## 2. Latency: what is published, what is achievable

**Measured, with the metric defined (last input sample to first audible output sample).** Codebridge (499 calls, Aug 2026, screening-grade, 5-21 turns per cell) [3p]: with the endpoint given for free, a Flux+Groq+ElevenLabs cascade 707 ms median, Gemini 3.1 Flash Live 786 ms, OpenAI Realtime mini 889 ms, OpenAI Realtime 1,140 ms. With endpoint detection included on a hesitation fixture: tuned LiveKit 854 ms, ElevenAgents 758 ms. Stage medians on LiveKit defaults: endpoint decision 584 ms, STT 307 ms, LLM first token 322 ms, TTS first audio 134 ms. Cutting VAD silence and endpoint delay from 0.55/0.50 s to 0.25/0.25 s dropped the endpoint stage from about 586 ms to 271 ms with no false cutoffs on that corpus. The same study found that a 680 ms mid-sentence pause defeated every endpointer (0 of 65+ clean passes), and a practitioner figure (not verified) of 94.0% versus 46.9% for a completeness gate over a silence timer: https://www.codebridge.tech/articles/voice-ai-phone-agents-latency-benchmark.
Other references: Telnyx's four-platform test has Retell at 680 ms median [3p/V]; Voice-Light 758 ms with a GPU pair and scale-to-zero (it missed its own 250-600 ms target); Hamming (Jan 2026, vendor) lists typical 1,000-3,200 ms and optimized 670-1,450 ms end to end, LLM about 70% of the total: https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it. TurnBench reports that in smooth floor transfers human listeners start a median 151 ms **before** the speaker finishes (https://arxiv.org/abs/2608.25218), which no pause-based endpointer can match.

**Tricks, with who does them:**
- *Speculative start*: LiveKit, Pipecat, Deepgram, Voice-Light, Unmute research. Costs: +50-70% LLM calls (Deepgram [V]); guard rails: 3 retries, 10 s cap (LiveKit), 5 s speculation timeout (Pipecat).
- *Start from partials/prefetch*: Sierra (Oct 2025) runs a concurrent task graph with predictive prefetch (a known caller's order data), small models for state updates, provider hedging, and measures "time to first relevant response", not filler ([blog](https://sierra.ai/blog/voice-latency)).
- *Filler and bridge speech*: LiveKit tool-time filler; Voice-Light's short bridge before a tool call (it must be closed before awaiting the tool because Kyutai TTS needs text lookahead); preface generation (context-aware prefaces cut the gap between first and main response but have a longer initial latency than fixed filler; no naturalness difference found, [arXiv 2607.23204](https://arxiv.org/abs/2607.23204)); ConvFill's small talker plus large reasoner ([arXiv 2511.07397](https://arxiv.org/abs/2511.07397)). Failure mode from Roark: filler that starts late because the model reasons first, or outlasts the tool.
- *Cached audio*: pre-synthesized greetings and confirmations (Sierra, Hamming).
- *Warm caches*: LiveKit says prewarm VAD and co-locate. LLM prompt caching is not mentioned by LiveKit or Sierra. Anthropic's docs describe an explicit pre-warm (`max_tokens: 0` writes the cache and returns immediately; 5 min or 1 h TTL; cache reads 0.1x input price) ([doc](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). Firing it at VAD onset would warm a long thread-plus-retrieval prefix before the words arrive.
- *First-clause shortening*: none of the frameworks do it in code. Volocal and LiveKit tokenizers chunk by sentence; Unmute and Pipecat TOKEN mode go word by word with provider lookahead.
- *STT flush*: Unmute pads the stream with zeros after a pause to drain the model delay.
- *Local VAD*: Pipecat says local VAD is 150-200 ms faster than remote.

---

## 3. Evaluation and tuning practice

- **Sweep, don't guess; report the frontier.** LiveKit's eot-bench (https://github.com/livekit/eot-bench, Apache-2.0, 14 languages, real human-to-agent turns, every pause of 100 ms or more labelled as hold or end) reports false-cutoff rate at fixed latency budgets (300/600 ms) and latency at fixed false-cutoff targets (5/10%), sweeping threshold, action delay and timeout per model. English results [V, run by a competitor]:

| Model | FC @300 ms | FC @600 ms | latency @5% FC |
|---|---|---|---|
| LiveKit v1 | 9.9% | 4.5% | 543 ms |
| Deepgram Flux | 12.9% | 9.9% | 1,151 ms |
| LiveKit v1-mini | 27.8% | 12.1% | 1,070 ms |
| Smart Turn v3.2 | 35.2% | 14.8% | 1,051 ms |
| VAD only | 55.6% | 21.7% | 1,600 ms |

- **Turn-taking benchmarks**: TurnBench (Sesame, SLT 2026; 154 dyadic conversations, about 30 h, triple annotated, EOT and interruption detection; recall, FPR, latency; false positives concentrate in backchannel-dense styles; no system matches humans without excess false positives; MIT code, non-commercial data) https://github.com/SesameAILabs/turnbench. Talking Turns (ICLR 2025; judge model trained on human conversation; systems over-interrupt and rarely backchannel) https://arxiv.org/abs/2503.01174. Full-Duplex-Bench v1/v1.5/v2/v3 (v3 released 2026-05-20, tool use under disfluency) https://github.com/DanielLin94144/Full-Duplex-Bench. Smart Turn's own public train and test sets on Hugging Face.
- **Acceptance harnesses** [3p]: Roark's eight pre-launch scenarios and metrics (false cutoff rate scored from audio; P50/P95 latency; false interrupt rate; dead-air rate above 1.5 s; per-persona splits; turn every production failure into a regression test; gate endpointing changes in CI) https://roark.ai/blog/testing-turn-detection-voice-agents. A 4x5 matrix (caller behaviour by acoustic condition) with an interruption confusion matrix, endpointing errors kept separate, and intended/generated/confirmed-played text tracked per turn. It warns that 20 hand-picked cases cannot give a rate.
- **Simulated users**: LiveKit Agent Simulations and Pipecat Evals are both LLM-persona driven and mostly test conversation behaviour; their audio modes mostly test the pipeline, not calibrated turn-taking. Real recorded audio replay is what actually tunes endpointing.
- **Deterministic replay**: Unmute's sample-count clock and Voice-Light's locked, hash-pinned evaluation files are the two designs to copy.
- **"Too eager vs too slow" guidance**: LiveKit lists the two directions explicitly (too eager: turn detector, higher `min_delay`, adaptive interruption, voice isolation; too slow: confirm preemption, `preemptive_tts`, lower `min_delay`, `dynamic` mode). Deepgram suggests 7-8 s timeouts for legal and tool-calling use. Ultravox suggests changing one parameter at a time, endpoint delay first. Codebridge: tune the pause first.
- **Consent**: Unmute records events but not user audio, and deletes the file if consent is withdrawn; Pipecat's Smart Turn logger writes raw WAVs. For our remit, evaluation recordings must be explicit opt-in and stay on the device or our infrastructure.

---

## 4. Self-hostable components for a later GPU, and does a server loop help?

| Need | Candidate | Notes |
|---|---|---|
| Streaming ASR | Nemotron Speech Streaming 0.6B / 3.5 multilingual (cache-aware FastConformer-RNNT) | Chunks 80-1,120 ms; about 240 concurrent streams per H100 at 80 ms [V]; OpenMDW-1.1; no endpointing documented |
| | Voxtral Mini 4B Realtime (Mistral, Feb 2026) | Apache-2.0; delay in 80 ms steps; sub-200 ms config; at 480 ms within 1-2% WER of offline [V]; vLLM |
| | Kyutai STT 1B en/fr | 0.5 s delay; **built-in semantic VAD**; CC-BY-4.0; Unmute's turn logic reads its pause head |
| End-of-turn | Smart Turn v3.2 (BSD-2, fp32 GPU build about +1%); LiveKit v1-mini (CPU, LiveKit Model License); TEN Turn Detection (7B text, EN/ZH, Apache-2.0) | LiveKit's full v1 and adaptive interruption are LiveKit Cloud only |
| TTS | Kyutai TTS 1.6B | 346-353 ms first word to PCM on a dedicated GPU in Voice-Light; needs text lookahead |
| | Qwen3-TTS (12 Hz tokenizer) | Apache-2.0; 97 ms first packet [paper, author hardware] |
| | Pocket TTS 100M | CPU, about 200 ms to first chunk, cc-by-4.0 with use restrictions |
| Echo | LocalVQE (4.8M) | beta; takes the TTS stream as reference |

**Would moving part of the loop to our own server help?** Mostly for what is not latency-critical. Keep on the device: mic capture, AEC, VAD onset and offset, the instant duck-or-pause reaction, and the played-sample clock; these need single-digit to tens of ms and no network jitter. A server gives: larger streaming ASR with semantic endpointing (Kyutai or Voxtral) for web and Android, larger end-of-turn models, one policy for all clients, consented recordings in our infrastructure, and speculative runs that already live next to the LLM. It costs raw-audio upload (allowed by our remit if on our infrastructure), tens to over a hundred ms of RTT variance on the turn loop, and GPU operations. Codebridge found that moving a whole colocated stack between regions changed the median by about 1 ms, so geography matters less than co-location. Voice-Light found separating TTS onto its own GPU was worth keeping despite slower Qwen deltas. My recommendation: ship iPhone on-device; define the turn policy as a platform-neutral state machine with injectable "candidate" and "commit" signals so that a server end-of-turn model can feed it later.

---

## 5. Design versus ours

| Axis | LiveKit | Pipecat | Unmute | Voice-Light | Ours |
|---|---|---|---|---|---|
| Speech onset | Silero 0.5, 50 ms min | Silero 0.7, 200 ms start | STT head <0.4 or any word | Silero, immediate | Silero 256 ms blocks, one late |
| End-of-turn | Audio EOT v1 streaming; 0.3 s or up to 2.5 s by probability | Smart Turn once at 0.2 s; p>0.5; 3 s fallback | STT pause head >0.6, flush | Speculative candidate ~160 ms; commit min delay 560-640 ms, 800 ms timeout | Pause 500 ms, Smart Turn >=0.6, re-ask every 750 ms, 3 s limit, plus EOU candidate |
| Adaptive per user | EMA dynamic endpointing | None | None | None | None (but "Continue" events exist) |
| Speculation | LLM on by default; retries 3, cap 10 s | Eager strategy plus gate | Research only | Private candidate, promote on text match | None |
| Barge-in first reaction | Pause after 0.5 s and words (opt.), or CNN | Start strategy at 200 ms (VAD) or MinWords | Stop on first word | Duck at onset, pause by 500 ms | Hold only after 700 ms speech |
| Resume after false barge | Yes, 2.0 s | None found (empty-turn recovery prompt) | No | Yes, up to 800 ms | Pause not stop; resume rule not specified in context.md |
| Backchannel | Adaptive CNN, `min_words`, 1 s boundaries | MinWords, Krisp IP | Not handled | Learned heads at 0.82 | VAD plus 2 non-filler words not matching clause |
| Heard text | Synthesized or timing estimated | TTS word PTS on output clock | TTS word stream | 80 ms playout acks | Played-sample clock (exact) |
| TTS chunking | Sentence; word timing for 4 vendors | Sentence or token | Word-by-word with lookahead | Closed utterances; sanitized | Clause with one ahead |
| Metrics | e2e, EOU, ttft, ttfb, traces, recordings | Latency-span observer, OTel, Smart Turn WAV log | Prometheus, JSONL, sample clock | Rolling activity lanes | Not described |
| Eval | Simulations, eot-bench | Evals, stt-benchmark | Replay file | Locked eval sets | Benchmarks for speaker ID only |
| Other voices | Krisp voice isolation (vendor) | Krisp, Speechmatics tags | None | None | **Enrolled-speaker check, ahead** |
| Tool-time filler | `ctx.with_filler` | Function-call mute (no filler) | None | Bridge speech | None |

**Where we are behind:** speculation; adaptive and probability-tiered delay; late Smart Turn invocation; VAD granularity; barge-in reaction time and reversibility timing; per-stage metrics and replay; filler for slow turns; user-idle handling (LiveKit 15 s, Unmute 7 s, Pipecat optional).
**Where we are ahead:** exact heard-text, enrolled-speaker rejection, full on-device operation, a multi-signal EOT ensemble already in place, and an accurate second-pass ASR on the whole final utterance (I found no open stack that does this; they commit the streaming transcript).
**Cheap to borrow:** everything in Takeaways 3-9 below.

---

## Takeaways for our pipeline (ranked)

1. **Add private speculation behind an early candidate, and keep the commit conservative.** Candidate = Parakeet `<EOU>` or Smart Turn p >= ~0.5 at 250-300 ms of true silence (Pipecat's own default is 0.2 s and 0.5). On candidate: start a draft LLM run with read-only tools only (retrieval prefetch is the big win for our agent), no TTS audio released, no durable thread write, tagged with a generation ID. Promote at the existing conservative gate if the normalized transcript is unchanged (case and punctuation ignored, per Pipecat/Voice-Light; the second-pass ASR text is the one to compare); cancel on speech resume. Use LiveKit's guard rails as starting values: 3 retries per turn, skip when speech exceeds 10 s, 5 s timeout. Budget for roughly 50-70% more LLM calls (vendor). Track Eager-to-Resumed vs Eager-to-Commit (Deepgram's tuning ratio). This directly breaks the "too fast, then too slow" pendulum.
2. **Replace the single gate with probability tiers and a learned per-user floor.** Example: p >= 0.85 commits at ~250-300 ms of silence; 0.6-0.85 at ~500 ms; below 0.6 keep waiting with a longer hard limit (Deepgram suggests 7-8 s for legal and RAG use; LiveKit 2.5-3 s). Learn the per-user pause floor from our own "Continue" events (resumption after a commit proves a false end of turn; the pause length that preceded it is the sample), using LiveKit's EMA (alpha 0.9, clamped) and excluding backchannel overlaps. Consider a visible "patience" setting like OpenAI's `eagerness`.
3. **Fix the VAD clock before tuning anything else.** A 256 ms block that reports speechEnd one block late is worth up to 256-512 ms on every turn and quantizes barge-in onset. Anchor the pause timer to the last voiced frame, not the reported end (Pipecat anchors its STT deadline this way). Either run Silero natively at 32-64 ms windows or evaluate TEN VAD (16 ms hop, tiny, iOS arm64, check its license first).
4. **Make barge-in reversible and faster.** On VAD onset (after ~150-250 ms plus the existing words gate) duck about 15 dB over ~300-450 ms, then pause; resume from the played-sample position if no confirming words arrive within ~800 ms to 2 s (Voice-Light 800 ms, LiveKit 2.0 s). Add LiveKit's idea of a boundary around agent turn edges where backchannel verdicts do not suppress real speech, and a one-shot echo warm-up for the first agent utterance of a session (LiveKit 3 s; Unmute 3 s, where words still interrupt).
5. **Build the observability and replay harness now, before the next tuning round.** Log per turn: last voiced frame, VAD stop, candidate time, Smart Turn and EOU outputs, commit, second-pass ASR done, LLM request, first token, first clause, TTS first PCM, first audible sample; plus outcome labels (continued-within-3 s, held-then-resumed, held-then-stopped, speculation promoted or discarded). Copy Pipecat's span decomposition (name the part each setting owns) and LiveKit's e2e/EOU metric names. Drive the policy from a sample-count clock (Unmute) so recorded sessions replay deterministically. Tune on a false-cutoff-vs-latency frontier (eot-bench method) from our own consented recordings, and sanity-check with eot-bench-data and TurnBench dev. Do not swap in a learned detector without a real held-out check (Voice-Light's 12.5% recall result).
6. **Mask tool and retrieval latency explicitly.** After about 0.8-1.2 s of silence with no audio and a tool running, speak a short context-aware bridge ("Let me check the file"), at most once or twice, cancelled by user speech (LiveKit `with_filler`, Voice-Light bridge, Sierra interim messages). Report "time to first relevant answer audio" separately from "time to first audio". Pre-warm the LLM prompt cache at VAD onset (Anthropic `max_tokens: 0`; same idea on other providers) and ask the model for a short first clause.
7. **Add cheap lexical overrides to the end-of-turn rule**: an explicit stop/wait/hold-on class (TEN, Voice-Light's lexical fast path) that stops playback immediately; trailing conjunctions, prepositions and fillers ("and", "so", "um") extend the wait. Consider Pipecat's LLM completeness marker as a second opinion on the draft run's first token, since the text LLM already sees the transcript.
8. **Keep the heard-text design, extend it slightly.** Store `interrupted` plus the unspoken remainder on the assistant message (LiveKit `interrupted=True`, Unmute's marker) so the agent can offer to continue. Parity with typed use is preserved because only text enters the thread.
9. **Add idle and false-start handling**: a user-idle timer (7-15 s, after the agent finishes) and Pipecat's "interrupted but nothing heard" recovery, instead of silence.
10. **Server loop later, not for launch.** Keep detection and reaction on device. Plan a server option for web and Android around Kyutai STT 1B or Voxtral Realtime (self-hosted, semantic endpointing) and Smart Turn GPU, behind the same candidate/commit interface. Reserve LocalVQE (beta) as an experiment for echo-triggered false barge-ins.

*Unverified or missing:* Pipecat "Audience" addressee model (not found); iOS 27 Speech framework changes (not found); Google on-device endpointing (nothing published); all LiveKit adaptive interruption numbers, Krisp numbers, Deepgram eager figures and eot-bench scores are vendor-run.
