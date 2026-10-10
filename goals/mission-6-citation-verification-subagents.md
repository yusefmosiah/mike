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

## Receipts (2026-10-10, assistant-run; not accepted until the owner says so)

What was built (`backend/src/modules/citations/`, migration
`backend/migrations/20261010_03_citation_checks.sql`):

- `verification_tasks`: a checker run is a Postgres row plus a `citations.verify` job,
  not part of the producing turn. It names the producing invocation (the assistant
  message), its actor, a step limit, a checkpoint and a cancellation flag. A check
  constraint keeps the checker's id from being the producer's.
- `citation_snapshots`: the text each verdict was graded against, with its SHA-256.
  `.docx` snapshots carry block offsets, so local quotes anchor to stable block ids
  (Mission 1c); list numbers a reader sees ("23.7.1") are part of the text.
- `citation_checks`: one row per quoted passage, with verdict `exists-and-matches` |
  `not-found` | `quote-mismatch` | `unverifiable`, the reason and the evidence
  (snapshot, block id, offsets, excerpt).
- `projects.egress_policy` (`allow` | `deny`). Every web fetch writes an
  `egress.fetch` audit row first; if that write fails, no fetch is made.
- Reads re-check the asking person's authority at run time; a document they cannot read
  is `unverifiable`, never verified.
- HTTP: `POST /citation-checks`, `GET /citation-checks?chat_id&message_id`,
  `POST /citation-checks/:id/recheck` (regrade from the stored snapshot alone),
  `POST /citation-checks/tasks/:id/cancel`.

Receipts:

- `npx vitest run src/modules/citations` printed `Tests  8 passed (8)`. The fixture
  answer cites a real public contract (`uk-msc-core-terms-v2.2a.docx`) and scripted web
  pages: a true local quote, an altered quote, a fabricated document, a dead URL (404)
  and a live URL with matching text are graded exists-and-matches, quote-mismatch,
  not-found, not-found and exists-and-matches. The `durable` block covers:
  - a worker dying mid-run, then fresh modules resuming from the checkpoint without
    regrading;
  - a third person re-checking every verdict from its snapshot hash;
  - an altered snapshot failing its hash;
  - refusing `invokedBy` equal to the producer, and refusing while the producing turn
    holds the thread;
  - an egress-denied project making no fetch, writing no audit row, and reporting web
    citations unverifiable.
- `STACK_TEST_FRESH=1 npm run test:stack` printed `Test Files  12 passed (12)` /
  `Tests  75 passed (75)`, including `citations.stack.test.ts` against real Postgres:
  - the job row is queued;
  - restart and resume;
  - verdicts, snapshots and `egress.fetch` audit rows are stored;
  - re-checks give the same verdict with the hash intact;
  - the schema refuses a self-graded task row and an unknown egress policy;
  - egress deny makes no fetch.
- Real-document probe (local e2e stack, port 3201): a real model answer from an earlier
  session, citing the same human-authored contract with 12 quotes. Its turn's
  substring check had marked 2 of the 12 unverified.
  - Run by a chat viewer over HTTP: all 12 came back `unverifiable` ("cannot read the
    cited document"), because the viewer has no access to the owner's document.
  - Run with the owner's authority (task row and job queued directly in the local
    db): 12 of 12 `exists-and-matches`, each anchored to a block id, against one
    snapshot `c908cd0e…`.
  - The viewer then re-checked all 12 over `POST /citation-checks/:id/recheck`:
    `rechecked 12 same 12 hash_ok 12`.
  - The first owner run had marked the two "23.7.1 …" quotes `quote-mismatch`. List
    labels were missing from the snapshot; fixed, with a regression test.
- Backend `npm run test:coverage`: 4440 passed, 100 skipped, thresholds met.
  `typecheck:test`, `build`, `typecheck:contracts`: 0 errors. Architecture test passes.
  Local schema-drift reproduction (baseline + migrations vs fresh `schema.sql`): no
  diff.

Deviations and open items:

- The verifier grades deterministically against the stored source text; no model judges
  a quote. "Separate agent" here means a separate task with its own identity and
  authority, refused inside the producing invocation.
- Case-law and connector citations are reported `unverifiable` with a reason; they are
  not yet re-read.
- No UI yet: checks are reachable over HTTP only.
- The in-turn quote check (`chat/engine/verifyCitations.ts`) has the same list-label
  blind spot the probe found. Not changed here.
