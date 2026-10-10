---
definition_version: 5

readiness: drafted

finish:
  deliver: >-
    A citation checker that, for every citation in a document (one the assistant
    drafted, or an uploaded one it edited), reports whether the source exists,
    whether quoted words are really in it, and whether the document's use of it
    reflects what the source says — flagging a source that says the opposite —
    with durable, re-checkable evidence, checking citations in parallel, and
    running separately from the conversation that wrote the document.
  artifact: >-
    A Postgres-backed task model for subagents (child task, checkpoint, step and
    spend limits, cancellation, isolated conversation scope); a citation_checks
    table holding durable snapshots and verdicts; a verifier agent for local
    documents, external connectors and the web; a per-project egress policy with
    an audit row per fetch; and a fixture test with planted false citations.
  acceptance:
    - action: npm test --prefix backend -- src/modules/citations/__tests__/documentCheck.test.ts
      proves: >-
        Against a drafted memo citing a case whose holding is the opposite, a
        fabricated case, a misquoted statute, a page that supports its use and a
        dead URL, the checker returns the correct verdict per citation and
        distinguishes "not found", "contradicted", "quote mismatch" and verified.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/citations/__tests__/documentCheck.test.ts
      proves: >-
        Snapshots survive a process restart and are re-checkable from the stored
        hash; the verifier refuses to grade a citation produced by the same
        agent invocation; a project with egress denied performs no outbound
        fetch and reports the citation as unverifiable rather than verified.
      evidence_class: local_test
    - action: probe on a real document with real citations
      proves: >-
        On a real document with real citations, each citation resolves to the
        block that cites it and a source with a stored snapshot, and a third
        person can re-run the check months later and get the same evidence.
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


## Scope (owner direction, 2026-10-10; definition v5)

The owner narrowed and sharpened the target. In their words: citations in the
assistant's replies "can be assumed fine. the point is to protect the user from
hallucinations"; the target is "documents created with the agent", and "if a user
uploads a doc, we could obv check citations of that too. often user will upload
something then assistant will edit it". Checking must run "in parallel", must go beyond
word-for-word comparison to "making sure that the usage in the doc reflects the essence
of the citation", and the user must be told "in a response if model thinks that the
citation says something opposed to what its purported to say". When to run: "not for
every edit of a doc, but when citations change, when docs substantively change, and
before committing a doc to be sent out". The UI is the owner's partner's call; for now
an on-demand check plus the assistant's own `check_citations` tool.

## Verdicts

Kept distinct, most serious first: `not-found` (no such source), `contradicted` (the
source says the opposite of the document's use), `quote-mismatch` (the quoted words are
not in the source), `unsupported` (the source does not say it), `exists-and-matches`
(verified, including partial support). `unverifiable` (no egress, unreachable, not
located, or the judge could not tell) is honest and is never reported as verified.

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

## Receipts, document checks (2026-10-10, assistant-run; not accepted until the owner says so)

What was built (`backend/src/modules/citations/`, migration
`backend/migrations/20261010_05_document_citation_checks.sql`):

- `citations.extract.ts`: a model lists the document's citations. The document is read
  as paragraphs with stable block ids, in windows of about 24k characters run in
  parallel. For each citation it returns the citing paragraph, the citation as written,
  its kind, any URL, any quoted words and the proposition the document uses it for.
  The list is stored on the task's checkpoint.
- `citations.sources.ts`, `locateSource`: a URL is fetched; a case goes through
  CourtListener citation lookup and opinion text, falling back to a web search
  (CourtListener is mostly US law); anything else goes through a web search whose top
  two pages are candidates. Every outbound request (fetch, case lookup, search) writes
  an `egress.fetch` audit row first and honours `projects.egress_policy`.
- `citations.judge.ts`: a separate model call, with none of the drafting
  conversation. It sees the citation, the citing paragraph, the proposition and the
  source's most relevant passages (term-scored windows within a budget), and answers
  identified / supports | partial | does-not-support | contradicts | unclear / reason /
  evidence. Evidence must be an excerpt that is really in the source: otherwise
  "supports" or "contradicts" becomes "unclear".
- `citations.tasks.ts`:
  - `startCitationCheck(documentId, versionId?)` uses the current version unless one
    is named;
  - `runCitationCheck` checks citations in parallel (`CITATION_CHECK_CONCURRENCY`,
    default 6), resumes from stored rows, honours cancellation between citations and
    bounds a run with its step limit;
  - `summarizeCitationCheck` produces what the assistant relays;
  - `recheckCitation` re-matches the quote and the judge's excerpt against the stored
    snapshot and its hash.
- Checker model: `CITATION_CHECK_MODEL`, else the turn's model, else the person's last
  selected model, provided they hold a key for it.
- `check_citations` tool (read-only, so viewers may use it too) runs a check inside the
  turn. The tool description tells the model when to run it and to report every
  flagged citation, above all contradicted ones. HTTP:
  `POST/GET /citation-checks/documents/:documentId`, plus recheck and cancel.
- Replies: the red "Could not verify quote" pill is gone. A reply quote that was not
  located still cannot be opened at a position.

Receipts:

- `npx vitest run src/modules/citations` printed `Tests  8 passed (8)`. The fixture
  is a real `.docx` memo with scripted sources and model. Its verdicts are
  `contradicted` (a case whose opinion holds the opposite), `not-found` (a fabricated
  case: CourtListener and search both empty), `quote-mismatch` (a statute quoted as
  "seven years" whose text says six), `exists-and-matches` (a page that supports its
  use) and `not-found` (a 404 URL). The run also showed:
  - the out-of-range extractor entry was dropped;
  - more than one model call was in flight at once;
  - snapshots were stored per source and audit rows were written for 7 outbound
    requests;
  - a worker dying mid-run resumed without listing the citations again
    (`extract` called once);
  - re-checks were `same` with the hash intact, and a tampered snapshot failed;
  - egress deny made no request and wrote no audit row;
  - a revoked reader stopped the run before any model call;
  - a cancellation took effect between citations;
  - a judge excerpt not in the source turned "contradicts" into "unclear".
- `npx vitest run src/lib/__tests__/toolDispatcherCheckCitations.test.ts` printed
  `Tests  2 passed (2)`.
- `bash scripts/test-stack.sh -t "document citation checks"` printed `Tests  3 passed |
  72 skipped (75)` against real Postgres and GoTrue (migrations 03-05 applied to the
  stack db). It covered:
  - the job row being queued, then restart and resume;
  - the five verdicts, with audit rows written;
  - re-checks giving the same result with the hash intact;
  - the schema refusing a document task without a version and an unknown verdict;
  - egress deny making no request.
- Backend `npm test`: 4464 passed, 100 skipped. `typecheck:test` and `build`: 0 errors.
  Frontend `npm test`: 2265 passed; `typecheck` clean; `lint` 0 errors (33 warnings, none
  in changed files).
- Local schema-drift reproduction: `NO DRIFT`.

Open items:

- No live-model probe yet on a real document with real citations; that acceptance
  item is not met.
- No UI beyond the assistant's tool; the partner decides the UI.
- Automatic triggers (citations changed, substantive change, before export) are left
  to the model and the person for now.
- Web search needs a configured search provider; without one, non-case, non-URL
  citations are `unverifiable`.

## Receipts, message checks (superseded by the scope above; 2026-10-10, assistant-run)

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
