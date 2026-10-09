---
definition_version: 4

readiness: drafted

finish:
  deliver: >-
    A verification subagent that, for every citation in an answer or a document,
    reports whether the source exists and whether it says what it is quoted as
    saying — with durable, re-checkable evidence — and that runs as a separate
    agent from the one that produced the citation.
  artifact: >-
    A Postgres-backed task model for subagents (child task, checkpoint, step and
    spend limits, cancellation, isolated conversation scope); a citation_checks
    table holding durable snapshots and verdicts; a verifier agent for local
    documents, external connectors and the web; a per-project egress policy with
    an audit row per fetch; and a fixture test with planted false citations.
  acceptance:
    - action: npm test --prefix backend -- src/modules/citations/__tests__/verifier.test.ts
      proves: >-
        Against a fixture containing a true local citation, an altered quote, a
        fabricated citation, a dead URL and a live URL whose text matches, the
        verifier returns the correct verdict per citation and distinguishes
        "not found" from "quote mismatch".
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/citations/__tests__/verifier.test.ts -- durable
      proves: >-
        Snapshots survive a process restart and are re-checkable from the stored
        hash; the verifier refuses to grade a citation produced by the same
        agent invocation; a project with egress denied performs no outbound
        fetch and reports the citation as unverifiable rather than verified.
      evidence_class: local_test
    - action: probe on a real document with real citations
      proves: >-
        On a human-authored document, each citation resolves to a block id or a
        URL with a stored snapshot, and a third person can re-run the check
        months later and get the same verdicts.
      evidence_class: local_probe

value:
  better_means: >-
    Every quoted authority in a firm's work product can be re-checked by a third
    person, with evidence, without trusting the model that wrote it.
  goodharting_would_be: >-
    Reporting substring matches as verification, letting the producer grade its
    own citations, or storing evidence only in process memory (today's
    citation-snapshot map).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/STATUS.md
    - goals/pi-durable-recon-and-design.md
  must_preserve:
    - Private-stack constraint: subagents are Postgres rows and worker tasks, not a new service.
    - Per-project egress policy; every outbound fetch is audited.
    - Stable block ids (Mission 1c) are the anchor for local citations.
---

# Mission 6: Citation verification subagents

Status: **drafted, not in the agenda.** This is the design home for the STATUS "later"
item "citation checking by subagents that read the actual source (needs subagent
infrastructure first)". See [`pi-durable-recon-and-design.md`](pi-durable-recon-and-design.md)
§11.3 for the requirements and the Pi-shape comparison.
This assistant-authored future draft is not original Phase 6 and is not execution
authority. Document-review subagents are a separate owner-requested workload,
accounted for in `TRIAGE.md` §2; this citation draft does not subsume that outcome.
The runtime/storage shape remains a proposal until the architecture is selected.


## Verdicts

Three, kept distinct: `exists-and-matches`, `not-found`, `quote-mismatch` (the source
exists but does not say what it is quoted as saying). A fourth state,
`unverifiable` (no egress, unreachable, paywalled), is honest and must never be
reported as verified.

## Evidence per source class

- Local document: `document_id` + `block_id` + content hash.
- Web: URL + `fetched_at` + SHA-256 of the extracted text, stored durably.
- External system: connector id + record id + retrieved-at.

## Preconditions

- Subagent task rows with checkpoints and limits (§11.3), because a verification run
  must be resumable, cancellable and attributable to its actor.
- Durable snapshot storage in Postgres; the current in-memory map
  (`goals/STATUS.md`, station 3) cannot support re-checking.
- Producer/verifier separation enforced structurally, not by prompt.
