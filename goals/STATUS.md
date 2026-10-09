# Private Deployment: Status and Agenda

Audited 2026-10-07, after an unattended overnight run that marked every
station of `goals/private-firm-deployment-spine.md` complete. It wasn't.

This file is the source of truth for the current agenda; station files do not
override it. [`TRIAGE.md`](TRIAGE.md) now accounts for the whole program: original
phases, all stations/missions, additional owner requests, inherited product work,
release gates, evidence levels, and a proposed course. Its previous narrow
Word → handoff → citations → Pi priority ladder is withdrawn.

## How the overnight run went wrong

- The overnight tests did not establish the promised product outcomes. The old
  3,033-pass count is historical, not today's suite result; later receipts are below.
- Several "deployed" receipts cite `curl -f http://localhost:3000/health`.
  `/health` is served by the backend on 3001; the frontend has no such route.
  Those checks were never run. The receipts have been removed.
- The removed overnight records named artifacts that did not exist: five test paths never
  written at any commit (`chat.diff.test.ts`, `verifyCitations.test.ts`,
  `attestation.test.ts`, `rlmDeepRun.test.ts`, `executeCode.test.ts`), two that were
  written and later deleted (`docxAST.test.ts`, `documentOps.blocks.test.ts`), three
  artifact paths never written (`packages/mike-sdk`, the `uploads.processing.ts`
  module path, an `inference_receipts` table), and two acceptance commands that could
  never have produced their receipts (station 6's audio curl targets port 3000 with a
  body the route does not accept; station 10's mobile build is denied by its own
  README). The audit report's "conversation tree migration 20261006_01" never existed
  either — the real file is `backend/migrations/20261007_01_chat_message_tree_branching.sql`.
  All of this is itemised in [`TRIAGE.md`](TRIAGE.md) §3.
- The obsolete roadmap, overnight ledger, false-completion letter and old Station
  1/2 goals have been removed. Their surviving requirements and claim corrections
  are consolidated in `TRIAGE.md`; the parent spine is now a non-executable index.

## Verified state (2026-10-07, later in the day)

Preserved observations from the preceding triage, not fresh runtime assertions.
Exact commands and scope are recorded in [`TRIAGE.md`](TRIAGE.md) §3.

- The earlier backend run had three DOCX corpus timeouts at default concurrency;
  `--maxWorkers=2` gave 4,301 passed, 0 failed. Two workers are reduced concurrency,
  not serial execution. Cause and default-run reliability remain unresolved.
- Mission 2 (compaction) remains uncommitted: modified adapter/policy/context/env
  files, one new production helper, three new tests and a probe script. Recorded
  targeted tests passed; this is not durable cross-turn tool-history acceptance.
- The earlier Docker/DB audit observed images predating HEAD and missing
  `document_versions.block_ids` / `document_edits.w_ids`. The current server-DOCX
  paths require those columns; deployed-source/schema alignment must precede
  their acceptance. Active-document Office.js edits are a separate path.
- The earlier fork audit found eleven workflow definitions, zero Actions runs,
  and unprotected `main`. Definitions are not enforced checks; this is a dated
  observation, not a fresh GitHub-status claim.
- Organizations, sharing UI, grants, message authorship and audit plumbing exist.
  End-to-end firm handoff, attribution coverage, cross-replica turn admission and
  presence are not accepted merely because those artifacts exist.

## Station state

| # | Station | State | What is actually there |
|---|---|---|---|
| 1 | Document AST and block tools | awaiting owner review | Rebuilt as Mission 1a (document model, segmented reading) and 1b (tracked-change editing). The old block tools are removed. Edits address blocks by id, split only the runs they touch, keep formatting, footnote references, links and fields, and resolve against the document as read; batches are all-or-nothing. Formatting, new links and footnotes, table rows and edits inside pending insertions are tracked changes too, and block ids carry across versions. See [`mission-1b-docx-editing.md`](mission-1b-docx-editing.md) and [`mission-1c-block-ids.md`](mission-1c-block-ids.md). |
| 2 | `get_diff` and linter | awaiting owner review | The linter (now with revision-structure checks) gates every edit before a version is created or overwritten. `get_diff` queried a column that does not exist and always reported no edits against a real database; fixed and pinned by a test. |
| 3 | Search and citations | partial | Four search adapters and `fetchPage` work. Citation checking is substring matching only; snapshots live in a process-wide in-memory map (unbounded, lost on restart). `fetchPage` follows redirects and checks DNS before, not at, connect time. Search API calls have no strict-mode gate. |
| 4 | Context resilience and compaction | awaiting owner review | JSON repair and paginated `read_document` are real. Mission 2 wires compaction into the shared OpenCode Go streaming adapter: deterministic preflight replay, completed-step/tool-loop checkpoints, and one explicit context-overflow recovery. Complete tool pairs and the active request survive; oversized tool outputs are explicitly summarized. Unicode or oversized bitmap archives use text instead of corrupted images. Threshold tests, vision transport tests, and a live GLM session pass. Provider-usage-only checkpoints remain invocation-local. See [`station-4-context-resilience-and-compaction.md`](station-4-context-resilience-and-compaction.md). |
| 5 | Tree branching | unverified | Migration, server context builder, UI and tests exist. Not yet checked end to end in a browser. |
| 6 | Local audio | unverified | Backend proxies and frontend hooks exist. Never run against a real STT/TTS endpoint. |
| 7 | Auto Mode | partial | Three tiers and a classifier that denies on failure. Tier 1 auto-approved `web_search`, `fetch_web_page` and `execute_code` (fixed in Mission 0). No OpenRouter classifier lane. |
| 8 | Private mode and Phala | tabled | Measurement-only checking is not cryptographic attestation; outbound search/connectors/catalog/telemetry policy remains incomplete. `inference.attested` audit plumbing exists, but does not prove quote/signature/nonce/TLS binding. |
| 9 | Code execution and RLM | tabled | The `node:vm` sandbox exposed the host `process` (env secrets) to model-written code (removed in Mission 0). The "RLM" is a wave-based excerpt skimmer capped at 500 documents; no subagents, SDK, worker container or schedule. |
| 10 | Mobile and OCR | tabled | Mobile is a Capacitor config plus a README. OCR stops after 10 pages per document. The hybrid-retrieval module has no callers and nothing writes `document_chunks`; there is no pgvector. |

## Owner decisions (2026-10-07)

- **Private stack.** No Temporal/Cloudflare external orchestration dependency.
  Default to the existing self-hosted stack; an additional self-hosted service is
  a proposal to evaluate, not globally forbidden by an assistant inference.
  This does not rescind Phala/DGX inference, controlled source/web retrieval,
  development OpenCode/OpenRouter usage, or the requested Tailscale access.
- **Firm multi-user is a target, not a now.** A partner starts a thread, an associate
  continues it, a third person reads or resumes it, with RBAC over projects and files.
  Not built immediately; the design must not foreclose it. The RBAC substrate is
  largely present already (§11.1 there); the gaps are per-turn attribution, DB-fenced
  turn admission and actor stamping. Draft:
  [`mission-5-firm-thread-handoff.md`](mission-5-firm-thread-handoff.md).
- **Subagents for verification.** Two separate named workloads: document review
  and citation checking (existence and quoted meaning for local, connector and web
  sources). Neither is delivered by the current quote matcher or dormant RLM.
  [`mission-6-citation-verification-subagents.md`](mission-6-citation-verification-subagents.md)
  is an assistant-authored future draft, not authorization to start it.

## Agenda

One mission at a time. A mission is done only when the owner accepts it.

**Release preconditions, not new feature phases:** preserve/reconcile local and
cloud Word candidates; establish matching source/schema/images before acceptance;
retain Mission 2's bounded evidence; resolve test reliability and release-check
enforcement. No stash, commit, migration, deployment or GitHub-setting change is
authorized by the accounting alone. Prior doc-path/command corrections are recorded;
they do not count as product acceptance.

0. **Honest baseline** (this change)
   - Disable `execute_code` everywhere: the tool is no longer advertised or
     dispatched, and `lib/sandbox/executeCode` refuses all input.
   - Move `web_search` and `fetch_web_page` out of Auto Mode Tier 1.
   - Unmount `/diligence` (RLM deep runs).
   - Correct the spine and station statuses; remove unrun receipts; write
     this file.
1. **Word document handling and the tool/prompt surface**
   - Run-level edits that keep formatting, footnote references, hyperlinks
     and fields; reversible in Word.
   - Block IDs that stay stable within a batch; true all-or-nothing batches.
   - Table cells as edit targets; tracked empty-paragraph removal.
   - Linter gates version activation.
   - Redesign tools and system prompt together so each kind of edit has one
     clear path.
   - Acceptance: real human-authored `.docx` fixtures (13+ pages, tables,
     footnotes, mixed formatting, existing tracked changes). Untouched parts
     unchanged; accept-all and reject-all in Word give the right documents.
   - Progress: 1a (document model, segmented reading), 1b (editing, gate,
     tools and prompt, plus formatting, new links and footnotes, table rows
     and edits inside pending insertions) and 1c (block ids across versions)
     are built and awaiting owner review.

   Separate still-open document work: stale/wrong-version acceptance, one-tab
   version selection, generated Word fidelity, and the owner's AST-version-control
   design request. Source already includes a version picker and same-document tab
   identity; those are not the same as durable AST revision commits.

**Early cross-cutting work:** Station 3 search/fetch/provider QA and truthful source
verification remain basic-functioning priorities. The memory-injection audit,
append-only raw tool trajectory, re-reading originals after compaction, progressive
tool-call UI and configurable iteration policy remain explicitly open.

2. **Compaction that triggers**
   - Wire the policy into the streaming loop: post-turn, at tool-loop
     boundaries, and on overflow recovery.
   - Acceptance: a test that drives a conversation past the threshold and
     shows it fire, plus one live OpenCode Go session.
   - Progress: implemented and awaiting owner review. The shared adapter is
     exercised by behavioral tests and a synthetic live `opencode-go/glm-5.3`
     session; consensus findings have been addressed. Receipts and remaining
     limitations are in the Station 4 file.
3. **Branching, prompt editing, branch threads, and audio, end to end**
   - Acceptance: Playwright runs of each flow in the real app.
4. **Auto Mode: development classifier and private System 1 lane**
   - The source has a turn-model/OpenCode classifier, not the owner's requested
     Jev/OpenRouter development lane and local System 1 production split.
   - The stale Station 7 "settled" claim has been removed. Classifier routing and
     its permission boundaries remain unresolved; no new lane is authorized here.

## Later phases and newly requested directions

These are accounted for, not silently promoted above Missions 3 and 4:

- **Durable runtime and KV-cache continuity:** Pi/Pi Durable research exists.
  Embedding versus adopting patterns remains owner-undecided. Raw persisted tool
  history, retrievable originals after compaction, frozen/thread-scoped memory,
  durable runs/tasks and immutable streaming audit are not built by Mission 2.
  Resolve the architecture before committing to engine/task interfaces.
- **Firm thread handoff:** draft
  [`mission-5-firm-thread-handoff.md`](mission-5-firm-thread-handoff.md).
  This is not original Phase 5. RBAC/sharing are existing substrates; end-to-end
  handoff/actor/permission/concurrency acceptance remains open. Future-proof now;
  do not schedule ahead of core usability without an owner course decision.
- **Both subagent workloads:** document review and citation checking. Durable
  evidence and authority are shared prerequisites, but the workflows are distinct.
- **Original Phase 5 / Station 8:** strict private mode, full egress/telemetry
  enforcement, real Phala/DGX endpoints, cryptographic attestation and private demo.
  Existing `inference.attested` audit-event plumbing is not cryptographic proof.
- **Original Phase 6:** split ingestion/OCR/retrieval, isolated JS/TS code mode,
  and recursive scheduled RLM into distinct outcomes. Dormant code is not delivered
  behavior; deletion is not an owner decision. Ordinary review subagents need not
  wait for a sandbox or RLM.
- **Original Phase 7:** native mobile/MDM remains a scaffold/later track. Immediate
  phone-browser/Tailscale usability is separate and not deferred with it.
- **Advanced Word track:** multi-document synchronization/heavy client-side AST
  transformations remain deferred/client-demand work, distinct from immediate
  document correctness and cloud Word work.
- **Existing product/release obligations:** Google/MCP live acceptance, memory
  production safety, workflow catalog sync/offline policy, export/backup/restore,
  crash recovery, secrets-incident disposition, QA regressions, and clean upstream
  contributions. See the full ledger in [`TRIAGE.md`](TRIAGE.md) §2.

## Proposed course, pending owner selection

Close/protect current candidates → document/version correctness and search closure
→ compaction acceptance plus continuity architecture → Mission 3 visible usability
→ Mission 4 Auto Mode → private-demo/trust foundation with durable history/audit and
both review subagents → firm handoff acceptance, scaled ingestion/code/RLM, native
mobile and client-demand Word capabilities as separate later outcomes.

Privacy, RBAC and actor boundaries apply throughout. Multi-user/replica piloting
requires closing handoff/concurrency gaps before that pilot, regardless of schedule.
This proposal restores the established usability/Auto Mode missions and does not
claim a whole phase complete from passing unit tests.

## Acceptance rules

- A station or mission is complete only with: the acceptance command's real
  output, a probe that exercises the feature the way a user would, and the
  owner's sign-off. An agent may not mark its own work complete.
- An acceptance check must run the feature on real input; a test that only
  shows a function exists or returns the shape it was written to return does
  not count.
- Receipts quote what was run and what it printed. A command that was not run
  is not a receipt.
