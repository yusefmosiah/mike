# Status and Agenda

Updated 2026-10-09 with the owner's direction for the next missions. First
written 2026-10-07, after an unattended overnight run that marked every
station of `goals/private-firm-deployment-spine.md` complete. It wasn't; the
rules at the end of this file exist so that cannot happen again.

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

## Where things stand (2026-10-09)

Recorded from this session's own runs; receipts are in the commit messages and
in the overnight report (`docs/reports/overnight-2026-10-09.md`) once written.
"Built" means source implemented and exercised locally; nothing here is owner
accepted until the owner says so.

On `main` (pushed 2026-10-09, `1e35b24`), awaiting owner review:

- **Pi runtime (Mission 7).** Every model call runs on pi-ai behind Pi Durable
  (`backend/src/lib/llm/pi/`); the AI SDK loop is gone. The database client
  queries Postgres directly (`backend/src/lib/db/`); PostgREST and the rest of
  Supabase are gone, GoTrue stays as the auth server, and no Supabase names
  remain outside history. Docker Compose runs stock Postgres + GoTrue.
- **Restart-safe turns on every surface.** A turn cut off by a restart or
  deploy resumes when the backend starts again: chat, project chat, cloud Word
  chats and tabular review chats (`backend/src/turnResumers.ts`). Verified live
  by killing the backend mid-answer for tabular and Word: the answer finished,
  stored once, complete. A client still attached when the server dies now
  re-attaches to the resumed turn on every surface (Mission 12).
- **Branch threads are titled** "BRANCH <title>", "BRANCH 2 <title>", ...
  across a whole family; **chat titles** retry once instead of steering the
  model to a "Misc. Query" fallback, which now appears only when the model
  fails twice.
- **Local e2e and stack harnesses** run without editing env files
  (`scripts/e2e-local-stack.sh`, `backend/scripts/test-stack.sh`).
- **General knowledge-work prompt (Mission 8).** Every assistant surface
  presents Mike as a general assistant with legal work as a strength; ordinary
  questions are answered, current events go to web search.
- **Cleanup (Mission 12).** Read-aloud no longer re-renders on every streamed
  chunk (the React update-depth failures); corpus tests have a 60 s budget;
  the local e2e account gets one configured model; open clients re-attach
  after a restart (incarnation frames, shared reconnect policy); dev runs
  background jobs inline under tsx.
- **Subagents (Mission 9).** `delegate` hands a task to a document-review
  child with its own tools and budgets; the web app shows its line, its
  transcript and what it cost; audit rows record both spends. Open for the
  owner: children run one at a time; flat-rate model costs show list prices.
  See `mission-9-subagents.md`.
- Last full runs (2026-10-09, after Mission 9): backend 4268 passed, 90
  skipped; frontend 2179 passed; lint 0 errors; local e2e (Mission 12) 62
  passed, 4 skipped (LLM-gated, need `ANTHROPIC_API_KEY`).
- Still open: the `mike-backend-1` Docker dev image predates these
  changes; the page title ("Mike - Legal AI Platform") and onboarding step 2
  ("Your legal practice") still read legal-only.

Later on 2026-10-09 (overnight, `44d839c8..908b92fe`), awaiting owner review;
receipts in `docs/reports/overnight-2026-10-09.md`:

- **Staging** runs at https://choir-ip.com on node-a (Podman compose behind
  Caddy, all container ports on loopback, daily restore-checked backups,
  five-minute health checks, kept out of search engines). No account exists
  there yet; `mike-staging owner-link <email>` signs the owner in.
- **Mission 13**, phases 1–4 built and exercised, phase 6 started: guest
  image and `run_command`; `ws-owner` under Cloud Hypervisor reached over
  vsock from the staging backend; a host snapshot before each turn's first
  command, restore after `rm -rf ~/*` verified by hash; a logging egress proxy
  as the VMs' only way out; prompt-injection flags on tool results. Phase 5
  (dogfooding) is the owner's.
- **Mission 11**, first slice: `run_script` runs model-written JavaScript in
  QuickJS with tools as `tools.*`, through the same gate and dispatcher; on
  in staging behind `CODE_MODE_ENABLED`.
- **Mission 10**, first slice: Settings → Voice with four engines (operator,
  OpenRouter, browser on-device, browser open models), prices in each model's
  unit, consent-gated browser model setup, and a test bench. No browser model
  has been downloaded live.

The Pi decision (`pi-durable-decision-2026-10-08.md`) is taken: Pi is embedded
(option B). Mission 3's branching design no longer waits on it.

## Owner direction (2026-10-09)

- **Mike is a general knowledge-work agent.** Legal features are a strength
  because everyone needs legal help, not the boundary of what Mike answers. The
  system prompt must not refuse ordinary questions ("what are the baseball
  scores") or frame every chat as legal.
- **Subagents** are built on Pi Durable's task-owned conversations, informed by
  the Pi subagent extensions (`pi-subagents`, `@tintinweb/pi-subagents`) but
  not copied from them: those are coding-agent tools built on files and
  processes, Mike's authority is the user's access to projects and documents.
  Default model is the chat model; the calling model may choose any model the
  user may use, guided by a frequently edited model-selection memo with
  pricing and speed tiers. Child transcripts are not sidebar threads: a
  collapsed control under the tool call opens them. Message passing is designed
  now (addresses, typed envelopes) and built later.
- **Code mode** (Pi 1.0 style: QuickJS sandbox, tools as `tools.*` functions,
  only script output reaches the model) is a later mission. Designs made now
  must route every tool call through one dispatcher so code mode can reuse it.
- **Workstation VMs replace per-call Auto Mode** (2026-10-09, later the same
  day). Each employee gets a persistent microVM (microvm.nix, Cloud
  Hypervisor) with a full OS; the harness stays outside it; safety comes from
  containment, host-side snapshots and an egress proxy. Decision models remain
  for prompt-injection and PII labelling only. See `mission-13-workstation-vms.md`.
- **Decision models.** Evaluate the OpenRouter decision models for Auto Mode and
  other decisions, configurable in app settings, with particular interest in
  small open-weight models Mike can run itself (Liquid's open d1-3B and
  d1-omni-600M, Kev 4B, Tev1 4B, Clef-flash 9B). OpenRouter's `liquid/d1` is a
  larger closed model, distinct from the open d1 checkpoints.
- **Voice.** Local options through the browser (on-device recognition, the
  operating system's own voices, WebGPU models) plus OpenRouter for testing
  parity and coverage, plus any OpenAI-compatible server so Mike's own GPU
  hardware can serve it later. OpenRouter voice is a test lane, never strict
  private mode. Models are configurable and comparable in app, with prices. A
  browser model download is opt-in, offered as "about N minutes of setup",
  with N estimated from a small speed test, never as a size in megabytes.
- Spending: up to $2 of OpenRouter calls per overnight run for evaluation and
  voice tests, recorded in the report.

## Agenda

One mission at a time, in this order. Work lands on `main` as soon as it is
good (owner direction, 2026-10-09): a short-lived branch off `main` per change,
fast-forwarded into `main` and pushed to `origin/main` once its tests pass, so
no long-running branch builds up. Each landing is reported with the commands
run and what they printed. No mission is marked accepted by the agent.
Staging (choir-ip.com) is the only deployment; production is not deployed.

| # | Mission | State | File |
|---|---|---|---|
| 7 | Pi runtime, GoTrue-only, restart-safe turns, branch titles | built, awaiting review | this file; `pi-durable-decision-2026-10-08.md` |
| 12 | Cleanup: tests, live reconnect, docs | built, awaiting review | [`mission-12-cleanup-2026-10-09.md`](mission-12-cleanup-2026-10-09.md) |
| 8 | General knowledge-work system prompt | built, awaiting review | [`mission-8-general-agent-prompt.md`](mission-8-general-agent-prompt.md) |
| 9 | Subagent foundation (document review first) | built, awaiting review | [`mission-9-subagents.md`](mission-9-subagents.md) |
| 4 | Decision models and Auto Mode (plus the layered gate: research meets <1%/0, writes do not) | built, awaiting review | [`mission-4-decision-models.md`](mission-4-decision-models.md); [`docs/reports/auto-mode-gate-eval-2026-10-09.md`](../docs/reports/auto-mode-gate-eval-2026-10-09.md); [`docs/reports/auto-mode-layered-gate-2026-10-09.md`](../docs/reports/auto-mode-layered-gate-2026-10-09.md) |
| 13 | Workstation VMs: microvm.nix + Cloud Hypervisor, harness outside, recovery and egress boundary (replaces per-call Auto Mode) | phases 1–4 built, 6 started; 5 is the owner's dogfooding | [`mission-13-workstation-vms.md`](mission-13-workstation-vms.md) |
| 10 | Voice: local, OpenRouter and self-hosted | first slice built, awaiting review | [`mission-10-voice.md`](mission-10-voice.md) |
| 3 | Branching, prompt editing and branch threads, end to end | next | [`station-5-pi-tree-branching.md`](station-5-pi-tree-branching.md) |
| 11 | Code mode | first slice built, awaiting review | [`mission-11-code-mode.md`](mission-11-code-mode.md) |
| 6 | Citation verification subagents | later, on top of 9 | [`mission-6-citation-verification-subagents.md`](mission-6-citation-verification-subagents.md) |
| 5 | Firm thread handoff | later | [`mission-5-firm-thread-handoff.md`](mission-5-firm-thread-handoff.md) |
| 1, 2 | Word editing (1a–1c), compaction | built, awaiting review | mission and station files |

Still open from the earlier agenda, not scheduled tonight: Station 3 search and
citation closure; re-reading originals after compaction; progressive tool-call
UI; configurable iteration policy; memory-injection audit; Phala and
cryptographic attestation (Station 8); OCR, ingestion and mobile (Station 10);
release obligations in [`TRIAGE.md`](TRIAGE.md) §2.

## Earlier state (2026-10-07, historical)

The verified-state notes, station table and agenda from the 2026-10-07 audit
are kept in git history (`git show b331d70:goals/STATUS.md`). Their surviving
open items are folded into the agenda above and into [`TRIAGE.md`](TRIAGE.md).

## Acceptance rules

- A station or mission is complete only with: the acceptance command's real
  output, a probe that exercises the feature the way a user would, and the
  owner's sign-off. An agent may not mark its own work complete.
- An acceptance check must run the feature on real input; a test that only
  shows a function exists or returns the shape it was written to return does
  not count.
- Receipts quote what was run and what it printed. A command that was not run
  is not a receipt.
