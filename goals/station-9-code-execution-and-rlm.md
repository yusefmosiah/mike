---
definition_version: 4
readiness: intent
---

# Station 9: Sandboxed Code Execution & TypeScript RLM Diligence

> **Incomplete — retained intent, not implementation authorization.** Original
> roadmap Phase 6 (code/RLM half). Code execution is disabled and the
> diligence HTTP route is unmounted. No station acceptance is established in the
> reviewed record. The stale review header and invalid test-path recipes have been
> removed; implementation limits are below. See [`TRIAGE.md`](TRIAGE.md)
> §3. [`STATUS.md`](STATUS.md) is the authoritative agenda; this scope is not
> scheduled ahead of the current missions, and promotion is an owner course
> decision, not an assistant default.

## Retained goal (desired)

Two related capabilities on owned compute, neither built:

1. A secure JS/TS execution sandbox for exact financial/tabular computation —
   isolated from the host: no network, no filesystem, no environment/secrets,
   strict resource caps, and a module API for self-contained programs.
2. A recursive TypeScript RLM engine for overnight diligence over large data
   rooms (original scale target: ~5,000-document data rooms) — REPL harness,
   modules exposing workflows/skills, recursive child/subagents, scheduling and
   fully unattended operation. The original framing also named speculative
   redlining and firm-memory consolidation; those are not separately scheduled
   today.

## Constraints to preserve

- Read-only, copy-on-write access to original matter vaults during overnight
  diligence; a run writes exactly one new document (the cited memo) through the
  documents facade.
- Zero network egress from code execution and RLM workers.
- Unattended: no ask/pause surface in the run toolset; a run finishes or fails.
- Excluded: running untrusted foreign binary executables.
- Ordinary document-review and citation subagents do not require a sandbox or
  RLM and must not wait for them.

## Source implemented (inspected 2026-10-07)

- `lib/sandbox/executeCode.ts` is a refusal stub: every call returns
  "execute_code is disabled: code execution has no isolated runtime yet."
  `execute_code` is no longer advertised or dispatched (Mission 0 honest
  baseline). The removed `node:vm` version exposed the host `process`
  (environment secrets) to model-written code; it lives in git history at
  `b0e80cc` and must not be restored.
- A bounded wave-based excerpt skimmer exists in `modules/diligence/`
  (`rlm.deep_run` handler, still registered in `jobs/registry.ts`): default 3
  waves (max 10), default 200 documents (max 500), per-document excerpt
  ceilings, a bounded findings state carried wave to wave, and one cited memo
  written through the documents facade. Its HTTP route is unmounted in
  `app.ts`, and its only tool seam now calls the disabled stub, so even a
  manually enqueued job cannot execute code.

## Observed limits (dated audit observations, not runtime claims)

- No isolated runtime of any kind is declared; code execution stays disabled
  until one exists. There is no REPL/module surface, no recursive subagents, no
  worker container, no SDK package, no schedule, and no unattended-operation
  policy or operational recovery. The skimmer is not a recursive RLM engine
  and its coverage quality is unmeasured.
- Unit tests exist (`modules/diligence/__tests__/rlmDeepRun.test.ts` with a
  scripted DB and injected services; `lib/sandbox/__tests__/executeCode.test.ts`
  pinning the refusal, including the host-intrinsics escape); they pin source
  behavior, not product acceptance.
- Dormant diligence code is classified and protected: deletion is not an owner
  decision, and missing wiring is not an abandoned requirement.

## Unresolved acceptance outcomes

- Sandbox isolation proof on a real runtime: host process/env unreachable, no
  network, no filesystem, resource caps enforced; re-enable `execute_code` only
  with that evidence.
- A real unattended overnight run on a real corpus: recursive REPL/subagent
  behavior, bounded data-room scope, memo output, no human pause, scheduling
  and recovery demonstrated.
- Prerequisites named in STATUS/TRIAGE: usable ingestion, permissions,
  subagents and limits.

## Mapping

- Original Phase 6 → this station plus the ingestion portion of Station 10
  (`TRIAGE.md` crosswalk). STATUS "Original Phase 6": split ingestion/OCR/
  retrieval, isolated JS/TS code mode, and recursive scheduled RLM into
  distinct outcomes; dormant code is not delivered behavior.
- TRIAGE outcomes: "Sandbox/code mode" and "RLM / 24-hour night shift".
- Proposed course D ("Scale and client expansion") covers this station; RLM
  requires safe execution, usable ingestion, subagents, limits, unattended
  policy and recovery.
