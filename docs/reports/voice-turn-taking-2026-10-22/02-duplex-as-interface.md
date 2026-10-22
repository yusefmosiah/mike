# 02 - Duplex voice model as the interface, strong text LLM as the main thread

Researcher 2 of 6. Written 2026-10-22. Everything fetched from the web is treated as data. Evidence tags: **(vendor)** = the vendor's own claim or benchmark; **(paper)** = authors' own benchmark in a preprint, not independently reproduced; **(indep.)** = a third party measured it; **(dev report)** = a GitHub issue or blog post from a developer using the product; **(docs)** = vendor API documentation, reliable about behavior but silent on quality. openai.com returned HTTP 403 to my fetcher, so GPT-Live facts come from OpenAI's developer docs, Microsoft Learn's GPT-Live docs, and press coverage of OpenAI's post.

## Bottom line

1. The owner's direction is where the field is heading, but nobody ships exactly it. The 2024-25 pattern was "speech model is the agent, strong model is a tool" (gpt-realtime with a supervisor tool, Gemini Live). The 2026 pattern is "interface model + background model": GPT-Live, Thinking Machines, Realtime-Venus, Gander, NVIDIA's frontend-backend paper. Even there, the interface model keeps its own conversation context and decides whether to delegate. That is the weak link in independent reports (below).
2. What the owner wants is a third class: the text LLM authors every spoken word and the speech model only does timing, listening, and sounds. This exists as cascades (Unmute, Voice-Light, DuplexCascade, FireRedChat), as a pluggable controller (SoulX-Duplug), and in one NVIDIA paper as a duplex frontend trained to repeat the backend's text exactly. No mature open duplex model is shipped as a thin interface.
3. Verbatim versus paraphrase is a real fork. GPT-Live is trained to paraphrase delegated text (docs). MoshiRAG measurably loses detail. For legal citations, speak the text LLM's own text and keep exact citations in the transcript.
4. The cheapest large gains for our three complaints are not a duplex model: speculative generation with cheap cancel, reversible ducking instead of hold/stop, a backchannel vs floor-take distinction, and a heard-prefix ledger in the thread. A duplex model is worth a GPU-side shadow experiment, not a launch dependency.

---

## 1. Landscape: who owns the conversation, and who authors the words

Two questions separate the designs: **(a) which model holds the conversation state** and **(b) which model authors the words that get spoken**. The owner's position is "text LLM on both."

| Class | Examples | State owner | Word author |
|---|---|---|---|
| A. Speech model is the agent | gpt-realtime + supervisor tool; Gemini Live function calls | speech model | speech model; tool results re-voiced |
| B. Interface + background model | GPT-Live, Thinking Machines, Realtime-Venus, Gander, NVIDIA frontend-backend, Qwen Audio Agent | mostly the interface | interface (paraphrase), except NVIDIA (verbatim) |
| C. Text LLM authors; speech layer is timing/skin | Unmute, Hume EVI 4-mini, Qwen3-Omni Talker, Freeze-Omni, DuplexCascade, Voice-Light, SoulX-Duplug | text LLM | text LLM |
| (hybrid) | KAME, MoshiRAG, Context Spanning | duplex model | duplex model, guided by LLM text |

### Systems that matter

| System (date) | How backend text reaches speech | Notes |
|---|---|---|
| **GPT-Live** (launched 2026-07-08; replaces Advanced Voice) | `session.commentary.append` (say aloud, may paraphrase, up to 500 tokens) and `session.thinking.append` (quiet context); Responses delegation injects backend output into the live session | Vendor claims: full duplex, "removes the turn detector from the audio path", decides "many times per second" whether to speak/listen/backchannel. Closed, cloud. [VentureBeat 2026-07-08](https://venturebeat.com/technology/openai-launches-gpt-live-a-full-duplex-voice-upgrade-that-lets-chatgpt-talk-more-like-a-person); [Microsoft Learn, ms.date 2026-09-04](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-live); [OpenAI delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) |
| **Thinking Machines TML-Interaction-Small** (preview 2026-05-11) | Background model gets "the full conversation"; results "stream back" and are woven in "at a moment appropriate to what the user is currently doing" | 276B MoE / 12B active; 0.40 s turn-taking latency (vendor). Not available. [Blog](https://thinkingmachines.ai/blog/interaction-models/); [VentureBeat](https://venturebeat.com/technology/thinking-machines-shows-off-preview-of-near-realtime-ai-voice-and-video-conversation-with-new-interaction-models) |
| **Realtime-Venus** (Ant Group, arXiv 2609.13814, 2026-09-12) | Front end emits a private `<delegate>` span; harness returns `<backend>` spans on a separate stream; harness "polishes" the result into a spoken reply, the front end chooses when to say it | Two 9B models. Playback confirmation is part of the delegation snapshot (paper). [arXiv](https://arxiv.org/abs/2609.13814) |
| **Gander / Omni Interaction Agent** (arXiv 2609.08977, 2026-09-08) | "Cerebellum" (MiniCPM-o 4.5 based) vs "Brain"; `task_start`, `task_send`, `task_resolve`, and a `share` tool for progress | Cerebellum rewrites Brain output for speech. [arXiv](https://arxiv.org/abs/2609.08977) |
| **NVIDIA frontend-backend** (arXiv 2609.19334, 2026-09-16) | Frontend emits `<tc_bos>` + a ~1 s filler + `<tc_eos>`; a text LangGraph agent runs; its answer is **prefilled** into the frontend's agent-text channel, and the frontend is trained to reproduce it **exactly** | Closest match to the owner's idea. Backend keeps state per thread and sees only the current ASR transcript. Frontend: 600M Parakeet encoder + Nemotron-Nano-9B (authors look like NVIDIA's speech team; the page I fetched shows no affiliation). I could not confirm a released checkpoint. [arXiv](https://arxiv.org/abs/2609.19334) |
| **KAME** (Sakana, ICASSP 2026; arXiv 2510.02327 v2 2026-05-25) | Back-end LLM is re-called on each partial transcript; its candidate answer enters Moshi as a 4th "oracle" token stream; newest oracle wins | 8B weights + code open. [paper](https://arxiv.org/abs/2510.02327); [HF](https://huggingface.co/SakanaAI/kame) |
| **MoshiRAG** (Kyutai, ICML 2026; arXiv 2604.12928) | Moshi emits `<ret>`, says a lead-in, retrieval runs async, text is compressed 4x by an ARC-Encoder and injected | Weights CC-BY 4.0 per [README](https://github.com/kyutai-labs/moshi-rag). |
| **Context Spanning** (arXiv 2609.33443, 2026-09-27, under review) | Raw tool/LLM text is chunk-prefilled into the Moshi KV cache between `<sos>`/`<eos>`; avoids MoshiRAG's lossy compression | Preprint only. [arXiv](https://arxiv.org/abs/2609.33443) |
| **Qwen3-Omni Thinker-Talker** (arXiv 2509.17765) | Talker "no longer consumes the Thinker's high-level text representations"; external modules (RAG, function calls, safety filters) can intervene on Thinker text and "supply text to the Talker" | Effectively streaming TTS of text. Open weights. [paper](https://arxiv.org/abs/2509.17765) |
| **Unmute** (Kyutai, 2025) | Any text LLM; TTS reads the stream; semantic VAD inside the STT model | MIT. ~450 ms with TTS on a separate GPU, ~750 ms on one L40S. Loses prosody/emotion going through text. [repo](https://github.com/kyutai-labs/unmute) |
| **Hume EVI 4-mini** | External LLM required; EVI's speech model voices its text "as an actor" reads lines | Vendor cloud; docs page says EVI/TTS APIs sunset 2026-11-13. [docs](https://dev.hume.ai/docs/speech-to-speech-evi/overview.md) |
| **Freeze-Omni** (ICML 2025) | Frozen text LLM; a state head on the LLM predicts interruption/duplex states | Text LLM stays the author. [arXiv](https://arxiv.org/html/2411.00774v4) |
| **Qwen Audio Agent** (v2.0.0, 2026-09-23) | Lightweight realtime voice front end plus backend coding agents over ACP/A2A; "you can ask about progress or cancel at any time" | README does not say verbatim vs summarized or who owns the transcript. [repo](https://github.com/QwenAudio/qwen-audio-agent) |
| **Talker-Reasoner** (DeepMind, 2024-10) | Conceptual: Talker and Reasoner interact "through memory"; Talker answers from possibly stale beliefs | Single qualitative case study, no numbers. [arXiv](https://arxiv.org/html/2410.08328v1) |

### What the evidence says about quality

- **Hand-off costs accuracy (KAME, paper).** Speech-synthesized MT-Bench: Moshi alone 2.05; KAME + GPT-4.1 6.43; cascaded Unmute + GPT-4.1 7.70. Median latency 0.0 s for KAME vs 2.1 s for Unmute. The authors attribute the gap to "premature response generation," not the backend: KAME's last oracle text scored 7.79. KAME can correct itself after a contradictory oracle arrives, but the first words were already spoken.
- **Hand-off loses detail (MoshiRAG, paper).** Spoken answers were ~5 points less accurate than the retrieved reference they were built from. Summarizing the reference first helped, because "excessive numerical details, symbolic expressions" hurt integration. Bad news for statute numbers and pinpoint cites.
- **Grounding (DuplexSpeechBench-Document Grounding, arXiv 2610.00316, 2026-09-29, indep.).** At 2k tokens: cascaded ASR-GPT-4o-TTS 90.3%, GPT-Realtime 87.7%, Gemini-Live 87.4%, Moshi ~3%. Speech-native models more often answered confidently than abstained. [arXiv](https://arxiv.org/html/2610.00316v1)
- **Full-Duplex-Bench v3 (arXiv 2604.04847, real disfluent speech + tool use, indep.).** GPT-Realtime Pass@1 0.600; Gemini Live 3.1 0.540; a Whisper-GPT-4o-TTS cascade 0.450 with 10.1 s latency. The cascade lost on self-corrections (0.176) because the ASR finalized the original wording before the correction arrived: an endpointing problem, which is our problem. [arXiv](https://arxiv.org/html/2604.04847v1)
- **Delegation gatekeeping fails in practice (dev reports).** In a LiveKit issue, with GPT-Live `delegation="responses"`, 14 of 75 calls had a cancel request with no delegation within 6 s, and the model sometimes told the caller the action was happening. A stricter prompt "still fails about one call in five." [livekit/agents#7551](https://github.com/livekit/agents/issues/7551). Another project measured a holding sentence of 1-2.8 s followed by 55-58 s of silence when the client never answered a delegation, with no provider-side timeout seen in a minute. [meclaw#793](https://github.com/mmeyerlein/meclaw/issues/793). A request for a "delegate-only" mode (speak only appended commentary) shows GPT-Live will sometimes answer on its own despite client delegation. [OpenAI forum](https://community.openai.com/t/feature-request-gpt-live-delegate-only-mode-model-hears-and-reports-speaks-only-appended-commentary/1408207) (undated). These are small-sample reports, but they point at the same design risk: the interface model is a gatekeeper that can fail silently.
- **Duplex models are not good talkers (paper + indep.).** On VoiceBench, DuplexCascade's authors report Moshi 29.5 and PersonaPlex 30.6 vs 69.7 for a plain ASR+Qwen2-7B cascade. "Take the floor when asked, not when needed" (arXiv 2609.19596) finds Moshi/PersonaPlex speak when addressed or after silence, not when content warrants. EchoChain (arXiv 2604.16456) finds no tested real-time voice system above a 50% pass rate on updating task state after an interruption.

---

## 2. Concrete integration patterns

### 2.1 How the interface receives the LLM's text

| Pattern | Who | Faithfulness | Cost |
|---|---|---|---|
| **Stream text to TTS** | Unmute, Qwen3-Omni, our pipeline | Exact | TTFT of the LLM sits in the latency path |
| **Prefill-and-repeat inside a duplex model** | NVIDIA frontend-backend | Exact by training ("trained to generate the exact prefilled text") | Needs a custom-trained frontend; backend text appears about 1 s after `<tc_eos>`; frontend stays silent (pad tokens) in between |
| **Raw text into context, model re-voices** | Context Spanning, GPT-Live commentary | Model-dependent; GPT-Live "is trained to paraphrase" | Lets the model adapt to interruptions |
| **Guidance stream** | KAME | Soft; front end may already be talking | Latency near zero, quality below cascade |
| **Compressed latent** | MoshiRAG | Lossy (~5 pts) | Fast injection |
| **Role-played TTS** | Hume EVI | Likely close to verbatim; vendor does not say | Expressive voice for any LLM |

OpenAI's own docs concede the issue. Commentary is paraphrased and the docs point to "application-controlled playback when you need exact wording or verified delivery" ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)). The Realtime prompting guide recommends wrapping verbatim content in a JSON envelope with `require_repeat_verbatim` because raw strings "were more prone to paraphrasing, truncation, and added commentary" ([voice-prompting](https://developers.openai.com/api/docs/guides/voice-prompting)). A third-party guide advises, for legal disclosures, checking the audio or using a pre-recorded clip ([Evalgent](https://www.evalgent.com/blog/build-voice-agents-gpt-live), dev report).

**Verbatim vs paraphrase, for this product.**
- Verbatim pros: what was spoken equals what is in the thread; exact citations; no divergence to audit; easy to evaluate. Cons: the LLM must write in a speakable style (see section 3); first audio is gated on the LLM's first clause, so gap-filling matters more.
- Paraphrase pros: can start early (KAME), can compress, adapts mid-sentence. Cons: loses numbers and names, the spoken record is no longer the LLM's text, and the interface can invent content (GPT-Live answering on its own despite client delegation; KAME speaking before its oracle arrives).
- Recommendation (mine): **verbatim with a speakable rendering**. The text LLM writes (or a deterministic renderer derives) the spoken form. The interface may add only a closed set of non-content sounds (acknowledgments, holding lines, backchannels) that are logged as events, not as assistant content. Exact quotations, citations, and statute text are shown on screen; spoken only in short form unless the user asks "read it exactly," in which case a `verbatim` span is read word for word.

### 2.2 Filling the gap while the LLM works

- **MoshiRAG:** training data has "pre-RAG content," a coarse answer plus fillers like "Let me check that for you...", then the body once retrieval lands. Retrieval delay targeted at ≤2 s, because end-to-end time to the key word in existing speech LMs "often exceeds 3 seconds." It recommends a local backend since "retrieval delays over 3 seconds hurt response quality."
- **NVIDIA frontend-backend:** one ~1 s filler ("Give me a moment", "Let me pull that up"), then silence. NemotronLabs VoiceChat plays a predefined acknowledgment while tools run and the paper says **barge-in is unavailable during tool execution** ([arXiv 2609.21967](https://arxiv.org/html/2609.21967)). A long agent run must not deafen the interface.
- **OpenAI guidance:** preambles should be one short sentence; fillers "must not imply success or failure"; "A spoken promise such as 'I'm checking that' does not confirm that backend work has started"; send progress "only when something useful changes" (`thinking.append` for quiet progress, `commentary.append` for audible).
- **Gemini Live API:** `gemini-3.1-flash-live-preview` is synchronous-only ([model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)). The newer `gemini-3.8-live` (Sept 2026) lists non-blocking calls with `scheduling` of INTERRUPT, WHEN_IDLE, or SILENT ([model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live); [tools guide](https://ai.google.dev/gemini-api/docs/live-tools)). That three-way enum is a good model for how a run event should be surfaced: interrupt now, say when idle, or record silently.
- **Amazon Nova 2 Sonic:** on a tool-use event the client can send a text message so the model says a natural holding line ([cross-modal docs](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-cross-modal.html)).
- **Backchannels:** GPT-Live is said to insert "mhmm" while the user talks (vendor). In a cascade, DuplexCascade has the controller trigger a **pre-recorded clip** ([arXiv 2603.09180](https://arxiv.org/html/2603.09180v1)); a lightweight hidden-state head adds backchannels to PersonaPlex (7B) and F-Actor (1B) and raters score them on par with human ones (paper, [arXiv 2609.29418](https://arxiv.org/abs/2609.29418)). Voice-Light distinguishes **floor-taking** from **non-floor feedback**: above one probability it commits an interruption, and a backchannel resumes the existing generation "without adding a user turn."
- **Failure to design against:** filler then silence (meclaw#793). The client needs its own watchdog, since GPT-Live "never times a delegation out" ([go-agent-harness#646](https://github.com/portpowered/go-agent-harness/pull/646), dev report).

### 2.3 Reporting what the person actually heard after an interruption

This is the most underbuilt area, and our played-sample clock is already ahead of most products.

- **OpenAI Realtime:** `conversation.item.truncate` with `audio_end_ms` drops unplayed audio and its transcript from context. Developers report 5-10 s of unheard sentences remaining because the model generates faster than real-time ([forum](https://community.openai.com/t/realtime-api-interruptions-dont-properly-trim-the-transcript/1000703), dev report). A third-party guide says GPT-Live "does not support truncation," so its context keeps the full turn (Evalgent, dev report, unverified against OpenAI).
- **PACE** (Alibaba, arXiv 2608.07631, 2026-08-07): names the failure *Generative Context Mis-anchoring*: after "the second attraction" the user asks "how do I get there?" and the model resolves "there" to an unheard fourth. Middleware keeps a server-side output ledger and client playback acks; on interruption it projects only played content into model context. Referent-anchoring accuracy 25.0% to 96.3% on its own 108-case benchmark (paper). [arXiv](https://arxiv.org/pdf/2608.07631)
- **Self-Listening** (arXiv 2609.05592): in a counting probe no tested commercial or open real-time system reliably reported the last number it had actually spoken; feeding played speech back as a third channel reached 73.0% vs 43.8% for the best commercial baseline (paper).
- **Realtime-Venus:** prior assistant speech needs playback confirmation before a delegation snapshot; "Delivered" requires playback acknowledgment of every chunk; after an interruption it revises only the unspoken continuation (paper).
- **Voice-Light:** "Durable assistant history comes only from audio the browser confirms it rendered" (paper).
- **LiveKit / Pipecat:** history is built from TTS-aligned text and truncated at the interruption; the estimate "can be off by a word or two"; external memory can still store the whole reply ([LiveKit docs](https://docs.livekit.io/agents/multimodality/text/), [community](https://community.livekit.io/t/chat-context-contains-text-that-wasnt-spoken-due-to-interruption/165), [Pipecat](https://docs.pipecat.ai/guides/learn/context-management)).

None of these tells the model *how* it was interrupted. What I would record (my design): the full generated text, the heard prefix (to word or clause level), the unheard remainder (kept for UI and audit), and an interruption kind (floor-take, correction, "stop," side-talk). Model-facing history shows the heard prefix plus a short marker, e.g. `[interrupted here by the user; the rest was not heard]`.

### 2.4 Tool calls and long-running work

- GPT-Live: "Stop talking" and "Cancel my order" are different intents; interrupting speech leaves backend work running; the app owns permissions and durable state; "a completed backend response doesn't mean the user heard the answer" ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-live)).
- Gander separates `task_start` / `task_send` / `task_resolve` and routes new input either into the main task or a read-only side query (`fork`); task objectives are bound to the transport-confirmed user turn, not model-generated parameters (paper).
- Venus: an intent-changing correction "cancels dependent work and triggers replanning"; results past a freshness deadline are dropped (paper).
- Dev reports: overlapping delegations queue and answer "the latest unresolved request" (nagents#94); stale answers ("Friday" vs "Thursday") are a known hazard (Evalgent).

For us the durable agent run already exists. The voice layer should be a **subscriber to run events** (tool started, source found, answer streaming, run failed), not a separate agent with its own task state.

### 2.5 Keeping the text transcript as source of truth

Duplex models are bad at this by construction. GPT-Live emits timed fragments, "doesn't emit an authoritative turn-completed event," and says fragments overlap and "can contain mistakes" (Microsoft Learn). Moshi-style models do not transcribe the user at all; adding an ASR head gets 10.21% average WER vs 7.73% standalone (paper, [arXiv 2609.15759](https://arxiv.org/abs/2609.15759)). NVIDIA's frontend predicts the user transcript itself, and its streaming-ASR WER rose from 10.80% to 11.47% after tool-call training (paper). **Our offline ASR on the whole utterance is the right source of truth**, and the cascade is a structural advantage here.

---

## 3. Modality-agnostic conversation design

### 3.1 What products do

- **ChatGPT:** since 2025-11-25 voice runs inside the normal chat; answers appear as text, visuals show, but you "still need to tap 'end'" to go back to typing ([TechCrunch](https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/)). GPT-Live replaced Advanced Voice on 2026-07-08; users pick Instant/Medium/High reasoning. The GPT-Live API is voice-out only and I found no user-text-turn event in its docs, only 500-token instruction/context appends; so it is not built for pasting a document mid-call.
- **Claude:** voice transcripts are saved as text, "previous context carries over" when you type, and voice can use the same models and connected tools as text chat, with some results not displayable and tool use adding delay ([support article](https://support.claude.com/en/articles/11101966-using-voice-mode)). That fits a cascade around the text model (my inference).
- **Gemini:** Live transcripts are saved when Apps Activity is on; Google says Live is more integrated with chat as of I/O 2026 (secondary sources only). In the Live API, `send_client_content` works throughout a session and `turn_complete=true` interrupts generation.
- **Nova 2 Sonic:** typed messages can be interleaved with streaming audio in the same session.
- **Hume:** the speech model voices an external LLM's text; chat history is stored per chat.
- **Sesame:** CSM conditions on interleaved text and audio history but "can only model the text and speech content... not the structure of the conversation"; full duplex is a stated future direction. It is a voice generator, not a thread owner ([Sesame](https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice)).

Pattern: products treat voice as an explicit *mode* with start/stop. We want input modality and output modality to vary per turn, independently: a user may type because they cannot speak aloud but still want audio in earbuds, or speak and want a written answer.

### 3.2 Metadata a voice turn should carry (my proposal; no public convention found)

Keep the transcribed text raw. Put facts in a structured envelope, render a one-line tag into the prompt, and add a standing instruction.

- `modality`: `voice` | `typed` | `pasted`. Pasted text is authoritative and may be long; voice text is machine transcription.
- `asr`: engine, low-confidence spans with alternates (names, statute numbers, dates, amounts), and the merged-turn ids when the "continue" rule fired.
- `speaker`: verified or not, with score, since turns from other voices are dropped or flagged.
- `barge_in`: which assistant message was interrupted, the heard prefix, and the interruption kind.
- `timing`: pause before the turn; whether it self-corrected mid-utterance (FDB-v3's hardest case).
- `output_mode` for the *next* answer: `spoken`, `written`, or `both`, plus whether the user is probably unable to look at the screen.

Standing instruction: "Turns tagged `voice` are machine transcriptions and may contain errors, especially in names, case citations, statute numbers, and amounts. If an error would change the legal meaning, ask the user to confirm before relying on it. Never treat the unheard remainder of an interrupted answer as something the user has seen or heard." This follows OpenAI's guidance to ask when "an important name, date, or number is unclear" and read identifiers back digit by digit.

### 3.3 Spoken answers vs written answers

- OpenAI: "Text replies are not automatically good for speech, so the responder must rephrase"; a brief opener, a one-sentence gist, at most three key details, one or two sentences for direct answers; read numbers as speech (voice-prompting guide).
- Research: radio-industry prompting plus preference tuning on a 20K speech-rated set made responses "preferred or tied" 76.2% of the time ([Speechworthy, EMNLP 2024](https://arxiv.org/abs/2409.14672)).
- Citations: practitioner sources say attribution must be claim-level in voice; I found no legal-domain study and no convention for speaking case or statute citations.

My design: one retrieval and reasoning pass, then a **render step**. The canonical written answer lives in the thread. A speech render (LLM prompt addendum when `output_mode` includes spoken, plus a deterministic cleaner for markdown, URLs, and citation markers) produces the spoken text, and the thread records which parts were rendered and heard. Do not fork the conversation by mode; mode is a per-turn render flag. After a terse spoken answer, "give me the full analysis" must expand from the canonical text, so both forms are stored.

---

## 4. Can we build this from our cascaded parts, and what would a duplex model add?

**Yes, most of it today.** Our pipeline already has the right skeleton: text LLM as the agent, clause-wise verbatim TTS, a played-sample clock, a "continue" branch that cancels in-flight answers. Versus the patterns above, the gaps are:

1. **No speculative generation.** Voice-Light opens a private candidate after 80 ms of low speech probability (Silero fallback 160 ms), keeps text and audio hidden until final ASR checks, invalidates on lexical change, and promotes otherwise. Median final-VAD to first audio was 758 ms over 36 turns on cloud GPUs (paper, instrumented case study). KAME and "Can Speech LLMs Think while Listening?" (ICLR 2026, which starts reasoning before the user finishes) make the same point: starting early is where the latency saving comes from. This turns end-of-turn tuning from "too fast cuts people off / too slow feels dead" into a cost question.
2. **Barge-in is hold/stop, not reversible.** Voice-Light fades playback toward -15 dB over 450 ms and pauses after 500 ms; interruption commits only above 0.82 floor-take probability; below it, playback resumes.
3. **No explicit backchannel/floor-take/side-talk classes.** Our rule counts words that don't match the clause being played, which cannot tell "mm-hm" from "wait."
4. **No gap-filling policy** tied to run events.
5. **No heard-prefix in the thread.**

### Component menu for "small model owns timing, text LLM owns content"

- **SoulX-Duplug** (arXiv 2603.14877, 2026-03-16, code open): one streaming module that does ASR and emits state tokens (`user_idle`, `user_nonidle`, `user_backchannel`, `user_complete`, `user_incomplete`); 160 ms chunks, 240 ms theoretical average turn latency (paper). On the authors' English pre-segmented clips, average accuracy was TEN 86.1%, SoulX-Duplug 83.3%, Smart Turn **V2** 69.3% (we run v3.2, so not comparable). It also reported high takeover in pause handling for Moshi, PersonaPlex, and dGSLM: their low latency partly comes from being "more aggressive." [arXiv](https://arxiv.org/abs/2603.14877)
- **Voice-Light's adapter:** ~183k trainable parameters on a shared streaming-ASR encoder. Its own honest result: the learned checkpoint had 2.70% false cutoff but only 12.53% end-of-turn recall, vs 95.60% for Silero at the same false-cutoff rate, so they shipped a hybrid. Learned turn-taking is not automatically better. [arXiv](https://arxiv.org/html/2609.20995v1)
- **DuplexCascade** (Interspeech 2026): the LLM itself emits control tokens (`<user is interrupting>`, `<user backchannel>`, `<system backchannel>`, ...) on 0.6 s micro-turns; Qwen2-7B + LoRA, ~5 h on 8 H100s; VoiceBench 65.4 vs 69.7 for the naive pipeline. Requires fine-tuning the model that does the talking, so it conflicts with keeping a strong frontier LLM as the thread.
- **Kyutai STT semantic VAD** (1B; "available in the Rust server but not yet in the other implementations").
- **Duplex checkpoints (GPU only):** PersonaPlex 7B (2026-01-15, commercial use allowed per card, A100/H100, English only); NemotronLabs VoiceChat 11B (2026-08-03, OpenMDW 1.1; 448 ms smooth turn-taking, 480 ms interruption latency, lowest open-weight pause takeover 15.3%/25.5%, all paper figures; FDB-v3 Pass@1 only 33.0%); Moshi 7B (MLX int4/int8; Kyutai ships an experimental `moshi-swift` iOS app, no performance numbers published); KAME 8B; MoshiRAG 7B (needs ~24 GB GPU). None runs alongside our iPhone budget; treat on-device 7B duplex as unproven.

### What a duplex interface would add, and what it would not

Adds (paper-level evidence):
- Joint modeling of overlap. Venus reports responding to 75% of interruptions and sustaining speech through backchannels, side talk, and background speech at higher rates than Gemini 3.1 Live and GPT-4o on FDB v1.5 (paper).
- No endpoint threshold to tune, zero-latency backchannels, and prosody-aware timing.

Does not solve:
- **Speaker separation / addressee.** None of the open models has user enrollment. PersonaPlex's voice prompt controls *output* voice. GPT-Live's "focuses on the user's voice amid background noise" is a vendor claim. We would still need personal VAD or speaker verification.
- **Content-aware safety.** The "asked, not needed" and EchoChain results.
- **Faithful content.** They must be prevented from authoring answers, and there is no shipped constraint for that (see the delegate-only request).
- **Long sessions.** FDB-v2 and MTR-DuplexBench find turn-taking and instruction following degrade over rounds.
- **Own transcripts, and deployment weight** (always-on 7-11B).

A duplex interface for us would therefore be "duplex front end that is trained, or constrained, to say only what the text LLM says" (the NVIDIA recipe), which exists as a paper but not as a confirmed release. I could not confirm that checkpoint is published.

---

## Takeaways for our architecture

Ranked by value per effort.

1. **Keep the text LLM as the only author of content; speak it verbatim via a speakable render.** The interface may emit only a closed, logged set of non-content sounds (acknowledgment, holding line, backchannel). Reasons: GPT-Live paraphrases by design; MoshiRAG loses ~5 points and numerics; speech-native models hallucinate instead of abstaining (DSB-DG); gatekeeper failures in GPT-Live (14/75). Changes: a render step, a prompt addendum for spoken mode, a clip set.
2. **Add a heard-prefix ledger to the thread now.** Store full generated text, TTS-aligned heard prefix from the played-sample clock, unheard remainder, and interruption kind. Show the model only the heard prefix plus a marker. Highest accuracy gain per line of code (PACE 25% to 96%, Self-Listening, Venus, Voice-Light). Test: "where did you stop?", "the second one".
3. **Add a modality envelope.** Per turn: modality, ASR low-confidence spans, merged-turn ids, speaker-verified, barge-in info, and separate `input` and `output` modality. Typed turns go straight to the thread, duck or stop speech, and never pass through an interface model.
4. **Speculative generation with cancel, over the existing "continue" branch.** Start a private LLM candidate (and retrieval) at a low-confidence end-of-turn signal; promote on commit; cancel on continuation or a lexical change. This relaxes the 500 ms / 0.6 / 3 s dilemma.
5. **Replace hold/stop barge-in with reversible ducking plus a three-way classifier** (backchannel, floor-take, other voice/noise): fade, pause, then commit or resume. Treat speaker verification and echo as inputs to the classifier.
6. **Run-event-driven gap filling.** One short holding line only after ~1 s of nothing; progress only on state change; never imply success before the event; a watchdog so silence cannot persist; keep listening and allow barge-in during long agent runs (NemotronLabs VoiceChat cannot).
7. **Evaluate learned turn-taking in shadow mode, not as the decider.** Run SoulX-Duplug (and Smart Turn v3.2 as incumbent) on live and replayed audio; log disagreements. Voice-Light's own result says a learned head can look good on false cutoffs and fail on recall.
8. **Duplex model as a lab experiment on GPUs, not a launch dependency.** After 1-7, prototype the NVIDIA prefill-and-repeat pattern or KAME on a GPU, and test "shadow duplex": feed the mic to PersonaPlex/VoiceChat, discard its content, and read only its "would speak now" signal as an additional end-of-turn vote. This second idea is mine and unproven; the SoulX paper suggests such models over-trigger at pauses, so use it as a vote, never as the decider.

### Recommended target architecture

```
mic -> AEC -> VAD | streaming ASR (partials, EOU) | speaker verification | turn controller (heuristics now, learned shadow later)
   -> turn manager: LISTENING / CANDIDATE (private speculative run) / COMMITTED / SPEAKING / DUCKED / HELD
   -> thread (server): messages carry modality envelope; text-LLM agent run (durable, tools, citations)
   -> run events -> speech planner:
        speakable renderer -> clause queue -> TTS (verbatim)
        closed-set sounds (holding lines, backchannels), logged as events
   -> played-sample clock -> heard-prefix ack -> thread
typed turn -> thread directly (ducks or stops speech)
```

### Prototype first, in this order

1. Heard-prefix ledger + envelope + the "where did you stop" test (days).
2. A replay harness over recorded sessions, with labeled end-of-turn, backchannel, floor-take, and TV/echo segments (Full-Duplex-Bench v1.5/v3 style, on our own audio incl. TV at 0 dB). Build the evaluation before changing policy.
3. Speculative candidate + ducking, scored in that harness against today's policy.
4. SoulX-Duplug shadow run on the same harness.
5. GPU-side duplex experiments (NVIDIA recipe or KAME).

### Caveats

Most 2026 numbers are self-reported preprints from the last two months (several arXiv IDs 2609.x), some under review; GPT-Live evidence mixes vendor docs and a handful of GitHub issues; I did not read the full Venus, Gander, or SoulX papers beyond what is cited. The spoken-citation and metadata-convention recommendations are my design, not established practice.
