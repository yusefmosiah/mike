# Speaker separation and primary-speaker focus for a realtime voice assistant (state of the art, 22 Oct 2026)

Researcher 5 of 6. Scope: personal and foreground VAD, target-speaker extraction (TSE) and ASR, commercial and platform options, streaming diarization, addressee detection, full-duplex handling of other speakers, and short-segment speaker verification (SV).

How to read the numbers. [V] means vendor-reported, [A] means reported by the paper's authors on their own data, [I] means independent or third-party. Almost nothing here is independent. Many paper figures were read through page-summarising fetches rather than the PDFs, so re-check any number you intend to build a decision on. No source I found tests a living-room TV at 0 dB through a phone microphone. Every effect estimate in the takeaways is my judgement, not a measurement.

## 0. Summary

1. The cheapest structural fix is a speaker-aware frame-level VAD in front of the turn manager, so TV audio cannot open or hold a turn. That is the one failure post-hoc verification cannot fix. Personal VAD (pVAD, Google) models are 0.13 to 1.1 M parameters, with Apache-2.0 reproductions. A September 2026 Foreground VAD paper (0.6 M parameters) reports far lower background false alarms than Silero but has no released code and was never tested with a TV at 0 dB. Plan to train our own on TV-like data.
2. Target-speaker extraction is not ready as a front end: on real conversational recordings the best online systems in the SLT 2026 REAL-TSE challenge score a token error rate of about 0.70.
3. No commercial option fits the privacy remit plus an in-app iPhone build. Krisp's primary-speaker isolation is server-side; ai-coustics is on-device but keyed to its backend with telemetry and has no documented iOS binding; Apple's Voice Isolation mic mode cannot be set by an app, and the public `AUSoundIsolation` unit is not speaker-aware.
4. Streaming diarizers label by arrival order, not identity, and were benchmarked on meetings. FASTDIAR (MIT, an 80 ms causal ReDimNet2 embedding) is a better building block than a 100 M diarizer.
5. Pipecat's "Audience" is a text classifier for game-character dialogue, not an acoustic addressee detector.
6. Short-segment SV has a hard floor (mean EER 31.2% at 0.5 s, 4.7% at 3 s across 18 public checkpoints). Gains come from not forcing a 1 s decision: accumulate evidence, mask to user frames, calibrate by duration, defer.
7. No full-duplex model handles bystanders well; the best rejection score in the ICASSP 2026 HumDial challenge is 72.2%, from a cascaded system.

## 1. Framing: three problems, three signals

Our complaint ("TV holds a turn open or triggers VAD") mixes three problems, each needing a different signal.

| Problem | Needed signal | Our current coverage |
|---|---|---|
| Is this frame the user's voice? | Frame-level, causal, conditioned on enrolment or on foreground dominance | None. Silero hears any speech |
| Whose turn was this? | Turn-level identity with calibrated uncertainty | WeSpeaker + CAM++ after the fact |
| Was it meant for the assistant? | Text, prosody, context, optionally gaze | None |

Post-hoc SV only addresses the second. It cannot stop a TV keeping the VAD "in speech", so end-of-turn timers never start. It also cannot score a user-plus-TV mixture, where the embedding is a blend of both voices.

## 2. Personal VAD, target-speaker extraction, target-speaker ASR

### 2.1 Personal and foreground VAD

| Item | Facts | Size / licence / availability |
|---|---|---|
| pVAD 1.0 (Google, [arXiv 1908.04284](https://arxiv.org/abs/1908.04284), 2019) | Frame classes: non-speech, target speech, non-target speech. The enrolment-embedding ET variant has about 130 K parameters (130 KB at 8 bit). Target-speech AP with multistyle training: 0.878 (ET) to 0.938 (SET, which needs a 4.88 M speaker network at runtime), against 0.777 for a separate VAD + SV cascade [A, proprietary data]. | Paper only. The paper's own Appendix C reproduction reports target-speech AP 0.943 (ET, no multistyle) on Multilingual LibriSpeech (MLS) |
| pVAD 2.0 (Google, [Interspeech 2022](https://arxiv.org/abs/2204.03793)) | Better embedding modulation (FiLM), an enrolment-less training mode, runtime optimisations. | Paper only |
| [wq2012/personal_vad](https://github.com/wq2012/personal_vad) (accessed 22 Oct 2026) | 13 pretrained v1 and v2 models (LSTM and causal Conformer, FiLM, a unified enrolment-optional model); INT8 TFLite 0.2 to 1.4 MB, up to about 1.09 M parameters, streaming with explicit state. Trained on 8-language MLS with a tiny speaker encoder from 98 speakers. Reported mAP 0.88 clean, 0.72 multistyle; speaker-verification ROC-AUC 0.945 [A]. | Apache-2.0. No ONNX. A template, not a drop-in |
| [fclearner/Personal-vad-2.0](https://github.com/fclearner/Personal-vad-2.0) | PyTorch pVAD 2.0 with FiLM. Weights unconfirmed. | Licence not checked |
| Foreground VAD / Mamba-FVAD ([arXiv 2609.19856](https://arxiv.org/abs/2609.19856), 17 Sep 2026) | "Foreground" is the speaker with the most sustained presence, with no enrolment. About 0.6 M parameters, 1,128 h of Japanese call-centre speech plus LibriSpeech, competing-speaker mixing (1 to 3 interferers, 0 to 15 dB, p = 0.2). On a mixed-interference set at 9 to 17 dB: foreground F1 0.88 to 0.92, BG-FAR 0.05 (17 dB) rising to at most 0.40 (9 dB), against Silero above 0.8 at the loudest interferer. An enrolled pVAD baseline held BG-FAR flat near 0.23 but had much lower foreground F1. On the VOiCES far-field set (with TV and babble noise), BG-FAR was 0.06 music, 0.07 telephone, 0.12 babble against Silero 0.12, 0.18, 0.27 [A]. | No code or weights stated. The recipe (foreground-only labels, competing-speaker mixing, a BG-FAR metric) is simple to replicate. Latency claim conflicts: 1 to 2 ms per frame on CPU in the abstract, 11 to 22 ms on a t2.micro in the text |
| ICASSP 2026 short-enrolment pVAD ([arXiv 2601.12769](https://arxiv.org/abs/2601.12769), 19 Jan 2026) | Adds key-frame embeddings from the mixed speech to the enrolment embedding and refines it during detection. Reports performance matching full-length enrolment after five updates [A]. | No release found |

What the foreground paper says about failure: it under-fires when the target is not dominant, and a louder sustained masker "inverts the dominance cue" and suppresses the true speaker. It did not analyse TV as a case and assumes a single foreground speaker. An enrolment-free foreground model is not the answer to "TV at the person's level". Enrolment plus dominance, in one unified model like pVAD 2.0, is the sensible combination.

A caution on the pVAD numbers. They come from LibriSpeech-style mixtures where the non-target is another read-speech talker. Broadcast speech with music and compression, played through a loudspeaker into a room, is a different distribution. None of the pVAD papers test it, so the model has to be trained on it.

### 2.2 Target-speaker extraction (TSE)

| System | Status | Verdict |
|---|---|---|
| VoiceFilter-Lite (Google, [blog, 11 Nov 2020](https://research.google/blog/improving-on-device-speech-recognition-with-voicefilter-lite)) | 2.2 MB quantised, d-vector conditioned, adaptive suppression strength. 25.1% WER improvement on overlapping speech, 14.7% on reverberant overlap [A]. | Google never released it. I found no open reimplementation of the Lite model |
| TargetVoice ([Interspeech 2025](https://www.isca-archive.org/interspeech_2025/pallala25_interspeech.pdf)) | Edge-targeted: about 10 ms latency, 10 MB speaker encoder, 3 s enrolment, 8 to 10 dB SI-SDR improvement [A, from a search summary]. | No code found |
| SpeakerBeam-SS ([Interspeech 2024](https://www.isca-archive.org/interspeech_2024/sato24_interspeech.pdf)) | Streaming Conv-TasNet with state-space modelling. RTF down 78% at matched quality [A]. | Research |
| [StarTSE](https://arxiv.org/abs/2604.19635) (Apr 2026), [stability-plasticity](https://arxiv.org/abs/2609.20463) (Sep 2026) | Streaming TSE research. Abstracts only read. | Research |
| [WeSep](https://github.com/wenet-e2e/wesep) (Apache-2.0, README updated 21 Sep 2026) | BSRNN, DPCCN, TF-GridNet. Pretrained packages, ONNX export and streaming listed as coming or unchecked. | Training toolkit |
| [REAL-TSE](https://arxiv.org/abs/2607.15198) challenge (SLT 2026, [leaderboard](https://real-tse.github.io/challenge)) | Real Mandarin and English conversational recordings. Online track capped at 100 ms. Causal BSRNN baselines: TER 0.81 to 0.84, speaker similarity 0.37 to 0.39 on unseen EVAL-2. Best online systems: TER 0.699 to 0.719, similarity 0.45 to 0.52. | Closest thing to an independent reality check. TSE fails on real audio |

Verdict: do not put a TSE model between the microphone and the ASR for launch. It is not deployed, not licensed, and in real conversational audio it removes target speech as much as it removes interference. Revisit when REAL-TSE winners publish weights.

### 2.3 Target-speaker ASR

NVIDIA's multitalker Parakeet ([model card](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1), nvidia-open-model-license) is about 600 M parameters, needs one instance per speaker, takes a Sortformer diarization output as its only speaker input, and has no enrolment. In single-speaker mode it is slightly worse than the base model (7.44 vs 7.16 WER). Streaming TS-RNNT ([arXiv 2501.15466](https://arxiv.org/abs/2501.15466)) and a September 2026 unified text+enrolment cue paper ([arXiv 2609.33853](https://arxiv.org/abs/2609.33853), non-streaming, 8.80% CER) are research only. None is a candidate for a 120 M Parakeet EOU + Core ML stack.

## 3. Commercial and platform options

| Option | What it does | In-app on iPhone? | Privacy / licence / cost | Evidence |
|---|---|---|---|---|
| Krisp VIVA 2.5 Voice Isolation ([page](https://krisp.ai/developers/voice-isolation/), VIVA 2.0 [launched 6 May 2026](https://lasvegassun.com/news/2026/may/06/krisp-launches-viva-20-introducing-voice-infrastru/)) | Removes background noise and non-primary voices. Four variants; Lite is about a third of the compute. Also Turn Prediction and Interruption Prediction (about 6 M parameters, English only at launch). | Listed SDKs: Python, Node.js, Go, iOS; marketed as server-side, so on-device iOS use is not confirmed. Request access, no public price. | SDK on request; needs a sales conversation | [V] 46% fewer word errors overall (15.3 to 8.2%), 70% on background voices (35.9 to 10.9%), 1,685 recordings, 10 STT engines. Clean-audio penalty 2.15 vs 2.10% WER. No false-interruption figures given |
| Krisp through LiveKit ([docs](https://docs.livekit.io/transport/media/noise-cancellation/)) | Frontend BVC (background voice cancellation) is web JS only; Swift and Android get standard NC only. Agent-side voice isolation runs on LiveKit Cloud at extra cost. | No (not BVC) | Cloud | Docs say NC "applies to outbound audio before it is sent to the room" |
| ai-coustics Quail Voice Focus 2.2 and VAD Voice Focus 2.0 ([docs](https://docs.ai-coustics.com/guides/models), [blog](https://ai-coustics.com/blog/quail-voice-focus-2.1)) | Isolates the primary speaker; the dedicated VAD "targets primary-speaker activity". L: 20.9 MB, S: 5.3 MB, 15 ms blocks, about 30 ms latency, 16 kHz. Docs recommend near-field, single-user use (headsets, handhelds). Mechanism for choosing the primary speaker undocumented; docs list "startup context" and "changes in speaker prominence" as things to evaluate. | Bindings: Python, Node, Rust, C, C++, WASM. No Swift or Android binding found. SDK page claims mobile. | Key authorises online with telemetry; offline use needs a separate licence. Tiers from $150/month | [V] WER 65.8 to 12.5% (Speechmatics), 48.3 to 15.1% (AssemblyAI), mostly fewer insertions. The post's dates are inconsistent (Apr 2026 byline vs 22 Oct 2026 metadata) |
| Apple Voice Isolation mic mode ([support](https://support.apple.com/en-us/101993)) | System setting "Prioritizes your voice and blocks ambient noises". Third-party apps on iOS 15+; recording apps iOS 26+. | Not controllable. An Apple engineer (Developer Forums, Jun 2026): "Mic mode is, by design, entirely under the user's control"; apps can only open a prompt (`showSystemUserInterface(.microphoneModes)`) | None | I found nothing new in iOS 27 or WWDC26 material on this |
| `AUSoundIsolation` ([forum thread, Jun 2026](https://developer.apple.com/forums/thread/829792)) | Public Audio Unit for on-device voice isolation "independent of the system mic mode". Apple engineer suggests it for in-app control. | Yes, as a node in our graph; iOS availability version not confirmed | No cost | A Mac test ([shepetal #75](https://github.com/backant-io/shepetal/issues/75), 21 Oct 2026): 16 kHz, about 58 ms latency, and on synthetic clips full isolation raised WER from 0.0% to 3.1% on clean and 2.4% to 3.9% at 0 dB, with Parakeet v3. Not speaker-aware, and not a TV test |
| Picovoice Eagle v3.0 (Apr 2026) | On-device text-independent speaker recognition, iOS 16+. | Yes | AccessKey validated online with licence servers | [V] EER 0.18% on VoxConverse (not short-utterance). Not a VAD |
| Google | VoiceFilter-Lite (Section 2.2) and Pixel "Clear Calling" noise filtering. | n/a | n/a | I found no Android developer API for voice isolation or enrolled-speaker filtering |

Pipecat's docs ([speech input](https://docs.pipecat.ai/pipecat/learn/speech-input)) call raising VAD confidence a "blunt instrument" and recommend Krisp VIVA, ai-coustics or RNNoise upstream plus a minimum-words start strategy, which is the word-count gate we already have. Sanas offers a remote-style noise SDK; I found no iOS SDK and did not evaluate it. Stacking enhancers hurts (LiveKit warns against running two), and enhancement can raise ASR error (the Mac test above, the Krisp clean-audio row).

## 4. Streaming diarization as "who is speaking now"

| System | Facts | Size / licence | Fit |
|---|---|---|---|
| Streaming Sortformer v2.1 ([paper](https://arxiv.org/abs/2507.18446), Jul 2025) | Arrival-order speaker cache; 4 speakers; about 1.04 s latency preset. FluidAudio's Core ML port: AMI SDM DER 19 to 22% on two meetings, 26.4% on the 16-meeting set in another benchmark page, 31.7% in a third (FluidAudio's own pages disagree). | 117 M parameters; NVIDIA Open Model License | Meeting oriented |
| [Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) (Sep 2026) | 8 speakers, 10 ms output, 31-layer transformer, about 100 M parameters. Latency presets 1.04 s / 0.64 s / 0.32 s / 30.4 s. DIHARD III DER 12.73 (30.4 s) vs 19.09 for v2.1 [A]. | OpenMDW 1.1 (commercial use allowed) | Real, usable on Core ML |
| FluidAudio Core ML port ([PR #883](https://github.com/FluidInference/FluidAudio/pull/883), merged 23 Sep 2026; [model repo](https://huggingface.co/FluidInference/nemotron-3-diarization-coreml)) | AMI MHM 16 meetings, collar 0, M5 Pro: `low` (1.04 s) DER 9.75 with speaker-count accuracy 75%; `fast32` (2.88 s) 9.53 / 93.8%; `fast128` (10.56 s) 9.36 / 100%. Needs iOS 17+. No iPhone RTFx or memory published. | 190 MB, or 95 MB for W8A8 splits | Heavy for a continuous mic |
| LS-EEND ([arXiv 2410.06670](https://arxiv.org/abs/2410.06670)) | FluidAudio's default online diarizer; up to 10 speakers; 100 ms updates with a 900 ms tentative preview. Online DER 12.1% CALLHOME, 20.8% AMI [A]. | Not stated | Lighter option |
| FASTDIAR ([arXiv 2610.02941](https://arxiv.org/abs/2610.02941), 2 Oct 2026; [code](https://github.com/microsoft/fastdiar)) | CPU diarizer built on a causal ReDimNet2 frame-level encoder: one 192-d embedding every 80 ms from a 2 s past window, distilled from the ReDimNet2-B6 teacher, 960 ms label delay. Beats Streaming Sortformer on VoxConverse and NOTSOFAR without overlap scoring (12.35 vs 19.15; 21.58 vs 23.39) and loses with overlap scored. RTF 0.19 on one CPU thread [A]. The paper proposes matching against an enrolled centroid. | 2.4 / 4.6 / 10.4 M parameters; MIT; no ONNX or Core ML export | Best match for frame-level identity |

Others: pyannote 3.1 streaming needs about 5 s chunks and is slower than LS-EEND or Sortformer in FluidAudio; Community-1 is offline (MIT code, CC-BY-4.0 weights) and pyannoteAI's streaming Live-1 is a cloud API [V]; DiariZen is offline with no streaming variant found and an unverified weights licence.

Two limits matter. First, labels are by arrival order, so "which channel is the user" needs an enrolment match or an assumption (the user speaks first). A TV is just another channel, and the 8-speaker model can fill slots with TV characters. Second, none of these publish results on television audio or on a phone near a mouth. Nemotron's model card is silent on non-speech and overlap, and FluidAudio's docs say Sortformer is "more robust" to non-speech background audio, not to speech from a TV.

## 5. Addressee and device-directed detection

**Pipecat "Audience" is a different thing.** The model [pipecat-ai/audience](https://huggingface.co/pipecat-ai/audience) (RC2.1, Apache-2.0, updated the week of 14 Oct 2026) is a roughly 33 M text classifier built on Ettin-32M, 5.5 ms p95 on an M1 Max (Core ML provided). It takes a line of text, up to four earlier lines, the speaker, and up to eight candidate "people" described by cards (with optional spatial facts). It outputs a probability per person plus `unclear` and `to_group` flags. It scores 95.2 to 96.6% on its own held-out test set but was trained on generated multi-character game scenes and tested "only on generated and hand-written game-setting lines, not on real user logs"; lines worded unlike training data score about 59 to 65%. It is English only. It could be retrained for "assistant vs somebody else in the room", but as shipped it is not an acoustic addressee detector, and I found no other Pipecat model that is. Pipecat v1.12.0 added a generic classifier framework (`LLMClassifier`) that could host such a check. The sibling model [pipecat-ai/tone](https://huggingface.co/pipecat-ai/tone) (24 M, Apache-2.0) labels backchannels in text, which belongs to the barge-in researcher.

**Device-directed speech detection (DDSD) research.**
- Apple, Dec 2023 to Mar 2024 ([2312.03632](https://arxiv.org/abs/2312.03632), [2403.14438](https://arxiv.org/abs/2403.14438)): feeding ASR hypotheses and decoder signals plus audio-encoder features to an LLM beat text-only models by up to 39% relative EER and audio-only models by up to 61% [A, proprietary data]. A larger LoRA-trained LLM gave up to a further 18%. [2411.00023](https://arxiv.org/abs/2411.00023) (Oct 2024): modelling the first query and ASR uncertainty cut false alarms 20 to 40% at a fixed 10% false-reject rate for follow-up speech.
- Apple's earlier acoustic-only Siri work: 87% of false triggers mitigated at 99% true-positive rate with the whole snippet; a streaming transformer cut 95% with one extra second of audio (all [A], 2020 to 2022).
- Selective Attention System ([SAS, arXiv 2604.08412](https://arxiv.org/abs/2604.08412), Apr 2026): about 520 K parameters, INT8 about 520 KB, a CNN+GRU classifier on 64-d log-mel frames, then a small causal transformer over an 8 s window. Audio-only F1 0.86 (precision 0.89, recall 0.83), median 38 ms on an ARM Cortex-A72 [A, 600 h proprietary corpus, mostly English, weights not released]. Stage 1 is a beamformer needing at least two microphones. On TV-active sessions, false triggers rise from 2.1% to 7.8%; without beamforming, F1 falls from 0.91 to 0.74. TV dialogue with question-like intonation is its most common false trigger, and a media-rejection path is listed as future work.
- [attenlabs/saa-sdk](https://github.com/attenlabs/saa-sdk) is the hosted counterpart: the model is closed and runs on its cloud, client SDKs are Apache-2.0, on-device is an enterprise licence, no iOS client is listed. [V] F1 0.86 audio-only, 0.95 with video. A Pipecat client exists (joins a Daily room). Not usable under our remit.

Conclusion: for a phone, addressee detection will be assembled from parts we control: the text of the committed utterance (plus conversation context), prosody, and the user-attribution signal from Section 2. The SAS result is a warning that TV dialogue looks "directed" in text and prosody, so this layer reduces rather than removes TV events.

## 6. How full-duplex models handle other speakers

Benchmarks that touch it, newest first:

| Benchmark / paper | What it tests | Results |
|---|---|---|
| [HumDial / FD-Bench track](https://arxiv.org/abs/2604.21406) (ICASSP 2026, Apr 2026) | Interruption plus "rejection" (third-party speech before or after the query; speech directed to others) | Best rejection 72.2% (Cookie asr, cascaded), Badcat 57.8%, Gemini-2.5 36.5%, Moshi among lowest. Final score 0.4 Int + 0.4 Rej + 0.2 Delay. The paper says overlapping third-party speech "complicates speaker identification" |
| [Full-Duplex-Bench v1.5](https://arxiv.org/abs/2507.23159) (v4, 26 Apr 2026) | 100 synthesised "talking to others" and 100 "background speech" utterances (different voice, off-topic, background speech played 15 dB down, 3 kHz low-passed, 100 ms echo; no SNR reported) | Background speech Respond / Resume: GPT-4o Realtime 0.93 / 0.04, Gemini 0.70 / 0.30, Freeze-Omni 0.63 / 0.25, Moshi 0.21 / 0.07 (0.71 unknown), Nova Sonic 0.01 / 0.98. Talking to others: Gemini 0.00 / 0.99, Nova Sonic 0.10 / 0.90, GPT-4o 0.91 / 0.02 |
| [JoyAI-Talker](https://arxiv.org/abs/2608.01119) (Aug 2026) | Same background-speech condition | Respond 0.10, Resume 0.85 [A; Gemini 3.1 Live evaluated by these authors: 0.28 / 0.66]. Weights not confirmed released |
| [IRAF](https://arxiv.org/abs/2606.06559) (4 Jun 2026) | Interfering speakers (MUSAN, 0 to 20 dB SNR) leaking into the user stream | A one-layer gate fed by a target-speaker (ECAPA) embedding rescales the user audio per frame. Response success 91.0% vs 69.2% for noise-augmented training alone on InstructS2S [A]. This is the only full-duplex result I found that uses a speaker embedding, and it was on synthetic mixtures with a 1.1B model |
| [MSI-Bench](https://arxiv.org/abs/2609.24812) (21 Sep 2026), [MP-Bench](https://arxiv.org/abs/2609.13076) (11 Sep 2026) | Multi-speaker tasks and open turn-taking | Models "often respond when no one has addressed them"; real-time agents near chance on multiparty turn-taking; open-weight models limited by the multi-speaker front end |
| NemotronLabs VoiceChat ([card](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B), [paper](https://arxiv.org/abs/2609.21967)) | Interruptions, backchannels, tools | 100% takeover after interruptions, resumes after backchannels in 93%. No background-speaker evaluation reported |
| GPT-Live ([Microsoft Learn, 30 Sep 2026](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-live)) | n/a | Docs are silent on bystanders. A developer post says background-noise filtering is "excellent" and sees no clear interruption gain over Realtime-2. Anecdote only |

What this tells us: (a) full-duplex E2E models do not solve it; the realistic way they cope is learned gating or an LLM judge over the transcript; (b) the best system in the one human-recorded challenge was a VAD + ASR + decision cascade, which supports staying cascaded; (c) the most "pass" results use far-field, synthetic, off-topic speech, which is much easier than a TV at 0 dB with dialogue that sounds like questions. I found no benchmark that plays real TV at a controlled level; the closest is the MISP challenge, which calls TV audio a major far-field problem. That gap is why Section 9 builds our own set.

## 7. Short-segment speaker verification

### 7.1 What accuracy is realistic

| Evidence | 0.5 s | 1 s | 2 s | 3 s |
|---|---|---|---|---|
| [OpenSVBench](https://arxiv.org/abs/2610.13760) (9 Oct 2026, [I]): mean EER across 18 public checkpoints, VoxCeleb Short | 31.2% | n/a | n/a | 4.7% |
| OpenSVBench, CN-Celeb Short | 36.1% | n/a | n/a | 15.6% |
| WavLM + ECAPA baseline, Vox1-O ([VAM-ECAPA](https://arxiv.org/abs/2609.25007), [A]) | n/a | 18.4% | 5.2% | 2.4% |
| VAM-ECAPA (short-utterance fix) | n/a | 8.3% | 4.2% | 3.2% |
| ERes2NetV2 ([Interspeech 2024](https://www.isca-archive.org/interspeech_2024/chen24l_interspeech.pdf), [A]) | n/a | n/a | 1.48% | 0.98% (full 0.61%) |

Overlap is also costly: OpenSVBench mean EER under heavy overlap is 17.6% (AliMeeting) and 30.0% (CHiME-6). Short duration, channel, overlap and distance form the highest-error scenario cluster (mean 15 to 18%). The mean across weak and strong checkpoints overstates what the best models do, but it shows the shape: error roughly halves from 0.5 s to 1 s and again to 2 s, and our measured 10% miss at 1 s and 3.5% at 2 s sit inside the published range. A better embedding will help by a fraction, not an order of magnitude.

### 7.2 Embedding models newer than WeSpeaker ResNet34 and CAM++

| Model | Size / Vox1-O EER (full) | Licence | Notes |
|---|---|---|---|
| ReDimNet2 B0 to B6 ([repo](https://github.com/PalabraAI/redimnet2), Jul 2026, Interspeech 2026) | 1.1 M (1.04%) to 12.3 M (0.29%) parameters; GMACs 0.33 to 13 [A] | MIT | Ranked 2nd of 18 on OpenSVBench macro EER (10.53%). Interspeech 2025 robustness study found the first ReDimNet had the lowest cross-domain degradation. Torch only; no ONNX or Core ML export documented |
| ReDimNet2+ ([arXiv 2609.37014](https://arxiv.org/abs/2609.37014), [weights](https://huggingface.co/lab260/redimnet2-plus)) | 12.3 M, 192-d; 0.351% under random 4 s windows | Apache-2.0 (weights card) | Trained on 7 corpora (about 64 K speakers) including VoxCeleb2. No short-utterance study |
| ECAPA2 | n/a | CC-BY-NC-4.0 | Not usable commercially |
| ERes2NetV2 / CAM++ ([3D-Speaker](https://github.com/modelscope/3D-Speaker)) | 17.8 M (0.61%) / 7.2 M (0.65%) | Code Apache-2.0; weights licence not stated | CAM++ is what we run. ERes2NetV2 is built for short utterances |
| WeSpeaker ResNet34 / ResNet293 | 0.72% / 0.45% (with LM fine-tuning and AS-Norm) | Code Apache-2.0; weights unstated | What we run |
| W2V-BERT2 | Top OpenSVBench macro EER (9.96%) | Large | Not deployable on-device |
| WavLM-SV, UniSpeech-SAT-SV | Bottom of OpenSVBench (25%) | | Avoid |
| Speech-aware LLMs | EER above 20% on VoxCeleb1 ([arXiv 2603.10827](https://arxiv.org/abs/2603.10827)) | | Avoid |

Licence flag: nearly every model above was trained on VoxCeleb, CN-Celeb or VoxBlink, whose terms are not clean for commercial use. Have counsel check before shipping any of them, including the ones we already use.

### 7.3 Practice that helps at short durations

- **Do not decide at a fixed 1 s.** Score the user-attributed frames cumulatively (for example at 0.5, 1, 1.5, 2, 3 s). Keep a three-way outcome (user / other / undecided) and take the decision when evidence is strong.
- **Make the score duration-aware.** Quality-measure-function calibration (log duration plus quality features) is the established method; a September 2026 uncertainty-aware back end ([arXiv 2609.01221](https://arxiv.org/abs/2609.01221)) and [U3-xi](https://arxiv.org/abs/2601.15719) (WeSpeaker PRs #469 and #470; no TorchScript or ONNX export for those models yet) propagate embedding uncertainty into scoring, AS-Norm and calibration. Use the cohort for AS-Norm from phone-in-a-room audio, not VoxCeleb.
- **Text-dependent beats text-independent for very short trials.** A June 2026 paper ([arXiv 2606.16115](https://arxiv.org/abs/2606.16115)) finds text-dependent enrolment better below about 2 s and text-independent better above about 3 s (3 s text-independent enrolment gave 8.86% EER). This suggests enrolling the user's interruption words ("stop", "wait", "hold on") for a text-dependent barge-in check.
- **Enrol under realistic conditions and update conservatively.** The ICASSP 2026 result suggests iterative refinement from detected frames closes the gap to long enrolment (five updates). Update only from high-confidence, user-attributed, near-field frames, since a TV could otherwise poison the profile.
- **Mask before embedding.** A mixture turn embeds as a blend. Embed only the frames the frame-level model attributes to the user.

## 8. Takeaways for our pipeline

Ranked by expected value per effort. Effects are my estimates.

| # | Adopt | Where | Expected effect | Size / licence / effort |
|---|---|---|---|---|
| 1 | **Train a speaker-aware frame VAD** (pVAD 2.0 FiLM structure with an enrolment-optional, foreground-dominance training recipe from the FVAD paper). Classes: silence / user / other speech. Condition on our own fused embedding. Train on public speech plus TV-like data: broadcast and drama audio with music, loudspeaker EQ, room impulse responses, target-to-interferer ratio (TIR) -6 to +12 dB. | Beside Silero on the 16 kHz tap; the turn manager uses only "user" frames to open a turn and to start and run the silence and Smart Turn timers; barge-in requires user frames. Keep Silero as fallback when no enrolment. | Removes "TV holds the turn open" and TV-triggered VAD at the source. Literature: pVAD target AP 0.90 to 0.95 vs 0.78 for VAD+SV cascade; FVAD BG-FAR 0.05 to 0.40 vs Silero above 0.8 (neither tested at 0 dB with TV). Estimate: halves false turn starts and false barge-ins from TV, with recall loss when the user is much quieter than the TV. | 0.2 to 1.1 M parameters (under 2 MB); Apache-2.0 templates; Core ML, TFLite and ONNX all feasible so it ports to Android and the browser. 3 to 6 weeks including data |
| 2 | **Sequential masked verification with deferral and duration calibration** (Section 7.3). Soft P(user) feature instead of drop-at-1 s. | Replace the turn-level drop; feed the same score to barge-in. | Targets the 10% miss at 1 s by deciding later on turns that continue, toward the 3.5% seen at 2 s. Cannot help sub-1 s utterances. Estimate: miss at an equal false-accept point falls from about 10% towards 5 to 6% on turns longer than 1.5 s. | Days to a few weeks; no new model |
| 3 | **Benchmark ReDimNet2 / ReDimNet2+ and ERes2NetV2 against the current pair** on our own 0.5 / 1 / 2 s near-field and TV-mix trials; swap or add to the fusion if it wins. Convert to Core ML first. | Embedding service | Modest at best (published short-duration gaps are a few points; ReDimNet had best cross-domain robustness). Value is robustness, not a step change. | 1.1 to 12.3 M parameters; MIT / Apache-2.0 (weights trained on research datasets: check) |
| 4 | **Text-and-context directedness at commit.** Either a NO_RESPONSE path in the main LLM call (voice-origin turns only), or a small fine-tuned classifier on our logs (the Audience / Tone architectures are templates). | After transcription, before the agent answers | Catches TV dialogue that slips through and side conversations. Apple: multimodal beat text-only by up to 39% relative EER; SAS warns TV looks directed, so expect a partial gain. | Near zero for the LLM path; 24 to 33 M for a classifier |
| 5 | **Front-end A/B: `AUSoundIsolation`** ahead of the 16 kHz fan-out, and a one-time UX nudge to the system mic-mode picker. Default off unless it wins on our set. | Audio graph | Unknown. Not speaker-aware, a Mac test shows WER can get worse, and it may fight Apple voice processing. | Free, public AU |
| 6 | **Frame-level identity tracker:** a causal ReDimNet2-style embedding every 80 ms (FASTDIAR recipe, MIT) matched to the profile, as an extra stream for #1 and #2. Use Nemotron 3 Diarization (or pyannote Community-1) offline to label our recordings. | Research branch | Could replace #2's windowed embeddings with true frame evidence; unproven on TV. | 2.4 to 10.4 M; MIT; needs our own Core ML export |
| 7 | **Use vendors as lab oracles only:** run Krisp VIVA (trial on your own audio) and ai-coustics Quail Voice Focus (30-day trial, Python SDK) on the evaluation set to see how much a strong primary-speaker isolator helps VAD, ASR and turn timing. | Offline harness | Tells us whether a learned isolator is worth building or licensing offline; do not ship (server-side, telemetry, iOS gaps). | Trial terms |
| - | **Do not build now:** TSE front end (REAL-TSE: TER about 0.7), multi-talker ASR (600 M, needs diarizer), SAA (cloud), speech-LLM SV, camera gaze (SAS: audio+video F1 0.95 vs 0.86 audio-only, but privacy and handset placement make it a poor fit). | | | Revisit in about 6 months: FVAD code, SAS weights, REAL-TSE winners' releases |

Design notes. The cost asymmetry should be explicit: answering the TV is annoying, dropping the user is worse. In uncertain cases, show the transcript as a draft in the text composer rather than discarding it, since the thread is the same either way. Run #1 with two thresholds, a strict one for barge-in and a lenient one for turn continuation.

## 9. Evaluation plan

1. **Build a living-room set.** Record through the real pipeline (voice-processing AEC and noise suppression included) on at least two iPhone generations. Conditions: user alone at 0.3 and 0.6 m; TV alone (news, drama with music, sport, animation, a podcast) at 2 to 3 m; user + TV at TIR -6, 0, +6, +12 dB; a second person in the room; speakerphone call audio; user while the assistant is speaking (echo residue). Also include a headset mic condition. Label frame-level truth by recording the user and the TV on separate tracks as well, and use offline diarization (Nemotron 3, pyannote Community-1) only to accelerate labelling.
2. **Metrics.** Frame level: target recall and precision, BG-FAR and foreground F1 (the FVAD paper's definitions), tss / ns / ntss AP (pVAD papers). Turn level: false-accept rate of non-user turns per hour of TV, false-reject rate of real user turns at 0.5 / 1 / 2 / 3 s, time to decision, DET curves with duration-stratified thresholds. System level: end-of-turn latency inflation under TV vs clean (ms), false barge-ins per hour and missed real barge-ins, ASR error with and without masking or enhancement, battery, Neural Engine and CPU load, p95 latency. Also run the same trial lists through OpenSVBench-style scenarios (short, overlap, distance, channel) to keep embedding comparisons honest.
3. **Ablations.** Silero only; Silero + current SV (baseline); pVAD-style model alone; pVAD + sequential SV; + text gate; + AUSoundIsolation; vendor oracles. Run each model at fixed false-accept targets (for example 1 TV-triggered turn per hour) and compare recall.
4. **Data hygiene.** Hold out speakers and TV titles; report confidence intervals (OpenSVBench uses bootstrap resampling); never tune thresholds on the evaluation recordings.
5. **Gate for launch.** Decide before testing: for example TV-triggered false starts under N per hour at a user false-reject of under X%, and end-of-turn latency under TV within Y ms of clean.

## 10. Caveats and open questions

- Several figures came through page summaries (FVAD, SAS, OpenSVBench, HumDial, FASTDIAR). Check the PDFs before relying on a number. FluidAudio's own pages give conflicting Sortformer DER numbers; the Foreground VAD paper gives conflicting latency numbers.
- I could not verify whether Apple Voice Isolation suppresses other people's voices (Apple's page says only "blocks ambient noises"), the iOS availability version of `AUSoundIsolation`, whether `.voiceChat` honours a preferred polar pattern, or whether iOS 27 added any mic-mode API.
- Krisp's iOS SDK and ai-coustics' mobile availability are marketing claims I could not confirm in documentation.
- The Pipecat "Audience" model card says it should not be used "to judge real people"; any retrain on household audio needs a privacy review.

All sources are linked inline and were accessed on 22 Oct 2026; dates are given where the source states one.
