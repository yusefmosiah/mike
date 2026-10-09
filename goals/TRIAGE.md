# Whole-project accounting: phases, missions, open work, and release gates

As of 2026-10-07. This replaces the earlier deployment-centered priority ladder.
It accounts for the accessible local user-request history, the original roadmap,
all ten station outcomes, current mission documents, inherited product documentation,
source inspection, preserved verification receipts, and the fork's open PR.

**Scope limit:** work or instructions still only in the owner's Claude cloud session
are not visible here. They are an explicit unreconciled workstream, not assumed absent
or complete. There is no defensible overall completion percentage.

[`STATUS.md`](STATUS.md) remains the current execution agenda. This file is the full
accounting and proposed course, not authorization to start every item. A requirement
may be approved while its implementation or position in the schedule remains open.

## 1. Evidence and naming rules

Separate five things: **source implemented**, **locally exercised**, **real-app/provider
exercised**, **deployed at a named revision**, and **owner accepted**. Tests existing on
disk establish only the first of those. A passing mocked test is not real Word, real
speech, or a private deployment. Earlier labels such as `working-verified` blurred this
boundary and are not carried forward.

No whole deployment station is established as owner-accepted in the reviewed record.
This does not mean nothing works: it means the broad finish lines remain unproved.
Historical receipts below are dated observations, not fresh claims about today's
running services. No implementation, migration, deployment, CI setting, or code deletion
is authorized by this accounting.

### Numbering crosswalk

The same work has been numbered several times. Do not conflate these namespaces.

| Original numbered roadmap | Ten-station spine | Current agenda / present disposition |
|---|---|---|
| Phase 0: stock local bring-up and baseline QA | Cross-cutting baseline | Local stack and OpenCode Go were exercised; broader legal-workflow acceptance is incomplete. Mission 0 is the later safety/reset cutover, not the same phase. |
| Phases 1–2: document model, edits, self-verification | Stations 1–2 | Mission 1a document model/reading, 1b editing/linter/tools, 1c stable IDs; implemented, awaiting real-document/owner acceptance. |
| Phase 3: search, citation verification, guardrails | Station 3; Auto Mode later moved to Station 7 | Search/citation work remains partial. Auto Mode is current Mission 4, separately after core usability. |
| No original standalone context phase | Station 4 | Current Mission 2: repair, bounded context, compaction; locally exercised and live text-lane probe recorded, uncommitted. Durable cross-turn history is separate unfinished work. |
| Phase 4: core usability | Stations 5–6 | Current Mission 3: edit prompt, regenerate, branch navigation, branch into a new thread, dictation, read-aloud. Source exists; user reported missing controls; actual-surface acceptance remains open. |
| Auto Mode split out by owner | Station 7 | Current Mission 4: permission tiers and classifier. Partial; OpenRouter/Jev development lane absent. |
| Phase 5: private hardening, Phala/DGX, demo | Station 8 | Tabled/partial; enforceable egress and cryptographic attestation not delivered. No private demo acceptance. |
| Phase 6: OCR, sandbox, RLM | Station 9 plus ingestion portion of Station 10 | OCR/retrieval partial; sandbox disabled; RLM unmounted and not a true recursive REPL/subagent engine. |
| Phase 7: native mobile | Mobile portion of Station 10 | Scaffold only; native app/security/device acceptance absent. |
| Deferred advanced Word track | No independent station | Multi-document synchronization/heavy client-side AST capabilities remain client-demand/deferred work. This is distinct from the immediate Word-document correctness work. |
| Newly requested durable agent runtime | Pi Durable design report | Investigation exists; embed Pi versus adopt its patterns is still owner-undecided. |
| Newly requested firm handoff | `mission-5-firm-thread-handoff.md` | Assistant-authored draft; **not original Phase 5**, not promoted to execution. |
| Newly requested citation subagents | `mission-6-citation-verification-subagents.md` | Assistant-authored draft; **not original Phase 6**, not promoted to execution. |

Original lettered Phase B was document AST/block tools and C was self-verification
(owner request 2026-10-07T00:49:19Z). Exact A and D titles are not recoverable from the
reviewed record; do not invent them. The numbered roadmap explicitly describes the
advanced Word track as deferred. Old `docxAST.ts`/block-tool work was superseded, not
an additional unfinished implementation to resurrect.

## 2. Full outcome ledger

### Documents and Word

| Outcome | What exists / evidence | What remains / next discriminator |
|---|---|---|
| Preservation-first DOCX reads | Mission 1a, committed at `c79c447`; `backend/src/lib/docx/`; corpus and section-reading tests | Real long-document acceptance with tables, fields, links, footnotes, mixed formatting, existing revisions. |
| Atomic tracked edits and self-verification | Mission 1b (`ff47074`) and extensions at `4f0f186`; linter gates versions; `get_diff` database-column bug repaired | Real Word accept-all/reject-all and untouched-part fidelity, not just XML/test acceptance. |
| Stable block IDs across edits/re-upload | Mission 1c; `document_versions.block_ids`; tests and migration `_04` | Validate identity across the owner's document lifecycle in the deployed app. |
| Native formatting, links, footnotes, tables | Edit engine supports these; probes/corpus receipts exist | User-reported generator markdown/XML leakage, table-cell footnote markers, clickable links and full regeneration fidelity are **not closed by editor support**. Exercise generation separately from editing. |
| One document tab with version selection | `AssistantSidePanel.tsx:56-105` keys tabs by document ID; `DocumentVersionPicker.tsx:37-56,108-135` lists/selects versions; panel resolution is version-aware | User's stale/wrong-version report remains an acceptance case. Verify read/edit base version, latest/current selection, older-version navigation, restore, and download fidelity end to end. |
| Version control over the AST | Owner design/problem statement 2026-10-07T06:03:19Z; current versions and hashes are file/version-based | No evidence of durable AST commits with parent pointers and deterministic revision-to-file projection. **Design request**, not covered by stable block IDs or a picker. |
| Active Word-document tracked edits | Office.js path: `apply_word_edits` → client tool bridge → `useWordDoc.ts:2334-2560`; 26 hermetic e2e specs exist | Actual Word host apply/accept/reject/reopen proof. Mock-only automated coverage cannot settle this. Cloud-session changes must be reconciled before conflicting local work. |
| Attached/generated server DOCX artifacts in task pane | Backend creates versions and emits `doc_created`/`doc_edited` | Prior audit found no corresponding pane SSE rendering branch. Do not call the Word integration complete while an advertised operation produces no visible artifact. This is separate from active-document Office.js editing. |
| Active Word-document snapshot/version history | Canonical edit rows and bookmark-based reconstruction exist | No byte-version chain evidenced for the active Word document. This is a different scope from library document versioning; decide only if the product needs it. |
| Word scroll/layout and long batches | Historical scroll investigation and mocked specs exist | Real WebView regression matrix; late client-tool effects after timeouts; accept/reject after pane close/reopen. See `docs/word-addin-chat-scroll-report.md` and `docs/word-addin-development.md`. |
| Advanced Word integration | Existing Office.js tools | Multi-document synchronization/heavy client-side AST transformations remain deferred; not a prerequisite for immediate document correctness. |

### Agent context, continuity, and core usability

| Outcome | What exists / evidence | What remains / next discriminator |
|---|---|---|
| JSON/tool-call repair and overflow recovery | Station 4 and Mission 2 receipts; one explicit overflow reduction/retry; completed tool-pair preservation within invocation | Not a general network retry policy. Earlier request for backoff was investigative; no broad retry implementation should be inferred or added automatically. |
| Token-triggered compaction | Working-tree SDK changes, deterministic replay, threshold tests, PNG/text transport tests; recorded live GLM text lane | Uncommitted; awaiting acceptance. Usage-only checkpoints are invocation-local. PNG summaries are prompt representations, not lossless archives. |
| Cross-turn raw tool history and re-reading originals | Visible user/assistant history survives; display events are persisted | Actual tool arguments/results are not durable cross-turn transcript entries. `enrichWithPriorEvents` reconstructs a recap. Requested append-only agent history plus retrieval after compaction is **not delivered by Mission 2**. |
| KV-cache discipline | Mission 2 preserves supplied prefixes; explicit model windows/output limits documented | Prior-turn recap changes historical assistant content; memory can alter the earliest context. No measured cache-hit target established. Need immutable history/memory policy, not merely smaller prompts. |
| Memory injection audit and thread-start policy | `memory/prompt.ts:43-99,120-146` loads current scoped memory; `streaming.ts:501-509` assembles it per invocation; audience protections exist | Owner requested audit/thread-start behavior. Current content-derived fence is stable only while memory is unchanged; no frozen per-thread memory snapshot is evidenced. Keep learned memory distinct from raw conversation originals. |
| Bounded document reading | DOCX block/section/full-read controls in Mission 1a; compaction accounts for large results | PDF/scan coverage and extraction provenance remain ingestion work. Word page layout is not a stable structural edit coordinate. |
| Vision/Snapcompact | SDK image transport and declared vision capabilities; text fallback and vision adapter tests | Live vision archive behavior across supported focus models and general image-upload UI acceptance are not established by the recorded GLM text-only probe. |
| Edit prompt, regenerate, branch navigation | Tree migration, server context builder, action components/hooks/tests | Owner reported missing controls on the actual app. Mission 3 needs visible-surface proof, edited prompt creates correct branch, leaf selection persists, and reload uses the intended history. |
| Branch into a new thread | Source/actions exist | Independent acceptance case, not interchangeable with regenerating an answer or switching siblings. |
| Dictation and read-aloud | Audio proxies, microphone capture/playback hooks and mocked tests | Real private STT/TTS operator, correct formats, editable draft without autosubmit, interruption/stop, phone/desktop surface proof. No real speech endpoint receipt reviewed. |
| Progressive tool-call visibility | Early `onToolCallStart` and parsed-input notification in `aiSdk.ts:904-939`; streaming callback at `streaming.ts:751` | Earlier frozen-looking UI report needs real-app regression proof; existence of callbacks is not closure. |
| Configurable tool-loop ceiling | `DEFAULT_MAX_ITERATIONS = 16` and `params.maxIterations ?? 16` remain | Historical `LLM_MAX_TOOL_ITERATIONS`/32-default proposal was not implemented. Recover desired policy while doing Auto Mode; do not silently raise limits. |
| Model catalog/output/vision metadata | `models.ts`, `docs/configured-models.md`; Models.dev maintenance procedure | Keep catalog current; stale selector report and each focus model's live behavior are not separately accepted. No need to rerun all provider tests merely to inventory this. |

### Search, verification, and autonomy

| Outcome | What exists / evidence | What remains / next discriminator |
|---|---|---|
| Modular search and fetch | Keenable/Tavily/Exa/Parallel adapters and tests | Requested real search-provider QA, strict privacy gates, redirect/connection-time DNS handling. Prior code audit records partial protection, not enforceable deployment-wide privacy. |
| Current citation checks | Local/case quote checks and web snapshots; `engine/verifyCitations.ts`, `lib/search/engine.ts` | Snapshot storage is a process-local Map; substring matching is not proof of claim entailment. Unified coverage across assistant/tabular/Word requires acceptance. |
| Citation-checking subagents | Draft Mission 6 and runtime investigation | Verify existence **and** quoted meaning for local documents, connectors and web. Durable evidence, uncertainty verdicts, constrained authority and re-checking; not implemented as subagents. |
| Document-review subagents | Explicit owner request 2026-10-07T21:38:21Z; Pi report §11 | Separate workload, not folded into citation checks or the disabled excerpt-skimming RLM. Findings should identify document/version/block and source evidence; implementation/acceptance absent. |
| Auto Mode permission tiers | Policy/classifier integration and fail-closed tests; unsafe Tier-1 tools removed in Mission 0 | Mission 4 is still required. Manual/client choice, denial/continuation, classifier failure, read/write scope and prompt-injection behavior need real scenarios. |
| Development vs production classifier | Source uses turn-model/OpenCode classification; owner request specifies Jev/OpenRouter development, local System 1 production | Stale "settled" station wording removed. The implementation still lacks the requested OpenRouter/Jev lane; routing and permission acceptance remain open. |
| Sandbox/code mode | Unsafe host exposure removed; `execute_code` is now a refusal stub | Isolated JS/TS execution with resource/network/filesystem boundaries and module API. Remains disabled until a real sandbox exists. |
| RLM / 24-hour night shift | Unmounted bounded wave/excerpt worker and DB-job registration | Requested recursive REPL, modules exposing workflows/skills, child agents, data-room boundaries, unattended policy and scheduling are not delivered. Needs sandbox, ingestion, subagents, permissions and operational recovery. |

### Firm platform, private deployment, and mobile

| Outcome | What exists / evidence | What remains / next discriminator |
|---|---|---|
| Firm RBAC and sharing | Organizations/members/invitations, project/chat grants, role matrix, sharing UI, message author IDs, scoped memory | End-to-end partner → associate → third-person continuation; correct project/file permissions and attribution. Existing author columns mean attribution is partial, not wholly absent. |
| Cross-replica single-turn ownership | Process-local `<surface>:<chatId>` run registry and 409 | No DB-fenced run admission established. Firm handoff does not by itself require replacing the whole runtime; design must also cover effects, revocation, resume and existing shared document concurrency. |
| Durable runtime architecture | Pi/Pi Durable research and divergent option space | Embed vs pattern adoption **still open**. No approved cutover or durable entry/task implementation. A DB claim alone does not deliver raw history, audit, recovery or subagents. |
| Immutable streaming audit | Current audit rows, queued turn audit, signed/tamper-evident exports | Immutable streaming event journal is not the same feature. Durable event ordering, effect attribution, replay, access and retention requirements remain design/implementation work. |
| Strict private mode and external boundaries | Boot/provider gates exist | Close search, CourtListener, Google/MCP, catalog download and telemetry boundaries; no automatic unapproved cloud fallback. Validate deployed behavior, not just settings. |
| Phala attestation and inference receipts | Measurement check and `inference.attested` audit-event plumbing documented | No cryptographic quote/signature/nonce/TLS proof. Absence of a dedicated `inference_receipts` table does **not** mean no audit receipt plumbing exists. Confidential lane not accepted. |
| DGX/local model and speech serving | Configurable OpenAI-compatible endpoints; original deployment target | Actual owned-compute inference/speech, TLS/trust configuration, limits/performance and real endpoint proof remain unknown. |
| Private demo milestone | Original Phase 5 target | Not achieved: a live matter workflow with private inference, usable UI, verified citations and honest attestation claims. Do not require mobile/RLM to demonstrate the core product. |
| OCR/chunk ingestion/retrieval | Ten-page OCR cap; `document_chunks` schema; uncalled trigram/RRF retrieval module | Populate/search chunks from real ingest and retain source provenance; handle full scans. No pgvector implementation. Wiring is missing, not reason to delete an approved future requirement. |
| Native mobile | Capacitor configuration and README | Architecture decision (`frontend/out` export vs firm-hosted origin), native projects, secure credentials, biometrics/blur/backups/MDM, speech and real-device proof. Scaffold, not completed app. |
| Phone browser/Tailscale access | User reported successful access, then later login/control problems; local stack exists | Secure origin/callback/session and realistic narrow-width QA. Distinct from the native mobile phase; current acceptance unknown. |

### Inherited product and release work outside the new feature phases

These are existing surfaces or explicit documented release gates, not invented new
missions. Documentation limitations are not automatically promises to add features.

| Workstream | Accounting / disposition | Evidence |
|---|---|---|
| Legal workflow and tabular baseline QA | Existing app/API/catalog, synthetic NDA/lease/MSA fixtures; full legal-workflow acceptance remains incomplete. Keep inherited legal app rather than rebuild it. | `qa-contracts/`, `CONTRIBUTING.md:42-85`, existing e2e specs |
| Local container runtime | Docker Compose is the documented/running baseline; owner asked whether Podman could replace it. No settled Podman decision or support receipt recovered. Preserve the working baseline while evaluating portability separately; do not migrate containers during accounting. | User request 2026-10-06T19:34:01Z; `docs/local-development.md` |
| Workflow catalog release | Immutable-ref ingestion/defaults/add-ons exist; releases must synchronize catalog/assets. Private/offline distribution needs the egress decision. Archived built-in workflow spec is not a new backlog. | `docs/deployment.md:69-87`, `CONTRIBUTING.md:70-85` |
| Google Drive / Gmail / Calendar | Implemented integrations; dated record reports Drive live reads, but Gmail/Calendar consent/writes/current-head sign-off pending. Operator credentials/consent are required. | `docs/test-evidence/google-integrations-2026-09-23.md`, `docs/google-workspace.md:82-97` |
| MCP/connector approvals | Existing OAuth/tool controls; Word/tabular refuse writes that need approval UI. Permission/egress integration matters for private release. | `docs/connectors.md:126-139` |
| Memory production safety | Existing curator/CAS/revocation logic; explicit retention/secret, audience, role, concurrency and settlement/latency launch gates remain unaccepted. | `docs/memory.md:229-247` |
| Export/audit evidence | Signed manifests and async exports exist; that is not immutable journal acceptance or full tenant-safe export proof. | `docs/tamper-evident-exports.md`, export integration tests |
| Backup, crash/restart and restore | Runbook specifies a drill and known process-local receipt/stream loss window; no executed restore/drill receipt reviewed. Back up DB before migration. | `docs/recovery-drill.md:6-64`, `docs/deployment.md:16-55` |
| Security incident disposition | Owner reported GitGuardian JWT/service-role alerts; no closure receipt recovered. Determine whether historical demo tokens or real credentials before making any security-complete claim. Do not expose/rotate anything during accounting. | User request 2026-10-06T21:48:12Z |
| Source/deployment alignment | Earlier audit observed old running images and missing `_03`/`_04` columns. Protect WIP and verify release identity before Word acceptance. | Prior psql/Docker receipts; migrations and compose replay list |
| CI and test reliability | Earlier fork audit found no Actions runs/unprotected main. Default-worker backend suite had DOCX timeouts; maxWorkers=2 passed. Diagnose contention, not suppress warnings or declare a cause from those two runs. | Prior commands below; workflow definitions |
| Coverage/mutation backlog | Stale percentage tables and unchecked "untested" PR lists removed. Choose tests from current code and consumer-visible risk, not old checkboxes. Mutation-runner limitations remain dated evidence, not proof that all other tests are missing. | `docs/frontend-testing.md`, `docs/testing-coverage.md`, `docs/test-depth.md` |
| Downloads / source-document route acceptance | Prior static audit found missing direct route exercise; implementation exists. Verify on real consumer paths as part of baseline QA, not a speculative rewrite. | Backend module audit; download/CourtListener surfaces |
| Upstream contributions | Owner requested clean PR slices. Local-main merge does not establish upstream acceptance. Old PR1–9 list is historical; obsolete block-tool slice must be replaced by current model work. | User requests 2026-10-06T20:42–20:43Z; original roadmap recovered before removal |
| Open mobile-scroll PR | Fork PR [#1](https://github.com/yusefmosiah/mike/pull/1); one-line overflow change; PR states clipping/root-cause/QA uncertainties. Not accepted just because branch exists. | Read-only fork PR listing/body |
| Evaluation program | Real-document QA is required now; owner explicitly asked which standard legal evals to consider. Evaluate suitable datasets/criteria as requested. A broader ongoing model scorecard program remains a proposal, not an authorized new implementation mission. | User request 2026-10-06T19:34:01Z; earlier QA requests and initial briefing |

## 3. Source, deployment, and acceptance receipts

Preserved observations from the preceding triage; **not re-run for this documentation**:

- Targeted compaction command: four test files, 77 passed.
- `npm test --prefix backend`: 4,298 passed, three 20-second corpus timeouts,
  51 skipped; two files failed under default worker concurrency.
- `npm test --prefix backend -- --maxWorkers=2`: 4,301 passed, 51 skipped,
  232 files passed, seven skipped. This is lower concurrency, not serial execution.
- Earlier Docker/psql audit: live `document_versions` lacked `block_ids` and
  `document_edits` lacked `w_ids`; images predated HEAD. No deployment/migration was
  performed by the accounting work.
- Earlier fork GitHub audit: 11 workflow definitions, no workflow runs, no main
  branch protection. Configured checks are not enforced checks.
- Mission 2 record includes a synthetic live GLM text-lane probe and panel findings.
  This is distinct from broad real-document, vision-provider or UI acceptance.

Current read-only git accounting still finds HEAD `4f0f186`, Mission 2 source/test/env
WIP, and uncommitted accounting/design documents. Source candidate: one new production
helper (`conversationCompaction.ts`), three new test files and one probe script, plus
modified adapter/policy/context files. No stash entries were listed. Do not discard,
stash, land or migrate WIP solely because this file recommends closure.

Historical claims audit distinguished wrong paths from fabricated functionality:
five named test paths never existed; two were written then removed; three artifact
paths never existed; audio/mobile commands were incompatible with their contracts.
Several referenced tests exist at different paths, so **a bad path alone does not prove
no tests**. The old report/ledger and obsolete Station 1/2 goals have been removed.
Retained future station scopes are non-executable intents; current Mission 1/2
review receipts must not be read as owner acceptance of every delivered outcome.

## 4. Proposed course: finish core usefulness before expanding the platform

This is a recommendation, not a silent change to the owner's schedule. The earlier
P0 → Word → handoff → citations → Pi ladder is withdrawn: it dropped Missions 3/4,
moved deferred firm handoff ahead of basic usability, and treated a claim-table design
as settled before the runtime choice.

### A. Close and protect the current candidates

Reconcile local source with cloud Word work; preserve Mission 2; establish exact source,
schema and running-image identity before accepting documents. Resolve test reliability
and release-check enforcement in proportion to the next release. These are release
preconditions, not a new feature phase or authority to reconfigure GitHub/DB now.

### B. Deliver the usable legal-agent loop already requested

1. **Mission 1 acceptance and document/version correctness:** real reads, edits,
   generation, version choice, no stale base, and correct Word accept/reject/fidelity.
   Separate server DOCX from active-document Office.js work.
2. **Search/fetch closure (Station 3):** useful provider behavior, truthful citations,
   source retrieval and safe/private egress. This was an explicit basic-functioning
   priority and must not disappear behind runtime work.
3. **Mission 2 acceptance plus continuity design:** retain the bounded compaction work,
   but separately decide raw tool-history persistence, memory snapshots and re-reading
   after compaction. Open the embed-vs-pattern decision before irreversible engine/task
   interfaces; do not mislabel compaction acceptance as architecture completion.
4. **Mission 3 usability acceptance:** edit prompt, regenerate, navigate branches,
   create a new thread, microphone/dictation/read-aloud; prove visible controls in the
   actual app, including phone browser use. Branching and audio remain separately
   provable slices even though STATUS groups them.
5. **Mission 4 Auto Mode:** resolve the classifier-plan conflict; prove allow/ask/deny,
   failure and scope behavior. Development hosted classification and production local
   classification are different deployment choices.

Steps 1–5 preserve the established core agenda and recover search/version/memory work
it omitted. Shared browser QA can cover multiple steps; do not rebuild existing working
code because its acceptance was missing.

### C. Establish the private-demo and trust foundation

Private inference/egress/telemetry enforcement, actual DGX/Phala endpoint acceptance,
cryptographic attestation if claiming it, trustworthy audit and crash/restore proof are
required for the original private-demo milestone. Search access must be policy-controlled,
not banned accidentally when the owner wants source verification over the web.

In parallel at the design level, resolve durable runtime/append-only history/tasks and
scope them for multi-user RBAC. Then deliver **both** document-review and citation-checking
subagent workloads with durable evidence. The exact implementation order is open;
privacy and attribution are invariants from the start, not bolt-ons after agents run.

Firm handoff is a future-proofing requirement now and a separate later product acceptance.
Do not pull it ahead of the owner's basic-usability work solely because a turn-claim
artifact looks reusable. Conversely, pilot with multiple users/replicas requires closing
its permission, actor, concurrency and revocation gaps first.

### D. Scale and client expansion

Split original Phase 6 into independently deliverable ingestion/retrieval, sandboxed
JS/TS code mode, and recursive scheduled RLM. Ordinary document review does not require
RLM or a code sandbox. RLM does require safe execution, usable ingestion, subagents,
limits, unattended policy and recovery.

Native mobile/MDM and advanced Word synchronization remain later tracks. Immediate
phone-browser access and core Word fidelity are not deferred with those tracks.
Keep the dormant retrieval/RLM code classified and protected; deletion was an assistant
suggestion, not owner approval to abandon requested future outcomes.

## 5. Decisions, unknowns, and ownership

- **Runtime:** embed versus adopt patterns remains open. Decide using the completed
  research and concrete history/branch/task/Word/RBAC requirements, not a model vote.
- **Auto Mode:** current implementation and agenda disagree on classifier lane.
  Retain the owner's dev/private split until a specific superseding decision is found.
- **Private stack:** no Temporal/Cloudflare external orchestration. This does not
  rescind expressly requested Phala inference, controlled web/source access, development
  OpenCode/OpenRouter, or Tailscale. Additional self-hosted infrastructure is a proposal
  with operating cost, not globally prohibited by an assistant inference.
- **Document history:** file versions/selection already exist; AST revision commits are
  a separate design proposal requiring evaluation, not approved implementation scope.
- **Cloud work:** reachable repository and local archive cannot establish what remains
  only in Claude cloud. Obtain that handoff/branch before claiming exhaustive closure.
- **Upstream:** no claim of upstream submission/acceptance from local-main merges.
- **Acceptance:** no percent-complete tally or blanket `done`; each outcome needs its
  own product-path evidence and owner disposition.

## 6. Provenance and document map

Sources: all accessible project prompt records (2026-10-06/07), original scoping
roadmap recovered before removal, station/mission files, prior triage command output,
source ranges cited above, current read-only git accounting, current-origin PR listing,
and inherited feature docs.
No source changes, deployments, migrations, CI changes or live provider tests were made
in this accounting pass. Earlier passing/failing checks were not repeated.

Research slices in this pass: PhaseHistory, BeyondSpine, AccountingCorrections
(session-scoped outputs). Durable references are the repo documents and request
timestamps above; agent IDs alone are not durable acceptance evidence.

- [`STATUS.md`](STATUS.md): current agenda and proposed next course; authoritative state.
- This file: whole-program map, evidence levels, open outcomes and dependencies.
- Current Mission 1/Station 4 files: scope and bounded implementation receipts.
- [`pi-durable-recon-and-design.md`](pi-durable-recon-and-design.md): runtime investigation,
  not an approved build sequence.
- Draft Mission 5/6 files: future requirements, not execution authorization.
- Superseded scoping/overnight ledger/false-completion letter, obsolete Station 1/2
  goals, archived built-in workflow design and retired Google-client notice: removed.
  Their current requirements, corrections and release caveats are retained here or
  in the current workflow/Google documentation. Retained station scopes and coverage
  guides no longer carry stale execution/completion claims or unverified test queues.
  Measured incident history and bounded implementation receipts remain; no stale-document archive was added.
