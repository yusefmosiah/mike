# Area report: assistant engine and model layer

## 1. Summary

At the fork point (9a0a0a5b) the engine ran a Vercel AI SDK tool loop (`lib/llm/aiSdk.ts` plus provider glue) behind `streamChatWithTools`. Our side replaced that loop with Pi Durable and pi-ai (`lib/llm/pi/runtime.mts`, `providers.mts`) and removed the `ai` and `@ai-sdk/*` packages. Pi stores turns in Postgres, so assistant turns survive a restart, branch and fork as a tree, and compact their own context. On top of that runtime we added: a persistent Python code mode, per-user workstation VMs, an Auto Mode gate, subagents, skills, images in, attested private-model lanes, and shared-thread handoff. Upstream stayed on the AI SDK. Since the fork it has added BYOK providers (Bedrock, Azure, Vertex, Foundry, xAI, Mistral, custom), web search (#661), its own `delegate` subagent tool (#669, #686), workspace-scoped memory and playbooks. Both sides have rewritten `streaming.ts`, `toolDispatcher.ts` and `chat.prepare.ts` heavily, so nothing that touches those files cherry-picks cleanly. The most contributable pieces are the ones that sit beside the loop: the guardrails library and eval corpus, the egress/attestation modules, the injection flag, the Python kernel, and the Pi-independent fixes. The Pi swap itself needs an RFC.

Maturity caveat: `goals/STATUS.md` says nothing from 2026-10-10 on is owner-accepted. Most clusters are shipped to the owner's staging with tests, not accepted.

## 2. Cluster table

| # | Cluster | Bucket | Readiness | Maturity | Upstream conflict |
|---|---|---|---|---|---|
| 1 | Pi Durable runtime replaces the AI SDK loop | MIXED | NEEDS-WORK (RFC) | shipped+tested | high |
| 2 | Durable turns, resume, branching and compaction | MIXED | NEEDS-WORK | shipped+tested | high |
| 3 | Model catalog, routers, River, cost defaults | MIXED | NEEDS-WORK | shipped+tested | high |
| 4 | Attested and strict-private model lanes (Phala ACI) | ADDITIVE | NEEDS-WORK | shipped+tested | low |
| 5 | Python code mode (kernel plus `run_python`) | ADDITIVE | NEEDS-WORK | experimental | med |
| 6 | Workstation VMs and egress proxy | ADDITIVE | FORK-ONLY (for now) | experimental | low |
| 7 | Auto Mode gate, guardrails library, injection flags | ADDITIVE | NEEDS-WORK | mixed (see below) | med |
| 8 | Subagents (`delegate`) on Pi | MIXED | FORK-ONLY | shipped+tested | high |
| 9 | Modular web search and web-citation snapshots | MIXED | FORK-ONLY | shipped+tested | high |
| 10 | Skills (standard SKILL.md) and `youtube-transcript` | ADDITIVE | NEEDS-WORK | experimental | low |
| 11 | Images in (vision) | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| 12 | Shared-thread handoff and `/nr` notes | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| 13 | Generalist prompt, legal framing removed | SUBTRACTIVE | FORK-ONLY | shipped | med |
| 14 | Engine fixes (tool-round limit, parallel lookups, streaming) | FIX | READY/NEEDS-WORK | shipped+tested | high |
| 15 | Vault tools and inline citations in the engine | ADDITIVE | NEEDS-WORK | shipped+tested | med |

## 3. Clusters

### 1. Pi Durable runtime replaces the AI SDK loop (MIXED)
- **What and why.** `lib/llm/pi/runtime.mts` (1,943 lines) runs the chat loop on `@earendil-works/pi-durable`, with `@netzlabor/pi-durable-postgres` as storage in a `pi_durable` schema. `providers.mts` (755 lines) maps every Mike model id onto pi-ai: Anthropic, Google, OpenAI, OpenRouter, Vercel gateway and OpenCode Go, plus declared OpenAI-compatible models. It also keeps the per-request user key, the attestation check and the tolerance shim for local models that write tool calls as text. The reason is crash-safe, forkable turns (`goals/pi-durable-decision-2026-10-08.md`: 24/24 storage conformance, SIGKILL recovery in 75 ms). Chat turns now need `DATABASE_URL` (a direct Postgres connection).
- **Key commits.** `eb8608e9` spike(llm): run OpenCode Go turns on Pi Durable over Postgres; `bae487e6` every Mike model on pi-ai behind the Pi runtime; `73c75732` remove the AI SDK loop, Pi is the only runtime; `9fcbbda9` stop runs no recorded turn will resume. Paths: `backend/src/lib/llm/pi/`, `backend/src/lib/llm/index.ts`, `backend/src/durable/spike/`.
- **Readiness.** NEEDS-WORK. It deletes upstream's provider layer and cannot be merged without an RFC. Pi is pre-1.x ecosystem code, and Postgres becomes load-bearing for chat. Upstream's runtime-level features (BYOK clouds, provider deadlines, stored-reasoning replay, provider web-search tools) would have to be rebuilt on pi-ai or Pi would have to be an optional second runtime. The old `MIKE_LLM_RUNTIME=pi` flag no longer exists, so a flagged path would have to be rebuilt.
- **Dependencies.** The direct-Postgres `Db` layer (`c8d747ec`, which replaced PostgREST) and the migration ledger.
- **Upstream overlap.** Upstream changed `lib/llm/aiSdk.ts`, `providers.ts`, `models.ts`, `types.ts` and added `cloudProviders`, `providerDeadlines` and `vertexAuth`. None of that exists on our side (we deleted `aiSdk.ts`). Upstream has nothing equivalent to Pi.
- **Maturity.** Shipped and tested: `runtime.test.mts` (1,066 lines), `providers.test.mts`, `compaction.test.mts`. Not owner-accepted.

### 2. Durable turns, resume, branching and compaction (MIXED)
- **What and why.** Turns survive a backend restart and re-attach open clients. Messages form a tree: regenerate, edit-prompt and fork into a new chat, with branch numbers, mapped to Pi conversations by stored message id. Compaction triggers on token budget and keeps originals. Interrupted answers are continued, not restarted (`pi/continuation.mts`, `docs/resume-interrupted-answers.md`), with a language guard.
- **Key commits.** `a756ea20` pi-style conversation tree with edit-prompt, regenerate, branches; `4bd1abaf` turns survive a restart; `4afe24c7` resume Word and review-chat turns; `41d9c43f` repair long threads (limits, compaction, prompt cache); `d87263e3` continue interrupted answers. Paths: `modules/chat/chat.tree.ts`, `chat.branches.ts`, `chat.turn.ts`, `lib/llm/pi/compaction*.mts`, `continuation.mts`, `lib/assistantTurnRuns.ts`, migration `20261007_01_chat_message_tree_branching.sql`.
- **Readiness.** NEEDS-WORK. It is tied to the Pi lineage model, and the frontend branch UI ships with it.
- **Dependencies.** Cluster 1.
- **Upstream overlap.** Upstream has no branching or turn durability. It touched `chat.messages.ts` and `chat.prepare.ts` for subagent runs and `response_details`, so expect real merge conflicts.
- **Maturity.** Shipped and tested, including scripted-model Playwright branching flows (`7aceab67`).

### 3. Model catalog, routers, River, cost defaults (MIXED)
- **What and why.** OpenCode Go is the first-class subscription lane, with per-model context and output limits from Models.dev. Models are grouped in the picker by serving provider (`588516fe`), and River (DeepSeek V4.1 Flash 1017, Nemotron 3.5 Super, GLM 5.3 Flash) is declared through `MIKE_MODEL_CONFIG_JSON` (`206c913c`). Volume work defaults to flash models (`8c3f0b4a`, `docs/model-costs.md`). Decision models are used for Auto Mode (`docs/decision-models.md`). The `group` field is documented in `docs/configured-models.md`.
- **Key commits.** `23432acf` OpenCode Go routing, catalog; `6b7b711c` model-specific output limits; `588516fe`; `8c3f0b4a`; `206c913c`. Paths: `lib/llm/models.ts`, `registry.ts`, `endpoints.ts`, `modules/models/`.
- **Readiness.** NEEDS-WORK. The `group` field and picker grouping are small and separable. The catalog content is deployment-specific.
- **Dependencies.** The picker UI (frontend area).
- **Upstream overlap.** Upstream rewrote `models.ts` (+285) for Bedrock/Azure/Vertex/Mistral and added org model lists. Real overlap in the same files.
- **Maturity.** Shipped and tested (`llmModels.test.ts`, `registry.test.ts`).

### 4. Attested and strict-private model lanes (ADDITIVE)
- **What and why.** `STRICT_PRIVATE_MODE=true` refuses hosted lanes before a key is spent, and the egress guard locks down outbound calls. For attested lanes, `lib/llm/attestation/` verifies a Phala-style gateway (ACI, TDX quote, pinned measurement) before every request and stores receipts in `audit_events`.
- **Key commits.** `6e5b553a` strict private mode, attested TEE lane, egress lockdown; `505b42f5` require pinned measurement; `84a4d76d` verify Phala's attested gateway (ACI); `c74f7b4f` check receipts when the client cancels at `[DONE]`; `4ff2345b` persist receipts to audit. Paths: `lib/llm/attestation/`, `lib/privateMode.ts`, `lib/egress.ts`.
- **Readiness.** NEEDS-WORK. It hooks into the model wrapper, so against upstream's loop it would need an adapter. The verifier modules and fixtures stand alone and have tests.
- **Dependencies.** The provider wrapper in `providers.mts` calls it.
- **Upstream overlap.** Upstream's `1da19c20` and `31ff48e3` touch egress and provider deadlines, but nothing is equivalent.
- **Maturity.** Shipped and tested. Phala is live on staging with a receipt.

### 5. Python code mode (ADDITIVE)
- **What and why.** With a workstation VM, the model is offered one tool, `run_python`. Every other tool becomes `await tools.<name>(...)` in a persistent CPython kernel (Mike's own, newline-JSON protocol, snapshots with dill). Each call still passes the dispatcher and mutation gates. Cells appear in chat as "Computing" steps. A first attempt (a QuickJS `run_script`, `a63d0a32`) was retired. The owner decided to make code mode a full requirement with no dual mode (`goals/mission-11-code-mode.md`; research in `docs/reports/code-mode-*.md`).
- **Key commits.** `a63d0a32` run_script in QuickJS (retired); `a7e0a4be` run every tool through a persistent Python kernel; `810cfb6b` teach the code interface and show cells as computing steps; `06e90f5f` one document model, read from Python as `docs`; `b7cfa41c` keep working turns alive. Paths: `lib/codemode/` (kernel, `python.ts`), `modules/chat/engine/tools/toolSchemas.ts`, `__tests__/streamingCodeMode.test.ts`.
- **Readiness.** NEEDS-WORK. It is tied to the dispatcher's `runTurnToolsNow`, the `code_cell` contract event, and a VM. `CODE_MODE_LOCAL_KERNEL_DIR` allows a local python3 kernel in development only. A PR would need a flag and a non-VM execution story. `lib/sandbox/` is still the disabled-by-default `executeCode` stub.
- **Dependencies.** Clusters 1, 6 and 7. The docs-from-Python layer needs the document model (documents area).
- **Upstream overlap.** Upstream has nothing like it. `toolDispatcher.ts` and `toolSchemas.ts` conflict.
- **Maturity.** Experimental: 137 tests passed (receipts in the mission file), live on a dev VM, no staging user linked.

### 6. Workstation VMs and egress proxy (ADDITIVE)
- **What and why.** Each account gets a persistent microVM (NixOS guest, Cloud Hypervisor in production, QEMU in dev) with bash, Python, Node, git and office libraries. VMs come from a pool, temporary wiped VMs go to test accounts, a snapshot is taken per turn, and a logging egress proxy is the only way out. The agent gets `run_command`, `save_to_mike`, and `~/mike` mirrors the user's documents. This replaces per-call consent classification as the safety mechanism (`goals/mission-13-workstation-vms.md`).
- **Key commits.** `6b433f81` guest VM image and run_command tool; `8fa8fe91` Cloud Hypervisor host on node-a; `d0334c2e` connect staging backend, snapshot per turn; `5fcf365f` logging egress proxy; `aa7898fb` give every account its own VM from a pool; `7ecc8972` user documents under `~/mike`. Paths: `infra/workstation/`, `lib/workstation/`, migrations `20261010_07` and `_08`.
- **Readiness.** FORK-ONLY for now. It needs a Linux host with KVM, Nix, ZFS snapshots and vsock, and the design is aimed at boutique-firm self-hosting.
- **Dependencies.** Standalone, but clusters 5, 10 and 15 depend on it.
- **Upstream overlap.** None.
- **Maturity.** Experimental: staging on node-a. Phase 4 (egress) exists. Off-machine backup and hardening are deferred by the owner.

### 7. Auto Mode gate, guardrails library, injection flags (ADDITIVE)
- **What and why.** `lib/guardrails/` holds a three-tier policy and classifier (`f0dbb937`), a decision-model gate (`8d8bd433`), and a layered gate (symbolic facts, decision table, narrow questions: `facts.ts`, `layered.ts`, `decisions.ts`). `streaming.ts` takes an `autoMode` flag that gates every tool call and auto-answers `ask_inputs`. `injection.ts` flags tool results that try to instruct the model (`36604642`). `backend/evals/auto-mode-gate/` has the corpus and runners, and the reports are in `docs/reports/auto-mode-*.md`. Result: the target of under 1% false refusals with 0 false allows was met for research reads and not for consequential writes. On 2026-10-09 the owner retired per-call consent classification as a safety mechanism. Layers 1 and 2 are kept as deterministic boundary policy, and injection flags stay.
- **Key commits.** `f0dbb937`, `8d8bd433`, `8c7e4477`, `44d839c8` review-gated allow rule, `36604642`. Paths: `lib/guardrails/`, `backend/evals/auto-mode-gate/`, `docs/decision-models.md`, migration `20261009_02_auto_mode_decision_model.sql`.
- **Readiness.** NEEDS-WORK. The injection flag and the eval corpus are the most separable pieces. The per-call gate is partly retired by the owner, so offering it would be offering something we have moved away from.
- **Dependencies.** The `streaming.ts` hook, and the user setting for the decision model.
- **Upstream overlap.** Upstream's `courtlistener`/connector approvals touch the same dispatcher. No equivalent gate.
- **Maturity.** The guardrails and tests are shipped. The layered gate is a library and eval that is not wired into the runtime (per its own report). Injection flags are live with a receipt.

### 8. Subagents on Pi (MIXED)
- **What and why.** `delegate` hands a task to a child conversation on the turn's own runner. Types are markdown files (`general`, `citation_check`), with a host that enforces guardrails and serialises writes (`modules/chat/engine/subagents/`, `pi/runtime.mts`, up to 8 per turn and 4 concurrent). The first child type reviews documents.
- **Key commits.** `a6356bd7` delegate document review to a child conversation; `7a9414f7` general and citation_check types on the turn's own runner. Paths: `modules/chat/engine/subagents/`, `__tests__/subagents.test.ts`, `lib/llm/pi/subagents.test.mts`.
- **Readiness.** FORK-ONLY. Upstream shipped a tool with the same name (#669, #686) using its own tables (`chat_subagent_runs`, `user_subagent_defaults`), settings and UI pills. Two designs for the same feature would collide. Our model-memo and type files are borrowable ideas.
- **Dependencies.** Cluster 1.
- **Upstream overlap.** Direct duplicate, high.
- **Maturity.** Shipped and tested.

### 9. Modular web search and web-citation snapshots (MIXED)
- **What and why.** `lib/search/` is a provider adapter set (Keenable, Tavily, Exa, Parallel) with an SSRF-safe fetcher and a reader. Each result is kept as a snapshot so web citations can be verified. It feeds the `web_search` and `fetch_web_page` tools, clickable web citations (`da27c5d8`) and the reader view (`a9953af3`).
- **Key commits.** `51fb62c9` modular web search engine; `d7e1be73` align payloads with live schemas; `da27c5d8`; `a9953af3`. Paths: `lib/search/`, `engine/webSnapshots.ts`.
- **Readiness.** FORK-ONLY. Upstream added `lib/webSearch/` (Brave, DeepSeek, Tavily) and settings and API-key tables (#661). Offering Exa/Keenable/Parallel as extra adapters behind upstream's contract would be a smaller PR than the whole engine.
- **Dependencies.** Cluster 15 (citation verification) uses the snapshots.
- **Upstream overlap.** Direct duplicate, high.
- **Maturity.** Shipped and tested. Staging has search engines turned off (`6cb3ff7a`).

### 10. Skills in the standard format (ADDITIVE)
- **What and why.** `save_skill` and `install_skill` create and change skills from chat in the standard `SKILL.md` format (zip import, folder from the workstation). `skills/youtube-transcript` is the first skill kept in the repo, with `yt-dlp` and `ffmpeg` in the guest. Skills are stored as versions (`20261010_12_skill_versions.sql`).
- **Key commits.** `492e2cf5` skills in the standard format; `4275879b` and `8b661dce` read before changing, same-turn read; `daa32e23` youtube-transcript. Paths: `engine/tools/skillTools.ts`, `lib/skillFormat.ts`, `modules/workflows/`, `skills/`.
- **Readiness.** NEEDS-WORK. Upstream has workflows and playbooks, so a PR needs to explain how skills relate to them. Part of the value (folder skills, scripts) needs the workstation.
- **Dependencies.** Cluster 6 for folder saves.
- **Upstream overlap.** Upstream changed `modules/workflows` for playbooks (`19fb8ea1`). Medium.
- **Maturity.** Experimental, with staging receipts.

### 11. Images in (ADDITIVE)
- **What and why.** Uploaded images are sanitised with `sharp` (EXIF/GPS stripped, decoders restricted, pixel cap), sized per model family and sent as image parts. `POST /models/vision` tells the picker which models "see". A turn that attaches an image to a text-only model is refused with 400 `model_cannot_see_images`.
- **Key commits.** `096578b3` images in; `d8e5f961` show "Sees images" under the React Compiler; `6e791df2` let upload sessions accept images. Paths: `lib/images.ts`, `engine/attachedImages.ts`, `lib/llm/models.ts`.
- **Readiness.** NEEDS-WORK. It is self-contained and tested, but it is split across upload, UI and model catalog. It needs a rebase onto upstream's model catalog and sends parts through Pi's message type.
- **Dependencies.** Clusters 1 and 3.
- **Upstream overlap.** Medium. Upstream's `aiSdk.ts` has no vision input.
- **Maturity.** Shipped and tested, browser check recorded.

### 12. Shared-thread handoff and `/nr` notes (ADDITIVE)
- **What and why.** A database turn claim (`chat_turn_claims`) lets a colleague continue a thread without two turns running. Presence shows "someone is generating", only the sender can stop a turn, and the model is told who wrote each message. `/nr` adds a message (with attachments) without asking for a reply. Code in a shared thread runs in its starter's workstation.
- **Key commits.** `63c363c6` firm thread handoff with a database turn claim; `5d8746db` only the sender stops a turn; `ee26edcd` tell the model who wrote each message; `4fda5fb7` /nr; `543a40dd`. Paths: `lib/turnClaims.ts`, `chat.presence.ts`, `chat.notes.ts`, `chat.sharing.ts`, migration `20261010_02`.
- **Readiness.** NEEDS-WORK. It has a frontend half and has been tested by a three-browser e2e. It leans on the Pi turn lifecycle.
- **Dependencies.** Cluster 2.
- **Upstream overlap.** Medium, in `chat.routes.ts` and `chat.sharing.ts`.
- **Maturity.** Shipped and tested.

### 13. Generalist prompt, legal framing removed (SUBTRACTIVE)
- **What and why.** The assistant introduces itself as an open-source general knowledge-work agent, not a legal assistant (`1505b508`, `a54ec976`, Mission 8). Legal tools (CourtListener) remain.
- **Paths.** `engine/prompts.ts` (+101/-51), `engine/wordPrompt.ts`.
- **Readiness.** FORK-ONLY. It is a product-positioning decision.
- **Upstream overlap.** Medium. Upstream added only 5 lines to `prompts.ts`.
- **Maturity.** Shipped.

### 14. Engine fixes (FIX)
- **What and why.** The tool-round limit is now a runaway backstop instead of a budget (`80c6e3f7`). Lookups in a round run in parallel and writes run in order (`6f44db13`). Early tool-call detection flushes the visible text tail (`fc546ef1`, `fb301032`). Long-thread repairs cover model limits, compaction, prompt cache, asks and language (`41d9c43f`). A held response keeps a waiting ask (`a88df2ae`, taken from upstream). The MCP trailing-dot SSRF fix (`a35a1c5b`) was ported from upstream's `1da19c20`.
- **Readiness.** READY for the two or three fixes that are not Pi-specific (parallel lookup/ordered write rounds, round-limit semantics). The rest depend on Pi.
- **Upstream overlap.** High, in `streaming.ts` and `toolDispatcher.ts` (upstream +410 and +345 lines there since the fork).
- **Maturity.** Shipped and tested.

### 15. Vault tools and inline citations in the engine (ADDITIVE)
- **What and why.** `vault_secrets`, `vault_request_secret` and `vault_lease` give the agent use of credentials without it seeing them. The server issues inline citation markers at the claim, and `check_citations` verifies a document's citations with a judge that must quote its evidence. The vault and citations areas belong to other triage reports. This engine-side wiring is noted because it adds tools and prompt rules.
- **Key commits.** `6ddfbd17` host-side secrets vault; `07df0783` harden the vault after a multi-model security review; `893203b3` cite inline at the claim; `62338aa5` durable citation verification as checker tasks. Paths: `engine/tools/vaultTools.ts`, `engine/citations.inline.ts`, `verifyCitations.ts`.
- **Readiness.** NEEDS-WORK; see the vault and citations reports.
- **Maturity.** Shipped and tested.

## 4. PR candidates (ordered)

1. **"Flag prompt-injection attempts in tool results"** (`lib/guardrails/injection.ts`, the hook in the dispatcher, its tests). It is small and model-agnostic, needs no Pi, and has a live receipt. Make it a warning only and off by default.
2. **"Run read-only tool calls in a round in parallel, writes in order"** plus **"Make the tool-round limit a runaway backstop"** (`6f44db13`, `80c6e3f7`). They need rebasing onto upstream's dispatcher.
3. **"Add the Auto Mode eval corpus and decision-model harness"** (`backend/evals/auto-mode-gate/`, `docs/decision-models.md`, the reports). It is evidence and tooling with no runtime change, and pairs with the guardrails library.
4. **"Verify attested inference gateways and persist receipts"** (`lib/llm/attestation/`, strict private mode, audit receipts), written against a provider-wrapper hook so it works with either loop.
5. **"Python kernel for code execution (behind a flag)"** (`lib/codemode/kernel/`). Offer the kernel and protocol first (credits in `CREDITS.md`, no copied code), and the `run_python` tool later. Alternatively open the Pi runtime as an RFC issue instead of a PR.

## 5. README digest

- Every model call goes through Pi Durable and pi-ai. Chat turns are stored in Postgres, so an answer interrupted by a restart is continued, and a thread can be branched, regenerated or forked.
- Models come from several lanes: subscription (OpenCode Go), routers (OpenRouter, Vercel gateway), the native Anthropic/Google/OpenAI APIs, and declared OpenAI-compatible endpoints. The picker groups them by provider and marks the ones that can see images.
- A strict private mode and an attested lane keep traffic on operator-declared endpoints and check the gateway's attestation before every request.
- With a workstation VM, the assistant works in Python: it writes code cells that call the same tools it would otherwise call one at a time, and it keeps variables between cells. Each user has their own VM, and its only way out is a logging egress proxy.
- The assistant can delegate work to subagents, search the web through pluggable providers, keep skills in the standard `SKILL.md` format, and look at images when the model supports it.
- Several people can share one thread. A claim in the database stops two turns from running at once, and `/nr` adds a note without asking for a reply.
- An Auto Mode gate, flags for instructions hidden in tool results, and an eval corpus are included. The per-call consent gate is not the safety mechanism we rely on. Containment in the VM and deterministic rules at the boundary are.
