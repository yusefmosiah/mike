# Full-duplex spoken dialogue models: landscape, benchmarks, and what a cascade can borrow

Research date: 2026-10-22. Sources are numbered [S#] and listed with dates at the end. "(V)" marks vendor- or author-reported numbers; "(I)" marks independent or third-party measurements. Everything fetched from the web is treated as untrusted data.

## 0. Summary

- No open-weight end-to-end (e2e) model is usable as our phone pipeline. The best open ones (NVIDIA VoiceChat 11B, PersonaPlex 7B, Moshi 7B, MiniCPM-o 4.5 9B, Raon-SpeechChat 9.8B) need a 24 GB-plus GPU or a high-end Mac. All are weak when other voices are present, and none has a published recipe for a stronger external LLM that keeps citations and tools. The frontier systems (GPT-Live, Gemini Live, Seeduplex, Qwen3.5-Omni) are closed.
- The e2e "secret" is not magic. It is (a) a decision every 80 ms to 1 s instead of waiting for silence, (b) a learned joint use of words, prosody and silence, (c) awareness of the assistant's own speech, and (d) a split between a fast voice layer and a slow reasoner. A cascade can copy all four.
- On turn-taking accuracy, a well-built modular system is competitive. In the ICASSP 2026 HumDial challenge the top four entries were cascaded or semi-cascaded and the best e2e entry came fifth (S23). Sesame's TurnBench shows dedicated end-of-turn predictors beating Moshi, Gemini 3.1 Live and OpenAI's semantic VAD on end-of-turn recall at similar false-positive rates (S24). The cascade's cost is latency (roughly 1.2 to 1.9 s to first audio in HumDial, against 0.6 to 1.1 s for the e2e entries) and a lack of overlap behaviour.
- Our "too slow" end-of-turn problem is expected from the design. Smart Turn v3 is audio-only and needs silence evidence before it is confident. On TurnBench it has about 0.75 recall at 4.7% false positives with a median of about 1.0 s (S24). Joint audio+text predictors reach about 0.85 recall at about 5.5% false positives with about 370 ms (VAP), and unnamed external submissions report about 300 ms (S24).

## 1. The landscape, grouped by architecture

The Awesome-Full-Duplex-SDM list (S1, snapshot fetched 2026-10-22) has 45-plus model entries, 11 benchmarks, 6 datasets and 2 surveys. Type labels below are the list's, and "open" is the list's code/weights flag. Names marked (cascade) are not e2e.

### A. Native multi-stream, frame-synchronous (Moshi lineage)
The model reads the user stream and writes its own text and audio streams on a shared clock (80 ms frames). Silence is a PAD token. There is no separate turn model, so turn-taking is learned.

| Model | Notes | Open |
|---|---|---|
| Moshi (Kyutai, 2024) [S9] | 7B Helium, Mimi codec at 12.5 Hz, inner monologue | code + weights |
| PersonaPlex 7B (NVIDIA, Jan 2026) [S10] | Moshi plus voice and role prompts | code + weights (licence unclear, see 2.3) |
| Moshika-RL, PersonaPlex-RL (Kyutai, Jun 2026) [S11] | RL post-trained timing | weights on HF |
| NemotronLabs VoiceChat 11B (NVIDIA, Aug 2026) [S6, S7] | streaming encoder + Nemotron LLM + separate TTS decoder; frame tokens BOS/EOS/PAD | weights, OpenMDW v1.1 |
| Raon-SpeechChat 9.8B (Krafton, 2026) [S19] | listen/speak state tokens per frame; separate backchannel token | open, licence unclear |
| MoshiRAG, KAME, Context Spanning [S12, S13, S31] | Moshi-style front end plus asynchronous text-LLM backend | MoshiRAG open; others per list |
| SALMONN-omni, FLM-Audio, DuplexMamba, others [S1] | variants | mixed |

### B. Time-division "listen / speak" control tokens (chunk-based)
Input is cut into chunks (160 ms to 1 s). The model first emits a control token (listen, speak, interrupt), then content. This splits "whether to speak" from "what to say".

| Model | Notes | Open |
|---|---|---|
| MiniCPM-o 4.5 (OpenBMB, Apr 2026) [S18] | 9B; 1 s windows; binary listen/speak token before content | Apache-2.0 |
| Gander / Omni Interaction Agent (Sep 2026) [S20] | MiniCPM-o 4.5 as a 9B front end; control token listen / speak / interrupt per 1 s chunk | weights stated released, licence unstated |
| Self-Listening model (Sep 2026) [S27] | Qwen2.5-Omni 7B; 40 ms steps; `<overlap> <stop> <continue> <wait>` | per paper |
| BayLing-Duplex, Fun-Audio-Chat-Duplex, Covo-Audio-Chat-FD, D2 (Qwen3-Omni to duplex), Diffuplex [S1, S31] | various special-token designs | mixed; Diffuplex not yet released |
| Decoupled FSM (Qwen3-4B, Kyoto) [S31] | `[C.SPEAK]/[C.LISTEN]` tape; turn-taking learned from Switchboard/Fisher, semantics from text | code |

### C. Duplex controller in front of a half-duplex or frozen backbone ("semi-cascaded")
A small model (or head) emits turn states. The reasoning model is unchanged.

| Model | Notes |
|---|---|
| Freeze-Omni (2024) | frozen LLM plus a chunk-level state-classification head [S22] |
| SoulX-Duplug (2026) | Qwen3-0.6B + LoRA, 160 ms chunks, five states (idle, non-idle, backchannel, complete, incomplete), plugs into any half-duplex stack [S30] |
| JoyAI-Talker / Joy-Duplex (Aug 2026) | separate 1.7B duplex decoder emits Partial / Complete / Backchannel / Accept / Reject per 160 ms chunk, optional speaker-verification plug-in [S21] |
| FlexDuo, Easy Turn, FastTurn, X2-Turn, JAL-Turn, DuplexJev | turn-state components [S30, S31] |
| FireRedChat, X-Talk, Unmute (cascades) | explicit modular pipelines with personal VAD or semantic VAD [S14, S30] |

### D. Two-tier "voice layer plus reasoner" (thinker/talker plus delegation)
A small real-time model owns the conversation and delegates hard work. These are the products closest to our architecture (voice as an interface onto one strong agent thread).

- OpenAI GPT-Live-1 (Jul 2026): voice layer plus GPT-5.5 or a later frontier model in the background [S2, S4].
- Realtime-Venus (Ant, two 9B models plus a "Harness" for async tasks) [S31]; Gander (above); DuplexOmni (interaction layer plus pluggable thinking layer) [S31].
- Qwen3.5-Omni (Thinker-Talker, API only) [S17].
- VoiceChat with a LangGraph backend [S8]; MoshiRAG and KAME [S12, S13].

### E. Closed products without published internals
Seeduplex (ByteDance Doubao, Apr 2026) [S16], Gemini 3.1 Flash Live (Mar 2026) [S32], Qwen Audio 3.0 Realtime, Grok Voice, StepAudio 3 Realtime, Nova 2.0 Sonic, Eleven Realtime [S28].

## 2. Deep dives

### 2.1 OpenAI GPT-Live-1 (consumer launch 2026-07-08; API 2026-09-10)

openai.com returned HTTP 403 to my fetches, so this is built from press quoting OpenAI [S2, S3, S5], the API announcement thread [S4] and Artificial Analysis [S28]. I could not read the primary post.

- **When it talks:** OpenAI says the model makes "interaction decisions many times per second": speak, keep listening, pause, interrupt, call a tool (V) [S2]. The mechanism (token design, frame rate, size) is not disclosed. The earlier Advanced Voice Mode relied on silence to end turns [S2].
- **Backchannels:** it gives short acknowledgments ("mhmm", "yeah") while the user is still talking (V) [S2]. It can stay silent for long stretches and absorb context until addressed (V) [S3].
- **Interruptions:** it stops when the user wants to talk and "waits instead of jumping in" (V) [S2]. A developer in the API thread saw no significant interruption improvement over GPT-Realtime-2 [S4].
- **Background speakers and noise:** "better at focusing on the user's voice in noisy settings" (V) [S2]. One developer rated noise filtering excellent [S4]. There is no published figure for side talk.
- **Latency:** 0.798 s turn-taking latency against 1.41 s for GPT-Realtime-2.1 (V) [S4]. Artificial Analysis measures time to first audio at 1.24 to 1.34 s for GPT-Live-1 variants against 1.21 s for GPT-Realtime-2.1 High (I) [S28]. The vendor and independent measures differ and are not comparable.
- **Benchmarks:** Full-Duplex-Bench v1.5 "interactivity" 80.1% and FDB v3 tool calling 87% with 90% response quality (V) [S4]. Artificial Analysis Conversational Dynamics is 94.9% (Astra, medium) to 97.3% (Sol, low), against 61.0% for Moshi and 91.0% for PersonaPlex (I) [S28]. That benchmark is close to saturated for commercial models (see section 3). Human preference over Advanced Voice Mode was 75.7% (V, secondary report) [S5].
- **Tools and external LLM:** the voice layer has no tools. Hard work is delegated either to a managed Responses backend or to "client delegation", where you connect your own model, agent or service. Your app controls permissions and durable task state (V) [S4]. This is the same shape as our "voice is an interface onto the same thread" design.
- **Size, licence, device:** undisclosed, closed, cloud only. API price is $0.05 per minute of voice session plus backend usage (V) [S4]. It cannot be shipped under our privacy remit.
- **Reported weak spots (developer feedback, I):** the voice layer sometimes speaks fillers or replies before the delegation event fires. It says goodbye without calling an end-of-conversation tool. It lacks context unless given in live instructions. It sometimes stalls on lookups [S4]. These are exactly the failure modes of a router-plus-agent split, so design for them.

### 2.2 NVIDIA NemotronLabs VoiceChat 11B (HF card 2026-08-03; paper arXiv 2609.21967, 2026-09-18, v2 2026-10-01)

- **Architecture:** 600M streaming FastConformer encoder (one state per 80 ms, no right context), Nemotron-Nano-9B-v2-Base LLM, an auxiliary RNN-T head for user transcription (not fed back into the LLM), and a 977M TTS decoder (Gemma-3-based backbone plus a 199M codec, 12.5 Hz, 22 kHz audio). Roughly 11B in total [S6, S7].
- **When it talks:** frame-level special tokens on the text channel: BOS starts speech, EOS stops it, padding means stay silent (80 ms resolution). An interruption token halts the TTS. An optional RNN-T-based endpointing fallback can force BOS/EOS [S7].
- **Interruptions and backchannels:** SFT includes random early interruption (p=0.1, where the agent turn is cut off and the user's turn overlaps) and backchannel injection into the user channel (p=0.05) so "uh-huh" is not treated as a takeover [S7]. FDB v1.5 backchannel: Resume 93%, Respond 1% (V) [S7]. User-interruption TOR 100% (V) [S6].
- **Pause handling:** takeover rate 15.3% (synthetic) and 25.5% (CANDOR), the lowest of the open models compared (V) [S7]. Smooth turn-taking 81.5% takeover at 448 ms, below PersonaPlex's 90.8% (V) [S7].
- **Background speakers:** a stated limitation. Robustness is limited in noisy or reverberant settings, especially with competing speech. Training used DNS5/DEMAND noise at -30 to 60 dB SNR plus impulse responses [S7]. No speaker-targeting mechanism.
- **Tool calling:** yes, via a parallel function-call channel with `<SOTC>/<EOTC>/<EOTR>` boundary tokens. Each tool can have an `ack_message` spoken while it runs. Barge-in is unavailable while a tool executes. At most five tools per session is recommended [S7]. Tool selection F1 is 82.5% but argument accuracy only 42.2% and Pass@1 33.0% on FDB v3 (V). Gemini Live 3.1 scored 81.7 / 58.8 / 54.0 on the same test [S7].
- **External LLM:** the model itself is not designed for a swappable LLM. But a companion paper shows a frontend-backend setup in which the duplex model emits `<tc_bos>`, speaks a short filler, streams user transcripts to a LangGraph ReAct backend (Qwen3-30B-A3B or Qwen3-235B-A22B), then has the backend's text prefilled into its text channel and repeats it. Filler latency was 0.72 to 0.80 s, but median latency to the real answer was 2.8 to 3.1 s (V) [S8].
- **Size, hardware, licence:** 11B. Supported GPUs are A100, H100, H200, B100, B200 and RTX-6000 on Linux under vLLM. On one H100 PCIe with 4 concurrent streams, p95 is 118 ms per 160 ms chunk (1.36x real time) (V) [S7]. No VRAM figure is published. Licence is OpenMDW v1.1 [S6]. It cannot run on a phone.
- **Other limits:** audio context of about two minutes. VoiceBench normalised average 55.1, level with Freeze-Omni, so its knowledge is well below a frontier text LLM [S7].
- **Independent check:** Artificial Analysis rated the early-access V1 at 77.8% Conversational Dynamics in March 2026 [S29], but its current leaderboard shows 52.9% for "Nemotron Voicechat" [S28]. This may be a different build or evaluation. Treat the number as unsettled.

### 2.3 Kyutai: Moshi and everything since, plus PersonaPlex

- **Moshi (2024-09-18 open release):** 7B Helium text LLM, Mimi codec at 12.5 Hz with 8 codebooks, a Depth transformer, and an "inner monologue" of time-aligned text before audio tokens. User and Moshi are parallel streams, with no explicit turns [S9].
  - Latency is 160 ms theoretical and about 200 ms practical on an L4 (V).
  - Training used 7M hours of audio, 2,000 hours of Fisher telephone conversations and synthetic instruct speech. It included noise augmentation and simulated echo of Moshi's own voice into the user microphone [S9].
  - Weights are CC-BY 4.0 and code is MIT/Apache. Variants are bf16/int8 (PyTorch, Rust/Candle) and int4/int8/bf16 (MLX). PyTorch recommends a 24 GB GPU. MLX is "for iPhone and Mac" per the README but is tested only on an M3 MacBook Pro. I found no verified iPhone build [S9].
- **Behaviour (independent):** Moshi interrupts on pauses (FDB v1 pause takeover about 0.98, S22). It produces unusable output on side talk and backchannels (FDB v1.5 "Unknown" rates 0.59 to 0.92). In 5 minutes of digital silence it started speaking spontaneously in 30% of continuations, via self-conditioning on its own non-speech outputs [S26]. Numbers vary a lot between papers because evaluation settings differ (compare S22 and S11 for the same model), so do not compare across papers.
- **Kyutai's newer work is not a Moshi 2.** The blog index (S14) shows the following since Moshi:
  - MoshiRAG (2026-04-30): Moshi emits a retrieval trigger and any OpenAI-compatible text LLM answers asynchronously. It is sensitive to retrieval delay over 3 s, needs about 24 GB of GPU, and has CC-BY weights [S12].
  - "Post-training speech models for better interactivity" (2026-06-10, arXiv 2606.11167): GRPO on Moshi and PersonaPlex with rewards per interaction axis (below).
  - Unmute (2025-05-22): cascade (Kyutai STT, any text LLM, Kyutai TTS) with a semantic VAD, discussed in section 4.
  - Pocket TTS and Hibiki-Zero are not relevant here.
- **RL post-training results (V; authors Ohashi, Zeghidour, Défossez, Kharitonov) [S11].** Rewards: pause = -1 if the model speaks over 1 s into the user's pause; turn-taking = minus the response delay; backchannel = F1 within ±1 s of human backchannels; interruption = minus the delay after the user's barge-in; plus an LLM-judge content score to stop quality collapsing. On FDB v1, Moshi pause takeover went from 0.445 to 0.226 (Fisher-trained RL) and interruption latency from 1.377 s to 0.461 s. PersonaPlex smooth turn-taking latency went from 0.219 s to 0.079 s. This shows the timing behaviours are directly optimisable once you write them as rewards.
- **PersonaPlex (NVIDIA, arXiv 2026-01-14) [S10].** Moshi architecture initialised from Moshi, plus a hybrid prompt (text role plus a spoken voice sample for zero-shot voice cloning). Fine-tuned on about 2,250 hours of synthetic dialogues plus 1,217 hours of Fisher in the released checkpoint. FDB v1 (V): smooth turn-taking takeover 0.992 at 0.070 s, interruption takeover 1.000 at 0.240 to 0.400 s, pause takeover 0.58 to 0.66, which is weak. Artificial Analysis rates it 91.0% Conversational Dynamics (I) but 12.6 to 19% on speech reasoning [S28]. A third-party estimate is 14 to 16 GB VRAM and a 4-bit MLX port is about 5.3 GB; I could not open the source for that. Sources disagree on its licence (NVIDIA Open Model License with MIT code vs MIT), and the HF page is gated, so check the licence text before relying on either.
- **Tool calling / external LLM:** none natively. MoshiRAG and KAME are the add-ons [S12, S13].

### 2.4 Sesame

- The open CSM-1B (Apache-2.0) is a speech generator, not full-duplex. Sesame's own page says CSM "can only model the text and speech content" and lists fully duplex models as future work. I found no 2026 Sesame full-duplex release [S33].
- Sesame's 2026 contribution is **TurnBench** (2026-08-28, SLT 2026) [S24], the best independent measurement of end-of-turn and interruption detection I found (section 3).

### 2.5 Other models that matter

| Model | How it decides | Interrupt / backchannel / noise | Latency | Size, licence, device | Tools / external LLM |
|---|---|---|---|---|---|
| **Seeduplex** (ByteDance, 2026-04-09) [S16] (V) | joint acoustic+semantic choice among start reply / keep listening / handle interruption; waits through hesitations | identifies the primary speaker, ignores side conversations and non-interactive sounds; backchannel generation is future work | endpoint latency -250 ms, interruption response -300 ms vs prior half-duplex | closed, size unstated, deployed in Doubao | not stated |
| **Qwen3.5-Omni** (Alibaba, ~Mar 2026) [S17] (V) | native "turn-taking intent recognition" | "semantic interruption": filters backchannels and background noise; API only | AA time to first audio 0.79 to 2.64 s [S28] | closed API | API tool calling |
| **Gemini 3.1 Flash Live** (Google, ~2026-03-26) [S32] | undisclosed | better at separating relevant speech from TV/traffic (V) | AA TTFA 0.96 to 2.99 s [S28] | closed API | yes |
| **MiniCPM-o 4.5** (OpenBMB, Apr 2026) [S18] | 1 s windows, listen/speak token first | training for interference exists (via Gander); FDB v1.5 results in S19 | TTFT 0.6 s; RTF 0.21 with llama.cpp-omni INT4 on RTX 4090 / DGX Spark | 9B, Apache-2.0, INT4 ~11 GB; Mac needs M4 Max 24 GB for full duplex; the HF card mentions an iOS demo, which the paper does not confirm | Qwen3-8B backbone; Gander adds an agent back end |
| **Raon-SpeechChat** (Krafton) [S19] | frame states SIL / onset / BOW / BC | FDB v1.5 backchannel Resume 0.398, background Resume 0.230, talking-to-others 0.150 (V): poor | FDB v1 smooth-turn latency 1.034 s | 9.8B, runs faster than real time on RTX 6000 Pro / L40S; licence unclear (paper shows CC BY-NC-SA) | not mentioned |
| **JoyAI-Talker** (Aug 2026) [S21] (V) | external 1.7B Joy-Duplex decoder, 5 state tokens per 160 ms | FDB v1.5: interruption respond 0.88, backchannel resume 0.96, talking-to-others resume 0.72, background resume 0.85 | no latency published | 48.9B-A3.3B MoE thinker plus 1.7B duplex model; weights not stated | thinker handles tools |
| **Realtime-Venus** (Ant) [S31] (V) | trained on proactive duplex trajectories | FDB v1.5: interruption respond 75%, continuation 97% (backchannel), 88% (other-directed), 86% (background) | none | two 9B models, open per list | async Harness for tools |
| **LFM2.5-Audio 1.5B** (Liquid) [S34] | turn-based interleaved s2s, not duplex | n/a | n/a | 1.5B, llama.cpp GGUF, LFM Open License; no phone build confirmed | none |

I found no full-duplex model under about 2B parameters running on a phone. The realistic phone design remains a small streaming ASR and TTS pair with a separate turn module.

## 3. Benchmarks: what they measure and how cascades fare

### 3.1 Catalogue

| Benchmark | Measures | Notes |
|---|---|---|
| **Full-Duplex-Bench v1** (ASRU 2025) [S22] | Pause handling (Candor, Synthetic): should not take over; Backchannel (ICC): TOR, frequency, JSD of timing vs humans; Smooth turn-taking: takeover rate and latency; User interruption: takeover rate, GPT-4o response quality, latency | Evaluates Moshi, dGSLM, Freeze-Omni, Gemini Live. Pre-recorded user audio. |
| **v1.5** [S22] | Overlap handling while the model is talking: user interruption, user backchannel (should continue), talking to others (far-field, should continue), background speech (should continue). Labels: Respond / Resume / Uncertain / Unknown; stop latency; response latency | Includes GPT-4o Realtime, Gemini, Nova Sonic |
| **v2** [S22] | Multi-turn, live examiner (gpt-realtime) that interrupts and backchannels; Daily / Correction / Entity / Safety; LLM-judged turn-taking fluency | Cascades not evaluated |
| **v3** [S22] | Tool use with real disfluent human audio (filler, pause, hesitation, false start, self-correction); Pass@1, tool selection, argument accuracy, turn-take rate, interruption rate, filler rate, latency | Includes a Whisper, GPT-4o, TTS cascade |
| **Artificial Analysis Conversational Dynamics** [S28] | A subset of FDB v1 and v1.5 as one percentage per model | Removed from their index in v2.0 (Aug 2026) and replaced by task success |
| **HumDial, ICASSP 2026** [S23] | 100-plus hours of real human dual-channel recordings (zh and en); interruption (follow-up, negation, repeat request, topic switch, stop) vs rejection (backchannel, mid-sentence pause, third-party speech, speech to others); score = 0.4 Interruption + 0.4 Rejection + 0.2 delay | Cascaded entries competed directly |
| **TurnBench (Sesame)** [S24] | End-of-turn and interruption detection: recall at a false-positive cap (0.15), signed latency at p10/p50/p90; 30 h of studio dialogue in six conversation styles | 25 systems on the leaderboard; English only, studio recordings |
| **SID-Bench / APT** [S29] | Semantic interruption detection; Average Penalty Time charges both false alarms and late responses | LLM-based detector reports about 3x lower APT (V) |
| FD-Bench, MTR-DuplexBench, Talking Turns, Game-Time, Instruct-FD [S1] | FD-Bench: interruption handling with noise; MTR: multi-round consistency; Talking Turns: supervised judge of turn events (systems rarely backchannel, some interrupt too aggressively); Game-Time: temporal constraints | Mostly confirm the same gaps |

### 3.2 Evidence on cascade vs e2e

**Where a modular system wins or ties**
- **HumDial (S23, independent challenge):**

| Entry | Type | Interruption | Rejection | Delay | Final |
|---|---|---|---|---|---|
| Cookie ASR | cascade | 79.3 | 72.2 | 1.26 s | 76.6 |
| Badcat | semi-cascade (Qwen3-Omni as Switch/Continue judge) | 89.7 | 57.8 | 1.63 s | 73.5 |
| SenseDialog | semi-cascade | 76.4 | 60.9 | 1.24 s | 71.0 |
| Lingcon Insight | e2e | 67.6 | 38.9 | 1.13 s | 59.2 |
| HelloWorld | e2e | 51.3 | 36.3 | 0.62 s | 55.0 |
| Gemini-2.5 (closed, unranked) | e2e | 79.8 | 36.5 | 1.30 s | 62.3 |
| Freeze-Omni / Moshi | open e2e | 29.6 / 35.4 | 50.2 / 22.8 | 2.58 / 2.88 s | 43.8 / 34.5 |

  Rejection (staying quiet for backchannels, third parties and noise) is where cascades won. Caveats: the entrants were specialised teams tuning to this exact distribution, the e2e entries were small-team fine-tunes and not GPT-Live, and the winning cascades spent 0.6 s more than the fastest e2e.
- **TurnBench (S24):** on end-of-turn, recall at false-positive rate (FPR) and median latency:

| System | EOT recall / FPR | Latency |
|---|---|---|
| VAP (voice activity projection) | 0.845 / 0.055 | 368 ms |
| Mimi endpointer | 0.782 / 0.078 | 645 ms |
| Kyutai semantic VAD | 0.773 / 0.059 | 1007 ms |
| Smart Turn v3 | 0.752 / 0.047 | 1017 ms |
| Gemini 3.1 Live | 0.657 / 0.022 | 1234 ms |
| OpenAI Realtime semantic VAD | 0.303 / 0.018 | 793 ms |
| Moshi | 0.233 / 0.044 | 702 ms |
| OpenAI server VAD (silence) | 0.955 / 0.525 | 282 ms |
| RMS energy VAD | 0.718 / 0.632 | -117 ms |

  External leaderboard submissions reach 0.96 to 0.98 recall at FPR 0.07 to 0.08 with 254 to 595 ms (OpenYap Turn, Neosapience Nunchi v2, Tavus Sparrow-2 and others). Their internals are not given on the leaderboard page, and I could not confirm whether any is open. Humans start speaking a median 151 ms before the other turn ends, and no in-budget system matches that. Moshi, Gemini and OpenAI appear only on the end-of-turn track because the interruption track cannot yet score a system that is also generating audio.
- **JoyAI-Talker (V, S21):** a modular system with a 1.7B duplex gate reports FDB v1.5 interruption respond 0.88 vs 0.77 for Gemini 3.1 Live, with backchannel resume 0.96.
- **FireRedChat (V, S30):** a cascade with a target-speaker VAD (pVAD) and a 170M BERT end-of-turn model reports false barge-in 10.2% (T90 170 ms), against 33.4% for LiveKit and 78.1% for TEN. The same table puts end-of-turn accuracy at 96.0% (zh) and 94.9% (en) against 70.8% and 86.2% for LiveKit. Its median end-to-end latency was 2.3 s with a real LLM, against 3.6 s for LiveKit.
- **FDB v3 (S22):** the Whisper-GPT-4o-TTS cascade never failed to answer (100% turn-take), but it was slowest (10.1 s mean, mostly first-word delay) and scored lowest on self-correction (Pass@1 0.176 vs GPT-Realtime 0.588) because committed transcripts and early tool calls lock in outdated values. This matters for our "continue" rule: it is a real weakness of commit-then-answer, so keep the answer cancellable.

**Where e2e wins**
- Latency and overlap: Moshi/PersonaPlex respond within 0.07 to 0.25 s (V). GPT-4o Realtime stops within 0.23 s of an interruption (S22). Open e2e models and Gemini lose on pause handling and rejection, as above.
- Frontier closed systems (GPT-Live, Gemini 3.x, Seeduplex, Qwen) are reported best on the combination of low latency and rejection, but the evidence is vendor-reported, and the independent AA metric is saturated at 92 to 99% for many commercial models [S28].
- **FDB v1.5 shows an unavoidable trade-off** (S22): "responsive" systems (GPT-4o: stop 0.23 s, Respond 0.78) also respond to 91 to 93% of side talk and background speech. "Floor-holding" systems (Gemini, Sonic) filter well (Resume 0.90 to 0.99) but take over 2 s to stop for a real interruption.

**What e2e models actually do about turn-taking (important)**
- "Full-duplex speech models take the floor when asked, not when needed" (S25, 2026-09-17, independent, 5 pages) tested Moshi, PersonaPlex, VoiceChat, MiniCPM-o 4.5 and Raon on 40 monologues with controlled pauses. The models start speaking when directly addressed or when silence appears (PersonaPlex onset 0.10 to 0.83 with 1.5 s of silence). They barely react to false facts, hazards or other content cues. Rhetorical questions and "that's all from me" followed by continued talking do nothing. Even with the floor, only 14 to 15% of false-fact replies challenged the claim.
- VoiceChat and MiniCPM-o 4.5 almost never start during continuous speech (onset about 0) and start mainly after inserted silence (0.20 and 0.98). Raon-SpeechChat speaks near-continuously.
- Reading: open e2e "turn-taking" is largely a learned silence-plus-address detector, which is the same signal a good semantic end-of-turn model uses. The remaining e2e advantage is that it does this in one pass at 80 ms resolution and sees the assistant's own state.

**Verdict.** On turn-taking decisions a well-built cascade is competitive with every open e2e model and plausibly with closed ones on rejection. What a cascade cannot easily match is the combination of sub-second response, in-turn backchanneling and overlap. Our pipeline's complaints (too slow, cuts people off, noise barge-in) come from the design of the decision rules (silence-triggered polling, binary acoustic-only end-of-turn, no semantic reject class), not from being a cascade.

**Benchmark hygiene:** the same model scores very differently across papers (Moshi pause takeover is 0.985 in S22 and 0.445 in S11; VoiceChat conversation dynamics is 77.8% and 52.9% on AA). Always re-run on our own audio.

## 4. What turn-taking knowledge a cascade can borrow

1. **Decide every frame, with a probability, not on silence.** Moshi-family models emit a token every 80 ms. Duplug/Joy-Duplex use 160 ms chunks; X2-Turn gives a turn state every 80 ms; Gradium and Kyutai's semantic VAD emit an inactivity probability every 80 ms inside the ASR stream, with an adaptive pause delay based on content and intonation [S14, S30]. Turn-1-mini (5.3M, Apache-2.0) outputs P(end of turn) per 20 ms frame [S30]. The mechanism that replaces "500 ms of silence, then ask" is a continuous score plus hysteresis (several consecutive frames above threshold).
2. **Joint audio and text, multi-class.** Every recent turn model predicts more than one bit: complete / incomplete / backchannel / (wait or idle), and Joy-Duplex adds accept / reject (addressed to the assistant or not) [S21, S30]. On Easy-Turn, X2-Turn and SoulX-Duplug beat Smart Turn v3 on incomplete-turn accuracy (X2-Turn 93.0 vs 60.0 zh, 84.6 vs 72.2 en), with 205 to 295 ms latency (V, S30). In FastTurn's test Smart Turn reached 49% accuracy against 80% for its own model (V).
3. **Predict the end before it happens, and act speculatively.** Humans respond about 200 ms after a turn ends, planning a word takes about 600 ms, and listeners start 151 ms early [S24]. Endpoint Anticipation (EPA, 25M parameters on Mimi features, horizons 320 ms to 2.56 s, S15) triggers the LLM and TTS early on partial context, caches the audio, and discards it if the user continues. In Unmute it cut average latency from 1195 to 690 ms at 28% redundant compute (V). It reported a median anticipation of 640 ms against 160 ms for VAP at similar redundant compute.
4. **Causal labels.** "The trade-off was in the labels" (S30) argues that end-of-turn labels from offline corpora leak future information. Its causal rule is to emit end-of-turn only when the words so far are complete and at least 0.3 s of silence has been heard. With that rule a Qwen3-ASR-0.6B + LoRA prototype got 0.97 boundary recall at 0.39 s p50 and 0.3 false fires per minute, which the authors say no silence timeout matches (V). It is a prototype trained on about 20k synthetic examples. This is also the diagnosis for Parakeet-EOU's lost words after a mid-sentence EOU.
5. **Backchannel as a first-class class.** Used as a user-side class to avoid false barge-in or false end-of-turn: VoiceChat's training injects "uh-huh" into the user stream [S7]; Raon has a separate BC token [S19]; Duplug/FastTurn/X2-Turn have backchannel states [S30]. TurnBench shows backchannel-heavy casual talk is the hardest case for interruption false positives [S24].
6. **Assistant's own speech state as input.** Moshi has the assistant's audio as a stream and was trained with simulated echo of itself [S9]. The Self-Listening paper (S27) feeds the audio that was actually played back as a third stream with a `<silence>` token when nothing plays. After a roughly 400 ms reaction window it emits `<overlap>/<stop>/<continue>/<wait>`. Its model could answer "where did I stop?" correctly 73.0% of the time, against 43.8% for GPT-Realtime-2.1, 30.3% for Gemini and 2.2% for Moshi (V). It did not study acoustic echo. Our played-sample clock already provides the data this needs.
7. **Counterfactual check against spurious onsets.** S26 proposes asking whether a decision survives when the latest user audio is replaced by silence (compare next-token distributions). That removes 97 to 99% of spurious onsets in Moshi/PersonaPlex at 99% preservation of genuine responses, within the 80 ms frame budget. The same idea can test whether a barge-in candidate is explained by the TTS reference signal alone (my adaptation, untested).
8. **Optimise timing with explicit rewards.** Kyutai's four rewards (pause, turn latency, backchannel F1, interruption latency) translate into a threshold-tuning objective over logged conversations. SID-Bench's Average Penalty Time and TurnBench's "recall at FPR cap" are ready-made versions [S11, S24, S29].
9. **Separate "whether to speak" from "what to say"** (MiniCPM-o's control token first, Diffuplex, DuplexJev, Joy-Duplex) [S18, S31]. A small gate can run at 100 ms cadence while the big model runs at its own pace. DuplexJev reads decisions as single-token distributions from a frozen LLM, about 80 decisions in 0.1 s on 8 GPUs [S31].
10. **Voice layer plus delegate.** GPT-Live, Realtime-Venus, Gander, VoiceChat's `ack_message` and the frontend-backend paper all separate a fast conversational layer from a slow reasoner, with spoken acknowledgments while the reasoner works [S4, S7, S8, S20, S31].

## Takeaways for our pipeline (ranked)

1. **Replace the silence-triggered, audio-only Smart Turn poll with a continuous joint audio+text turn-state score, and tune it against a false-cut-off budget.**
   - What to try: run a streaming turn model every 80 to 160 ms with hysteresis, alongside the existing VAD and partial transcript. Output classes: complete / incomplete / backchannel / idle. Compare candidates offline on our own recordings and on the TurnBench dev split: Smart Turn v3.2 (baseline), turn-1-mini (5.3M, Apache-2.0, audio only, cheapest), a JAL-Turn or SoulX-Duplug-style model that reads partial ASR text, Kyutai STT's semantic VAD (1B, Rust server), and a VAP-style model. Check licences first (X2-Turn and Duplug state none on their pages; TurnBench data is non-commercial).
   - Should fix: "too slow" (S24 suggests a 2 to 3x latency gain at equal false positives) and "cuts people off / ends on a breath" (the semantic class sees incomplete clauses). Evidence is independent-ish (Sesame's benchmark) but the 1017 ms Smart Turn figure depends on the benchmark's wrapper, so measure it ourselves.
2. **Make the commit decision conservative but the response speculative.**
   - What to try: at a moderate EOT probability (an anticipation horizon of 500 to 1000 ms), prefill the LLM with the transcript and optionally prepare the first TTS clause. Commit only at the high threshold. Reuse the existing cancel-on-continue branch. No tool calls or other side effects before commit.
   - Should fix: perceived latency without more cut-offs. EPA reports 505 ms saved at 28% redundant compute (V). FDB v3's self-correction failures are the reason to keep side effects out of speculation.
3. **Make interruption handling graded, semantic and two-stage, tuned for time-to-correct-decision.**
   - What to try: any speech while the assistant plays means duck immediately. At about 300 to 500 ms, pause playback. Stop only when a classifier on the partial transcript plus the clause being played confirms an interruption (not backchannel, not other-directed, not echo of our own TTS text). Add the TTS reference/AEC-residual level as a feature. Report an APT-style cost (false-alarm cost plus lateness cost) instead of single thresholds.
   - Should fix: noise, TV and echo barge-ins and missed real interruptions. TurnBench shows fast committers (Smart Turn v3 interruption recall 0.107, OpenAI server VAD 0.458 FPR) cannot discriminate, while slower ones (VAP, Mimi, about 1 s) can. FDB v1.5 shows there is no free lunch between stop speed and rejection. Our 700 ms hold fits that shape but should be driven by semantics, not word counts.
4. **Add an explicit addressee/reject class, as a classifier fed by the speaker-verification score and the transcript, not just a speaker gate.**
   - What to try: a tiny model with inputs (partial text, speaker-verification score and its duration, whether the assistant is speaking, recent turns) and outputs accept / reject / backchannel, as in Joy-Duplex. Optionally add a target-speaker VAD ahead of barge-in (FireRedChat reports false barge-in 10.2% with its pVAD vs 33% with LiveKit, V). Treat the "Audience" model idea as the same slot.
   - Should fix: TV and bystander turns that get past the 1 s verification floor. HumDial shows rejection is where systems lose most (Gemini-2.5 36.5 vs 72.2 for the winner). No open e2e model is better here: Raon background-speech Resume is 0.23 and VoiceChat lists competing speech as a weakness.
5. **Stop trusting the Parakeet `<EOU>` token as a turn signal.**
   - What to try: keep it as a weak feature only. If a streaming ASR with a turn marker is wanted, train or adapt it with causal labels (S30), or use an ASR whose end-of-turn head is trained jointly (Kyutai STT, X2-Turn). Either route must be validated on word loss.
   - Should fix: lost and duplicated words after mid-sentence EOU, which corrupts the Fluid Speech Mini re-transcription handoff.
6. **Build an internal replay benchmark before the next round of tuning.**
   - What to try: record or synthesise cases in FDB v1/v1.5 and HumDial categories (pauses, backchannels, interruptions, talking to others, background/TV, self-corrections). Report takeover rate, rejection rate, response and stop latency, and false cut-offs per speech-minute at a fixed false-positive cap. Use TurnBench dev for end-of-turn and interruption detection as an outside reference.
   - Should fix: the oscillation between "too fast" and "too slow", because every change is currently judged by feel. Also gives a way to compare any future e2e candidate with the same numbers.
7. **Add a fast voice layer in front of the agent thread, for acknowledgments, not for answers.**
   - What to try: a spoken filler or acknowledgment when the agent decides to retrieve or call tools (like VoiceChat's `ack_message` or GPT-Live's delegation). Keep the main text agent as the single source of answers and citations. Keep end-of-session and hard-stop commands deterministic, since GPT-Live users report the voice layer skipping end-of-session tools [S4].
   - Should fix: dead air during retrieval, which any improvement in end-of-turn timing cannot remove.
8. **Use open e2e models only as a reference and teacher, not as the phone path.**
   - What to try: when a GPU is available, run VoiceChat 11B (OpenMDW, vLLM, one H100 for several streams) or PersonaPlex or MiniCPM-o 4.5 on our recorded test conversations and read their frame-level speak/stay-silent probabilities as a reference decision to compare with our pipeline. If a GPU voice tier is ever allowed, the frontend-backend pattern (S8) is the shape: duplex front end, our text agent behind it. Its cost is 2.8 to 3.1 s to the real answer on tool turns, two-minute audio context, no barge-in during tool execution, and weak noise robustness.
   - Should fix: nothing directly in production. It tells us how far the pipeline is from the e2e ceiling on our own audio.
9. **Do not expect e2e to solve speaker separation.** Open e2e models have no target-speaker mechanism. Only closed systems (Seeduplex, GPT-Live, Gemini, Qwen) claim one, with vendor-reported evidence. Continue investing in personal VAD and speaker verification, and consider session-adaptive profile updates.

## Unknowns and caveats

- GPT-Live primary pages were not readable (HTTP 403). Its mechanism, size and noise handling are undisclosed.
- Gemini, Qwen and Seeduplex internals are unpublished; all comparative claims there are vendor-reported.
- Phone viability of Moshi-class or MiniCPM-o 4.5 on iPhone is unverified (the repos suggest MLX or an iOS demo, but I found no measured iPhone numbers).
- The Artificial Analysis page lists models whose names I could not verify elsewhere (for example a "Gemini 3.8 Live"); I excluded them from conclusions.
- Licences for PersonaPlex, Raon-SpeechChat, X2-Turn, SoulX-Duplug and Gander are unconfirmed.
- Many papers cited are 2026 preprints without peer review.

## Sources (fetched 2026-10-22; dates are publication or release dates)

- S1 Awesome-Full-Duplex-SDM README: https://github.com/Ruiqi-Yan/Awesome-Full-Duplex-SDM
- S2 VentureBeat, GPT-Live launch, 2026-07-08: https://venturebeat.com/technology/openai-launches-gpt-live-a-full-duplex-voice-upgrade-that-lets-chatgpt-talk-more-like-a-person
- S3 TechCrunch, 2026-07-08: https://techcrunch.com/2026/07/08/openai-releases-new-voice-models-for-more-natural-live-conversations/
- S4 OpenAI developer community, GPT-Live-1 in the API, 2026-09-10 (mirrors OpenAI's API post https://openai.com/index/introducing-gpt-live-1-in-the-api/, not readable): https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471
- S5 Secondary GPT-Live analyses: https://blog.buildfastwithai.com/gpt-live-review-openai-voice-model-july-2026 ; https://www.digitalapplied.com/blog/openai-gpt-live-voice-models-customer-experience-2026 ; https://blog.risingstack.com/chatgpt-live-new-architecture-of-voice-ai/ ; https://mlq.ai/news/openai-launches-gpt-live-1-a-full-duplex-voice-model-that-listens-and-speaks-simultaneously/
- S6 VoiceChat model card, 2026-08-03: https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B
- S7 VoiceChat paper, 2026-09-18 (v2 2026-10-01): https://arxiv.org/abs/2609.21967
- S8 Frontend-backend tool calls for full-duplex models, Sep 2026: https://arxiv.org/abs/2609.19334
- S9 Moshi paper (2024-10) and repo: https://arxiv.org/abs/2410.00037 ; https://github.com/kyutai-labs/moshi
- S10 PersonaPlex, 2026-01-14: https://arxiv.org/abs/2602.06053
- S11 Multi-Faceted Interactivity Alignment (Kyutai), 2026-06-10: https://arxiv.org/abs/2606.11167
- S12 MoshiRAG, 2026-04-30: https://github.com/kyutai-labs/moshi-rag ; https://arxiv.org/abs/2604.12928
- S13 KAME (ICASSP 2026): https://arxiv.org/abs/2510.02327
- S14 Kyutai blog index and Unmute: https://kyutai.org/blog/ ; Gradium semantic VAD notes (vendor): https://gradium.ai/content/semantic-vad-voice-agents-turn-detection-2026
- S15 Endpoint Anticipation for Low-Latency Spoken Dialogue, Jun 2026: https://arxiv.org/abs/2606.13450
- S16 Seeduplex, 2026-04-09: https://seed.bytedance.com/en/blog/introducing-seed-full-duplex-speech-llm-attentive-listening-robust-interference-suppression-enabling-more-natural-interaction
- S17 Qwen3.5-Omni blog, ~Mar 2026 (only found via search summary): https://qwen.ai/blog?id=qwen3.5-omni
- S18 MiniCPM-o 4.5, Apr 2026: https://arxiv.org/abs/2604.27393 ; https://huggingface.co/openbmb/MiniCPM-o-4_5
- S19 Raon-Speech technical report, 2026: https://arxiv.org/abs/2605.23912
- S20 Multimodal Duplex Interaction Agent (Gander), Sep 2026: https://arxiv.org/abs/2609.08977
- S21 JoyAI-Talker, Aug 2026: https://arxiv.org/abs/2608.01119
- S22 Full-Duplex-Bench v1 https://arxiv.org/abs/2503.04721 ; v1.5 https://arxiv.org/abs/2507.23159 ; v2 https://arxiv.org/abs/2510.07838 ; v3 (Apr 2026) https://arxiv.org/abs/2604.04847
- S23 HumDial ICASSP 2026 challenge study, Apr 2026: https://arxiv.org/abs/2604.21406
- S24 TurnBench, 2026-08-28: https://arxiv.org/abs/2608.25218 ; https://www.sesame.com/journal/turnbench ; https://turnbench.sesame.com
- S25 Take the floor when asked, not when needed, 2026-09-17: https://arxiv.org/abs/2609.19596
- S26 Spurious onsets in full-duplex speech LLMs, Sep 2026: https://arxiv.org/abs/2609.13445
- S27 Self-Listening for full-duplex models, Sep 2026: https://arxiv.org/abs/2609.05592
- S28 Artificial Analysis speech-to-speech leaderboard and methodology: https://artificialanalysis.ai/speech-to-speech ; https://artificialanalysis.ai/methodology/speech-to-speech-benchmarking
- S29 Artificial Analysis VoiceChat note, 2026-03-13: https://artificialanalysis.ai/articles/nemotron-3-voicechat-leader-speech-pareto ; SID-Bench: https://arxiv.org/abs/2603.24144
- S30 Turn components: X2-Turn https://arxiv.org/abs/2608.10878 ; SoulX-Duplug https://arxiv.org/abs/2603.14877 ; FastTurn https://arxiv.org/abs/2604.01897 ; JAL-Turn https://arxiv.org/abs/2603.26515 ; FireRedChat https://arxiv.org/abs/2509.06502 ; X-Talk https://arxiv.org/abs/2512.18706 ; turn-1-mini https://huggingface.co/p99lab/turn-1-mini ; causal supervision for turn-aware ASR https://arxiv.org/abs/2609.04225
- S31 Other models: Decoupled FSM https://arxiv.org/abs/2609.03321 ; D2 https://arxiv.org/abs/2610.17124 ; DuplexJev https://arxiv.org/abs/2610.02638 ; Realtime-Venus https://arxiv.org/abs/2609.13814 ; BayLing-Duplex https://arxiv.org/abs/2606.14528 ; Diffuplex https://arxiv.org/abs/2610.17780 ; Context Spanning https://arxiv.org/abs/2609.33443 ; DuplexOmni https://arxiv.org/abs/2606.09186
- S32 Gemini 3.1 Flash Live (preview docs and coverage, ~2026-03-26): https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview ; https://datanorth.ai/news/google-releases-gemini-3-1-flash-live-real-time-multimodal-voice-model-for-ai-agents
- S33 Sesame research page (CSM): https://www.sesame.com/research
- S34 LFM2.5-Audio 1.5B: https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B
