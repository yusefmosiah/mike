---
definition_version: 4
readiness: intent
---

# Private firm stack: program index

Reconciled 2026-10-07. This replaces the overnight execution spine and its
unsupported completion receipts. It is an index of desired outcomes, **not an
executable `/goal` or authority to deploy, migrate, discard WIP, or start later phases**.

## Current authority and evidence

- [`STATUS.md`](STATUS.md): current mission state, owner constraints and proposed course.
- [`TRIAGE.md`](TRIAGE.md): full phase/station/mission crosswalk, inherited obligations,
  evidence levels, preserved receipts and unresolved decisions.
- The existing source candidate, live deployment and owner acceptance are separate
  states. The preceding audit found older live images/schema and uncommitted Mission 2
  work; no deployment or migration was performed during this reconciliation.
- No whole station is established as owner-accepted in the reviewed record.

## Retained outcomes

| Original stations | Current scope | Disposition |
|---|---|---|
| 1–2: documents and self-verification | [Mission 1a](mission-1a-docx-ast-and-reading.md), [Mission 1b](mission-1b-docx-editing.md), [Mission 1c](mission-1c-block-ids.md) | Rebuilt; bounded implementation evidence, real-document/owner acceptance open. Obsolete block-tool goals removed. |
| 3: search and citations | [Search scope](station-3-modular-search-and-citations.md) | Partial; real provider QA, durable source evidence and truthful verification open. |
| 4: context resilience | [Mission 2 scope and receipts](station-4-context-resilience-and-compaction.md) | Compaction exercised; cross-turn raw history/memory/runtime continuity remains separate. |
| 5: conversation tree | [Branching scope](station-5-pi-tree-branching.md) | Mission 3; visible real-app acceptance open. |
| 6: local voice | [Audio scope](station-6-local-audio-stt-tts.md) | Separate Mission 3 outcome; real local speech/UI acceptance open. |
| 7: Auto Mode | [Autonomy scope](station-7-auto-mode-and-guardrails.md) | Mission 4; permission behavior and development/private classifier lane unresolved. |
| 8: private hardening and demo | [Private scope](station-8-private-hardening-and-phala.md) | Original Phase 5; incomplete/later. |
| 9: code and RLM | [Code/RLM scope](station-9-code-execution-and-rlm.md) | Original Phase 6; disabled/unmounted, not accepted. |
| 10: ingestion and mobile | [Ingestion/mobile scope](station-10-mobile-client-and-ocr.md) | Original Phase 6 ingestion and Phase 7 native mobile; distinct incomplete outcomes. |

The [runtime investigation](pi-durable-recon-and-design.md), [firm handoff draft](mission-5-firm-thread-handoff.md)
and [citation-subagent draft](mission-6-citation-verification-subagents.md) are not
silently promoted above established Missions 3 and 4. Document-review subagents are
also a distinct requested workload. Newly numbered Missions 5 and 6 are not the
original Phases 5 and 6.

## Constraints that apply throughout

Privately operated stack; no external Temporal/Cloudflare orchestration. Preserve
RBAC, actor attribution, document integrity, retrievable source evidence and owner
control of outbound access. Explicitly requested inference/source access is not an
implicit exception to privacy enforcement. Embedding Pi versus adopting patterns
remains open; collaborative handoff alone does not choose process ownership.

The proposed dependency order and the complete inherited release backlog live in
`TRIAGE.md`, not in a second mutable station progression here. Promote a retained
intent scope only after its authority, real starting state, acceptance and landing
requirements are reconciled; an old `verdict: accept` is not evidence of delivery.
