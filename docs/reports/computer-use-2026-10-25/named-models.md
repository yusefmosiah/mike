# Computer use with Kimi, DeepSeek, GLM (and Qwen3.8 / Holo4): real usage and deployment, as of 2026-10-25

Tags: [V] I read the primary source (page, repo, API, paper text). [R] secondhand / search summary only. [E] my own estimate, not measured.
Extends (does not repeat) research-cu-open-models.md. All benchmark numbers are vendor self-reported unless noted.

## 0. Bottom line

- The product owner is right that people use these models for computer use, but the evidence is lopsided. Kimi has real, first-party, runnable computer-use code. GLM has a first-party GUI agent lineage and a product (ZCode) that uses it for screenshots, but no published desktop-control recipe for 5.3. DeepSeek has no GUI story at all; its real-world "computer use" is text-only DOM browser agents.
- Nobody independent has reproduced any of the headline OSWorld numbers.
- Correction to the first pass: DeepSeek V4.1 Flash is a native image+text model with a from-scratch vision encoder (DeepSeek-ViT) [V HF card], but its published visual benchmarks are chart/puzzle reasoning (Chartography 78.9, BabyVision 89.6, RefCOCO 86.0), not GUI grounding (no ScreenSpot, no OSWorld) [V https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash]. MIT license confirmed [V]. GLM-5.3-Flash MIT is confirmed from HF metadata [V https://huggingface.co/zai-org/GLM-5.3-Flash]. The flagship GLM-5.3 is text-only on OpenRouter and has a custom license [R New Stack].
- New model in the picture: Kimi K3.1 Pro (blog ~2026-10-23, weights promised by Nov 4). Footnote: "OSWorld V2.1 is evaluated with the Kimi Agent harness in the official OSWorld v2 repo" [V https://www.kimi.ai/blog/kimi-k3-1-pro]. A newsletter cites 79.6 on OSWorld-V2.1 vs Opus 5.5 81.8 [R https://handyai.substack.com/p/model-drop-kimi-k31-pro].

## 1. Kimi (K2.5 / K2.6 / K3 / K3.1 Pro)

### 1a. The official harness exists, is open, and is the answer to "what harness produced 84.8"
- **Kimi agent in the official OSWorld repo** [V https://github.com/xlang-ai/OSWorld/tree/main/mm_agents/kimi, read through `gh api`]. README: "a reference framework for a Kimi agent with computer use, built for Kimi k3"; added 2026-08-21 (PR #578); the K2.5/K2.6 version is kept as `KimiAgentLegacy` (README added 2026-04-25).
  - Perception: **screenshot only** (`observation_type` other than `screenshot` raises ValueError in `kimi_agent.py`). No accessibility tree. Screenshots are sent as base64 PNG `image_url` parts to an OpenAI-compatible endpoint; history keeps up to 100 images (`num_max_images=100`), max 100 steps, `max_tokens` 65536, temperature 0 with `--thinking` in the sample command.
  - Action format: native tool calls, **one actionable tool per turn**. GUI mode tools: `take_screenshot`, `execute_pyautogui_code`, `wait_for_state`, optional `ask_user`, `finish_task`. Hybrid mode adds `run_command` (Bash, 600 s max). The model writes pyautogui Python, so it can batch several clicks/keys per step, which cuts round trips. The README also documents swapping in an Anthropic/OpenAI-style coarse `computer` tool (click/double_click/move/drag/type/keypress/scroll/wait/screenshot) if a checkpoint was trained on that shape.
  - Prompt guidance (in `kimi_agent.py`): batch dependent-free actions into one call; "if the same method fails twice or produces no state change, switch methods instead of repeating the same coordinates"; use the real native app for document edits.
  - OS: the environment is OSWorld (Ubuntu VM on Docker/AWS). Nothing there tests Mac or Windows.
  - Run line: `run_multienv_kimi_k3.py --observation_type screenshot --agent_mode hybrid --max_steps 100 --temperature 0 --thinking --base_url https://<endpoint>/v1`.
- K3 numbers: OSWorld-Verified 84.8, OSWorld 2.0 58.3, "reasoning effort max, temperature 1.0, top-p 1.0 for agentic" [V paper arXiv 2607.24653 table 2, https://arxiv.org/html/2607.24653v1]. The paper text I could read does not describe the OSWorld harness, steps or action space, but it does describe white-box RL over many harnesses (so as not to overfit one) and screenshot-inspection ability in §2.4/§4.2. So the Kimi-Agent-in-OSWorld-repo is the likely, not confirmed, source of 84.8 [inference].
- K2.5 evidence (older but better documented): 63.3 OSWorld-Verified "relying solely on GUI actions without external tools"; Operator 42.9, Opus 4.5 66.3 in the same table; WebArena 58.9 [V https://arxiv.org/html/2602.02276v1]. An independent-ish paper (OpenForge-RL, Microsoft/Jianfeng Gao group, under ICLR 2027 review) reuses Kimi-Agent in screenshot-only mode, plus bash and a str-replace editor tool "inspired by Anthropic's computer-use approach", as its main OSWorld harness, and distils trajectories from **Kimi-K2.5 as teacher** (max 30 turns) [V pdf https://arxiv.org/pdf/2607.21557, text extracted locally]. Their table: Kimi K2.5 63.3 OSWorld-Verified (100 steps), OnlineMind2Web 60.4, WebVoyager 74.3 (all copied from the vendor report), vs GPT-5.4 75.0, Opus 4.6 72.7, Qwen3-VL-235B 38.1.

### 1b. Independent evaluations that include Kimi
- **SaaS-Bench** (UniPat-AI, 106 professional-workflow tasks across real SaaS apps, May 2026) [V pdf https://arxiv.org/pdf/2605.15777, text extracted]: agents see rendered DOM plus viewport screenshot and use restricted actions. Overall checkpoint scores (text-only domains): Opus 4.7 42.8, GPT-5.5 42.1, **Kimi K2.6 30.1**, Qwen 3.6 Plus 23.1, **Kimi K2.5 23.6**, Gemini 3.1 Pro 20.6, DeepSeek V4 Pro 21.5 (text-only domains only), GLM-5.1 17.4 (text-only only). Multimodal domains: Kimi K2.6 43.5, K2.5 37.0 vs Opus 4.6 48.7. Average executed steps: K2.6 269, K2.5 270 (Opus 4.7 175). Takeaway: Kimi is the best open-weights entry there but behind frontier closed models and uses ~50% more steps.
- **Desktop-Delta Bench** (NVIDIA, desktop GUI transition understanding, reasoning off for Kimi) [V pdf https://arxiv.org/pdf/2607.26041]: Kimi K2.6 had the best click-AUC (0.857) of 8 models and strong ordering; GLM-4.6V was the weakest (22.6% non-decoy exact match, drag localization 0.34). Same paper cites OSWorld-style scores Kimi K2.6 73.1, MiniMax M3 75.2, Holo-3.1-35B-A3B 80.4. This is perception-of-transitions, not end-to-end task success.
- No independent end-to-end OSWorld reproduction of K3 found.

### 1c. Moonshot's own products (the "people HAVE used it" part)
- **Kimi Work** (desktop agent app, launched 2026-06-10 [R KDnuggets], macOS Apple silicon + Windows). Drives the user's real Chrome/Edge through **WebBridge** (local service + extension over Chrome DevTools Protocol). Perception described as DOM content, screenshots and extracted tables; actions: multi-tab navigation, click, scroll, form fill, scraping, saving a workflow as a skill. Models are Moonshot cloud; K3 supported from Kimi Work 3.1.0 [R https://explainx.ai/blog/kimi-work-desktop-agent-webbridge-swarm-july-2026]. Closed source. Moonshot paused new K3 subscriptions 2026-07-19 [R]. The KDnuggets author did not actually test WebBridge (only a K3 API script) [V https://www.kdnuggets.com/i-tried-kimi-agent-and-heres-what-i-found].
- **Kimi Claw Desktop** (OpenClaw-based): defaults to K2.6, K3 selectable in settings [R https://www.kimi.ai/help/kimi-claw/desktop-deployment-guide].
- **OK Computer** (2025-09-26, K2): a *virtual* computer with file system, browser, terminal, code interpreter, "20+ tools" for slides/sites/reports [R https://www.kimi.com/en/help/agent/agent-overview]. Not pixel-level GUI control; do not count it as computer-use evidence.
- **Kimi Code CLI**: no built-in browser/GUI. Open feature request #945 (2026-06-20) for a Playwright MCP "kimi-browser" says Kimi Code "lacks a built-in or official-plugin way to interact with a web browser visually"; commenters point to playwright-mcp, a stealth CDP MCP, and the Kimi web bridge [V https://github.com/MoonshotAI/kimi-code/issues/945]. Issue #1911: TUI and `-p` mode hang indefinitely on kimi-k3 at max effort [R search summary].

### 1d. Third-party harness integrations and their gotchas
- **OpenClaw**: `moonshot/kimi-k3` via the Moonshot provider plugin, OpenAI-compatible API; guide says K3 can reason over screenshots but shows no computer-use loop [R https://openclawlaunch.com/guides/openclaw-kimi-k3]. OpenClaw issue #109611 "Add support for Kimi K3" [R].
- **Pi**: Sergey Karayev, "Been using Kimi K3 via Pi harness all day and it's the real deal" (coding, not GUI) [R https://x.com/sergeykarayev/status/2083380735994700152, page returned 402]. oh-my-pi issue #5847: K3 needs preserved thinking (reasoning_content) and entitlement-specific context windows [R].
- **opencode**: K3 rejected tool schemas containing `$ref` ("Upstream request failed"), issue #39995 closed as not planned [R]. So MCP desktop servers with `$ref` in schemas may need flattening.
- **Open Interpreter 0.0.40**: Moonshot `kimi-k3` tool calls failed with "non-Responses wire APIs require the compatibility transport" (opened 2026-08-20, closed 2026-09-05); a commenter reproduced the same failure on DeepSeek-V4-flash and traced it to a Codex-sync regression, so it was not Kimi-specific; downgrade to 0.0.39 worked [V https://github.com/openinterpreter/openinterpreter/issues/1883].
- Baseten Switch (route Claude Code/Codex to K3), Deep Agents CLI, opencode/Cline: setup only, no computer-use results [V https://www.baseten.co/blog/how-to-run-kimi-k3-in-any-harness-routing-with-baseten-switch/].
- Cost/behaviour reports: K3 is verbose and thinks a lot; one HN user burned a 5-hour limit on a $19 plan [R https://news.ycombinator.com/item?id=48960218 via search summary]. Thinking is always on, so per-step latency is dominated by reasoning tokens.
- Not found anywhere: Agent S, Cua, browser-use, Hermes, OpenHands, or Goose configs for K3. Do not assume they exist.

## 2. DeepSeek (V4 / V4.1 Flash / 1017)

- **No first-party GUI claim.** HF card: vision = DeepSeek-ViT, native image+text; visual-agent results are Chartography/BabyVision/ZeroBench in the Claude Code harness; agent results are Terminal-Bench 2.1 90.6, DeepSWE 72.6 in DSH Minimal; OSWorld/ScreenSpot absent [V]. OpenRouter metadata: `deepseek-v4.1-flash` and `-1017` input modalities = text+image; older `deepseek-v4-flash`, `-pro` are text-only [V OpenRouter API 2026-10-25].
- One third-party figure: MiniMax's M3.1 Flash comparison lists DeepSeek V4.1 Flash-1017 at 60.5 on Automation-Bench v1.0.6 (a business-automation benchmark with API/GUI mix, not OSWorld) and MiniMax's own OSWorld 2.0 at 61.7 [V https://venturebeat.com/technology/minimaxs-new-m3-1-flash-beats-deepseek-and-opus-5-on-a-key-business-benchmark-at-lower-cost-but-with-a-high-hallucination-rate]. Holo4 page lists Kimi K3 on AutomationBench public set at 46.7, $0.43/task [V]. (Different cuts of AutomationBench; do not compare.)
- **The only real production computer-use example: rtrvr.ai ("Retriever")**, blog dated 2026-06-23, model "DeepSeek V4 Flash" (not 4.1) [V, fetched HTML https://rtrvr.ai/blog/code-as-plan-deepseek-flash-text-only-browser-agent].
  - Harness: Chrome extension / cloud browsers. Perception: **text-only compressed DOM tree**, every interactive element (on or off screen) has a stable ID, cached across calls. No screenshots.
  - Action format: the model writes a **JavaScript plan once** that calls a DSL (`getPageTree`, `find`, `click`, `type`, `pageAction`, `extract`, `processText`, `callTool`, `askUser`...); the harness runs loops locally. Claim: 40-100 model turns collapse into one planning call + a few semantic extractions.
  - Claimed result: "over a 100x cost decrease while preserving the practical browser-agent performance we needed from Gemini Flash-class models." No measurements shown. rtrvr's older Halluminate Web Bench 81.4% (Aug 2025, 323 tasks, no screenshots) predates DeepSeek. rtrvr's own model page shows DeepSeek Flash at only ~2% of calls [R]. Sample runs on rtrvr's data page all use deepseek-v4-flash [V].
  - OS/browser: Chrome, any OS. This is a browser, not a desktop, solution.
- **Pairing with a grounder:** I found no published DeepSeek-planner + UI-TARS/Holo/Qwen-VL-grounder stack. Reputable planner+grounder designs (Agent S, GTA1, OSWorld-Human) use other planners. Treat "DeepSeek planner + Holo4 grounder" as an unproven idea, though technically straightforward given both speak OpenAI-style APIs [E].
- **DeepSeek Harness (dsh)** has no computer-use mode (first pass). Community pairing: DeepSeek V4.1 Flash is used in Claude Code (Anthropic-compatible endpoint) mostly for coding [R https://dev.to/korouter/deepseek-v4-glm-53-and-kimi-k3-in-claude-code-one-config-block-and-what-a-2-hour-session-costs-3i63].
- SaaS-Bench: DeepSeek V4 Pro evaluated on text-only domains only (it had no vision then): 21.5 overall, 236 avg steps, vs Kimi K2.6 30.1 [V]. That is the best available number for "DeepSeek as a DOM-driven web worker".
- A DeepSeek V4.1 Flash NVIDIA model card says "multimodal ... aimed at tool-using agentic applications" [R https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/modelcard].

## 3. GLM (5.3 / 5.3 Flash / AutoGLM lineage)

- **GLM-5.3-Flash docs** [V https://docs.z.ai/guides/vlm/glm-5.3-flash]: "Computer Use Closed Loop" section with a `/goal` prompt ("Use Computer Use to inspect the currently open application... rebuild a working version... operate both original and rebuilt version, compare layouts, state changes... log differences"). CUA/BUA is claimed but no action format, no tool schema, no OSWorld.
- OSWorld 2.0 59.1 and AutomationBench 48.8 for Flash, Terminal-Bench 2.1 84.3 [R Second Talent and Roboflow summaries of Z.ai's post, https://www.secondtalent.com/resources/every-glm-ai-model-explained-compared/ ; the z.ai blog page itself returned only labels]. The Holo4 page and Kimi paper omit GLM entirely.
- **ZCode** (Z.ai desktop harness; macOS/Windows/Linux): 3.14.0 added a "remote built-in browser" that "navigates, fills in forms, takes screenshots"; GLM-5.3 (text-only) hands screenshots to GLM-5.3-Flash for vision [R https://www.dedimarco.com/en/blog/zcode-test-harness-glm-5-3/ ; https://www.testingcatalog.com/z-ai-launches-glm-5-3-flash-under-mit-license/]. "Browser Use and Computer Use" are advertised features. No success rates anywhere. This is the nearest thing to real GLM-5.3 usage and it is a browser-with-screenshots pattern, not pixel desktop control.
- GLM Coding Plan includes Flash (Lite $18, 3x quota) and is documented for Claude Code and OpenCode [R]. I found no report of anyone driving a desktop that way.
- **AutoGLM lineage (real, GUI, but old and small):**
  - `mm_agents/autoglm` and `autoglm_v` exist in the official OSWorld repo (AutoGLM-OS added 2025-08-17); `autoglm` runs `a11y_tree` observation with a 300-item linearized tree and a "GroundingAgent", an `autoglm_computer_use` action space, and code-block output (`WAIT/DONE/FAIL`) [V OSWorld repo via `gh api`]. ComputerRL (arXiv 2508.14040) trained AutoGLM-OS-9B (GLM-4-9B / GLM-4.1V-9B-Thinking) on OSWorld [R].
  - Open-AutoGLM: AutoGLM-Phone-9B on Android/HarmonyOS only, ADB/HDC, screenshot -> JSON actions like `{"action":"Tap","element":[499,182]}`, 24 GB+ VRAM to self-host, no benchmark numbers, no desktop [V https://github.com/zai-org/Open-AutoGLM/blob/main/README_en.md].
  - GLM-4.6V is the weakest in Desktop-Delta Bench [V]. GLM-5V-Turbo OSWorld 62.3 (2026-04, from first pass).
- GLM-5.3 (non-Flash) is text-only [V OpenRouter API]; do not use it as the screenshot model.
- Roboflow vision eval for GLM 5.3 Flash: overall 55.8% (#44 of 63), object detection 33.1% (#55), OCR 55% — i.e. mediocre general visual perception, and weak at localisation, which is what click-grounding needs [V https://playground.roboflow.com/models/z-ai/glm-5-3-flash]. This is evidence against pure-pixel GLM-Flash clicking without a grounder.

## 4. Head-to-head and context
- No test found that runs Kimi K3, DeepSeek V4.1 Flash and GLM 5.3 Flash on the same GUI benchmark. The closest: SaaS-Bench (K2.6 > K2.5 > DeepSeek V4 Pro text-only > GLM-5.1 text-only) and Desktop-Delta (K2.6 >> GLM-4.6V). Both are a generation old.
- Holo4 page [V https://hcompany.ai/newsroom/holo4], H's own harness unless noted: OSWorld Holo4-27B 85.2 ($0.08/task), 35B-A3B 80.8 ($0.05), Qwen3.8-27B 84.3 ($0.22). OSWorld 2.0 (partial/success): Holo4-27B 61.7/41.5% ($1.22), **35B-A3B 30.9/12.3%** ($0.61), Qwen3.8-27B 48.0/19.4% ($3.49), Opus 5.5 81.8/48.7% ($8.48). So the commercially safe Holo4-35B-A3B is much weaker on long tasks than the 27B (non-commercial). AutomationBench: Holo4-27B 45.4, Kimi K3 46.7 ($0.43), Opus 5 50.3.
- Pattern: Kimi publishes an open harness and trains against many harnesses; Qwen/Holo publish cost per task; Z.ai and DeepSeek publish coding/terminal scores. For computer use only Kimi, Qwen and H give numbers you can act on.

## 5. Deployment

### 5a. Hosted, incl. encrypted/attested (vision flags from OpenRouter's public API, 2026-10-25 [V])
| Model | Params | Image input (OR metadata) | Context | OR price in/out $/M (range across providers) |
|---|---|---|---|---|
| Kimi K3 | 2.8T / 104B | yes (+video) | 1,048,576 | 0.15-4.50 / 5.5-22.5 (first-party Moonshot 3.00/15.00) |
| GLM-5.3 | ~750B | **no** | 1,048,576 | 0.07-2.8 / 1.4-8.8 |
| GLM-5.3-Flash | 320B / 18B | yes (+video) | 1,048,576 | 0.04-0.23 / 0.08-2.4 (Z.ai 0.15/0.50) |
| DeepSeek V4.1 Flash (+1017) | 552B | yes | 1,048,576 | 0.02-0.6 / 0.15-2.4 (DeepSeek 0.30/1.20) |
| Qwen3.8-27B | 27B | yes (+video) | 262,144 on most, 1M on Phala/Novita/Alibaba | 0.02-0.99 / 0.5-3.0 |
| Holo4 27B / 35B-A3B | | yes (VLM) | 262,144 | **not on OpenRouter**; only H Models API: 35B-A3B $0.30 in / $0.03 cached / $2.00 out [R https://hcompany.ai/models-api, https://hub.hcompany.ai/models-api/introduction]; "not deployed by any inference provider" on HF [R] |

OpenRouter endpoint objects had no latency/throughput numbers at fetch time (null); I could not find published per-model throughput for these endpoints, so latency below is estimated.

**Phala (our existing gateway).** Phala catalog [V https://phala.com/models; OpenRouter provider page https://openrouter.ai/provider/phala lists 20 models]:
- Kimi K3 (1.0M ctx, $3.00/$15.00, cache $0.30), GLM 5.3 ($1.40/$4.40), GLM 5.3 Flash (Beta, $0.15/$0.50, cache $0.03), DeepSeek V4.1 Flash 1017 (Beta, $0.75/$1.60, cache $0.15), Qwen3.8 27B (Beta, 1M, $0.20/$2.50), plus Phala's "Qwen3.8 27B Uncensored" (262K, $0.30/$1.50). Holo4 is not listed.
- Same models on Phala *through OpenRouter* are cheaper: K3 $2.55/$12.75, GLM-5.3-Flash $0.128/$0.425 (nvfp4), DeepSeek V4.1 Flash-1017 $0.30/$1.20, Qwen3.8-27B $0.20/$2.50 [V OR endpoints API]. Note OR-routed requests pass through OpenRouter, so the attestation chain no longer terminates at our gateway: use the direct Phala endpoint for confidential work.
- Vision on Phala's own pages is **not stated** for any model. RedPill's list (Phala's gateway sibling) marks DeepSeek V4.1 Flash 1017 "Yes", Qwen3.8 27B "Yes", GLM 5.3 "No (text-only)", Kimi K3 "multimodal; image input not confirmed" [V https://redpill.ai/models]. Action item: send one real PNG through the aci/1 gateway to each model before committing.
- Other TEE providers (confidentialinference.net directory, synced 2026-10-25) [V https://confidentialinference.net/]: Tinfoil (TDX + H100 CC, 17 model families, vision yes; DeepSeek V4.1 Flash, GLM 5.3, Kimi K3 named in a secondary review [R]); NEAR AI (TDX + H100 CC, vision flag "No", lists Kimi, GLM, DeepSeek; NEAR serves GLM-5.3-Flash fp8 at $0.08/$0.50 and Qwen3.8-27B at $0.04/$1.35 on OR [V]); Chutes (SEV-SNP/TDX, vision "No" in the directory, but lists Qwen3.8-27B fp8 at $0.039/$1.25 on OR [V]); RedPill (TDX + H100, vision yes, 4 models above); Privatemode, Prem, Venice, PPQ listed with vision yes. Directory flags protection varies by route class, and one source says RedPill's DeepSeek V4.1 Flash traffic may route without confidential hardware [R]. Verify per route.
- Prices of plain hosted providers per OR table above. Moonshot/Z.ai/DeepSeek first-party endpoints are the plain-text baseline and are not confidential.

### 5b. Local "box at home"
Feasibility (weights, memory) and measurements; [E] = my arithmetic.

| Model | Size on disk | 2x DGX Spark (2x128 GB, 200G link) | Mac Studio 256 / 512 GB | RTX 5090 32 GB |
|---|---|---|---|---|
| Kimi K3 | ~1.5 TB (MXFP4) | no | no (4-bit is far above 512 GB; K2.x only fits at 2-3 bit [R]) | no |
| GLM-5.3 (753B) | 4-bit ~380 GB [R] | no | 512 GB at 4-bit only; ~11-17 tok/s [E/R estimates, none measured] | no; text-only anyway |
| GLM-5.3-Flash 320B/18B | NVFP4 184 GiB; Unsloth GGUF 93 GB (1-bit) to 200 GB (Q4_K_XL) | yes, NVFP4 vLLM TP=2 | 256 GB: Q3/Q4 fits [E]; no Mac benchmark found | no (1-bit 93 GB needs CPU offload) |
| DeepSeek V4.1 Flash 552B/16B | 4-bit ~255 GB; 2.9 bpw EXL3 196 GiB | 2 Sparks only at ~2.9 bpw EXL3 (TensorFold) | 512 GB at 4-bit (142 GB peak reported) | no |
| Qwen3.8-27B | Q6 ~22 GB | yes, but slow (bandwidth) | yes | yes |
| Holo4-35B-A3B | Q4 GGUF ~20 GB; NVFP4/FP8 published | yes | yes | yes (Q4/NVFP4) |
| Holo4-27B | non-commercial license | n/a for product | n/a | n/a |

Measurements:
- **GLM-5.3-Flash on 2x DGX Spark, vLLM TP=2, RedHatAI NVFP4** [V repo https://github.com/himorishige/glm53-flash-2x-dgx-spark-recipe, self-reported 2026-09-01/02]: decode 26.5 tok/s single stream (MTP k=3, 262K ctx); 57.7 tok/s aggregate at 4 users; **prefill ~1.4K tok/s flat to 200K, TTFT 139 s at 200K**; **vision works but is off by default** (`LANGUAGE_MODEL_ONLY=0`), vision tower +1 GiB/rank, **per-image time 2.5 s and 4.4 s on the pair (7.8 s and 13.5 s on a single Spark)**, chart probe 4/4, OCR CER 0. Pitfalls: `--block-size 2304` required or output silently corrupts; use `--tool-call-parser glm47`, not `glm`. Other recipes report 14-22 tok/s (bf16 KV / fp8 KV+MTP-4) up to ~47-69 tok/s with a draft model whose license is non-commercial [V https://github.com/tonyd2wild/GLM-5.3-Flash-NVFP4-DFlash2-2x-DGX-Spark ; NVIDIA forum threads, R]. One recipe hit OOM with no crash at a 110K prompt.
- **DeepSeek V4.1 Flash on Sparks** [V https://github.com/tonyd2wild/DeepSeek-V4.1-Flash-vLLM-DGX-Spark, validated 2026-10-19]: TP2 on 2 Sparks with EXL3 2.9 bpw (heavily quantized): 73 tok/s aggregate at 1 stream (84 per stream), TTFT 0.24 s, prefill ~2,100-2,200 tok/s cold, 1M ctx. 4-Spark vLLM lane: 48.5 tok/s at 1 user. **Image input is not confirmed for the TP2 lane** (confirmed only on TP4). Quality is only a 69-scenario tool eval at 97.1 on its own terms. A flowtivity comparison concludes GLM-5.3-Flash is the right pick for exactly 2 Sparks [R https://flowtivity.ai/blog/glm-5-3-flash-vs-deepseek-v4-1-flash-dgx-spark/].
- **Dense models on Spark** are limited by 273 GB/s memory: Llama 70B FP8 ~2.7 tok/s decode, but prefill is fast (gpt-oss-120b MoE: 1,956 prefill / 60.6 decode) [R https://spark.enverge.ai/blog/dgx-spark-prefill-vs-decode]. A 27B dense (Qwen3.8-27B) on one Spark would therefore be roughly 8-14 tok/s at 4-bit [E].
- **Mac Studio** [R https://llmcheck.net/blog/m5-ultra-vs-m3-ultra-vs-m5-max-local-llm/ ; availability: M5 Ultra 96/256 GB shipped since 2026-09-22, 512 GB "coming late October", no price]: bandwidth M3 Ultra 819 GB/s, M5 Ultra 1,228 GB/s. Qwen3.8-27B decode measured 31 (M3 Ultra) vs 48 (M5 Ultra) tok/s at oQ4e (MacStories); prefill 440 vs 1,838 tok/s on 4K prompts (NetworkChuck); Apple BF16 TTFT 18.2 s -> 4.1 s. DeepSeek V4.1 Flash on M3 Ultra 512 GB: 20-38.7 tok/s decode at 16K prompt (oMLX, community; some other pages cite ~84 tok/s prefill but for a different model/quant, unreliable). GLM-5.3: no measured Mac run. Mac prefill is the weak point for screenshot-heavy loops.
- **RTX 5090** [V thread https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/discussions/14, community, llama.cpp, MTP]: Qwen3.8-27B Q5/Q6 UD quants, decode ~90-120 tok/s, prefill ~2,600-3,300 tok/s; with vision on GPU an **image task took 13.7 s total at 2,589 tok/s prefill, and putting the vision projector on CPU made it 76.7 s** (so keep mmproj on GPU); vision+MTP at 65K ctx: ~92 tok/s decode, 1,700-2,100 prefill. Tom's Hardware found llama.cpp unusable on one 5090 for this model (TTFT ~30 min, ~20 tok/s) and vLLM needs 2 cards for good numbers [R]; numbers conflict, so pin the engine and test. No Holo4-35B-A3B throughput found anywhere; as an A3B MoE at Q4 it should decode faster than the 27B but that is [E].
- Nothing measured for Holo4 on any local hardware.

### 5c. Per-step latency estimate (screenshot + reasoning + action)
Assumptions [E]: screenshot ~1.5-3K tokens after downscale; conversation prefix is cached for hosted endpoints (cheap) but local engines re-prefill unless prefix caching is on; action output ~100 tokens plus reasoning. Thinking-always-on models (Kimi K3, GLM-5.3-Flash default max) dominate on reasoning tokens. Reasoning ~300-1500 tokens/step unless effort is lowered.

| Setting | Image + prefill | Decode speed | Typical step | 30-step task |
|---|---|---|---|---|
| Kimi K3 hosted (Moonshot/Phala) | ~1-3 s TTFT | unmeasured; say 40-80 tok/s | 10-30 s (reasoning heavy) | 5-15 min |
| GLM-5.3-Flash hosted/Phala | ~1-2 s | unmeasured; say 80-150 tok/s | 4-12 s | 2-6 min |
| DeepSeek V4.1 Flash hosted/Phala | ~1-2 s | unmeasured; say 80-150 tok/s | 4-12 s | 2-6 min |
| Holo4-35B-A3B on H API | ~1 s | A3B, fast | ~2-5 s (H says tuned for interactive loops [R]) | 1-3 min |
| 2x Spark, GLM-5.3-Flash NVFP4 | 2.5-4.4 s image (measured) | 26 tok/s (measured) | ~15-30 s at 400-700 tokens out | 8-15 min |
| 2x Spark, DeepSeek V4.1 Flash EXL3 2.9bpw | ~1-3 s (prefill ~2.1K tok/s) | 73-84 tok/s | ~6-12 s (vision unverified) | 3-6 min |
| Mac Studio M3 Ultra, Qwen3.8-27B | ~4-6 s (2-3K tok at 440 tok/s) | 31 tok/s | ~15-25 s | 8-12 min |
| Mac Studio M5 Ultra, Qwen3.8-27B | ~1-2 s (at 1.8K tok/s) | 48 tok/s | ~8-14 s | 4-7 min |
| RTX 5090, Qwen3.8-27B | ~1-2 s (measured image 1.9 s) | ~90-100 tok/s | ~5-9 s | 2.5-4.5 min |
| RTX 5090, Holo4-35B-A3B | ~1-2 s | likely >100 tok/s [E] | ~3-6 s | 1.5-3 min |

Levers: cut reasoning effort or disable thinking where allowed (Kimi K3 is always-on; GLM-5.3-Flash has low/high/max), batch multiple actions per call (Kimi-Agent's `execute_pyautogui_code`, rtrvr's JS plan), downscale screenshots, use an accessibility tree first and a screenshot only when needed, keep a prefix cache.

### 5d. Recommendation shape (not a decision)
- If confidential cloud is mandatory and quality matters most: Kimi K3 on Phala is the only option with an open, documented, screenshot-only computer-use harness and a vendor OSWorld claim; cost $3/$15 and slow steps. Verify image input on the ACI endpoint first.
- Cheapest plausible on Phala: Qwen3.8-27B ($0.20/$2.50, vision, 1M ctx, vendor OSWorld 84.3) and GLM-5.3-Flash ($0.15/$0.50, vision, but 59.1 OSWorld 2.0 is unverified and its localisation scores look weak). DeepSeek V4.1 Flash has vision but no GUI evidence; use it as a text/DOM planner, not as the clicker.
- Local at home: single 5090 with Qwen3.8-27B (or Holo4-35B-A3B, commercially safe) is the best latency; 2x Spark is the way to run GLM-5.3-Flash (or compressed DeepSeek) but at ~26 tok/s.
- Because the existing backend runs on Pi/pi-ai, the practical K3 route is "Pi + MCP desktop tools"; mind K3's `$ref` schema rejection and `reasoning_content` echo requirement.

## 6. Gaps
- Z.ai's GLM-5.3-Flash blog and OSWorld 2.0 59.1 not read from the source (page returned labels only).
- Kimi K3 paper §6 harness details unreadable; the K3 -> Kimi-Agent link is an inference. `utils.py` tool schemas not read.
- No latency/throughput for any hosted endpoint; no Holo4 local numbers; no Mac benchmark for GLM-5.3 or K3.
- Phala/Tinfoil/NEAR per-model vision flags unverified on the real attested endpoints.
- X, Reddit and YouTube content mostly not reachable (402/403); several "reviews" are SEO pages with inconsistent numbers and were used only as [R].
