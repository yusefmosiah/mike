# Review of the unified observability proposal

Date: 2026-10-25. Synthesis of an independent panel review of
`docs/reports/unified-observability-2026-10-25.md`, combined with web research
done the same day. The proposal was revised in place; this note records what
the panel said and what was changed.

## Method

Ten models reviewed the proposal and the related source-recording design,
each answering the same prompt (verdict, findings, missing pieces, risks, cut
or defer, evidence, confidence): `claude`, `codex`, `devin`, `opencode`,
`omp-gpt61-sol`, `omp-gpt6-luna`, `omp-gemini38`, `omp-muse-spark`,
`omp-deepseek-v41-flash` and `omp-glm53-flash`. An eleventh
(`omp-minimax-m31-flash`) failed and is ignored. So ten of ten default
reviewers returned. Only `devin` checked claims against the code; the rest reviewed the
text. A separate web search checked
standards and current status; its unverified claims are marked below. The
panel is not a vote. Counts show how widely a point was raised.

All ten kept the core split between a complete ledger and sampled telemetry,
and kept content by reference. None wanted to merge the planes.

## Consensus findings

1. **The write path loses events (10 of 10).** "Through the DB queue so
   recording never blocks the user" cannot give "complete, never sampled". A
   crash between the action and the enqueue leaves an unaudited action.
   `devin` checked the code: `recordAudit` is a direct insert that swallows
   errors, and only chat-turn audits use the queue, so the proposal's
   description of today was also wrong.
   Fix: transactional outbox in the action's transaction, idempotent insert
   keyed by event id, durability classes (fail closed for exports, role
   changes, connector approvals; alert on gaps for the rest), `capture.gap`
   events, and monitoring of outbox lag.

2. **A chain anchored in the same database proves little (10 of 10).** A
   superuser rewrites rows and anchors together. Fix: state the threat model;
   sign checkpoints with a key outside the database; push them to Object Lock
   storage or an organisation-owned address; include the latest in exports;
   ship a verifier. Eight reviewers want this moved before the last phase.
   Until then, call the ledger append-only, not tamper-evident.

3. **The chain cannot be built as described (9 of 10:** all but
   `opencode`, who raised scale only). Concurrent writers fork it, ULIDs and
   timestamps are not commit order, a long turn transaction would hold a
   lock, and `jsonb` is not canonical. Fix: one sequencer per organisation,
   `seq` unique on `(org_id, seq)`, advisory lock, batches from the outbox,
   RFC 8785 canonical bytes stored as `bytea`, `occurred_at` separate from
   `recorded_at`, ordering by `seq`.

4. **No matter field, and organisation-wide admin access (9 of 10).** The
   envelope has no `matter_id` although section 7 promised matter filters, and
   law firms use ethical walls. Fix: add `matter_id`; row-level security by
   matter membership on views, search, SSE, exports and break-glass.

5. **One organisation key is too coarse, and holds are not designed (9 of
   10).** It cannot erase one person or matter, and nothing stops shredding
   during a hold. Fix: layered keys (organisation key wrapping per-matter or
   per-subject keys); key destruction is a ledger event and refused under a
   hold; a `legal_holds` object checked by every deletion path and protecting
   referenced content; blind indexes for filterable encrypted fields.

6. **Reading the ledger must be logged (9 of 10).** Only break-glass was
   covered. Fix: `ledger.viewed`, `ledger.exported`, `ledger.verified`, plus
   hold, retention, key, role and connector-grant events; re-authenticate bulk
   export.

7. **Cut TLS interception, defer eBPF, the `LD_PRELOAD` shim and per-cell
   cgroups (10 of 10 on TLS; 9 of 10 on the rest).** Fanotify, the Python audit
   hook and per-cell proxy attribution are acceptable; fanotify only for a
   measured gap.

8. **Telemetry leaks (9 of 10 on allowlists; 6 on separate payload types).**
   Auto-instrumentation records URLs, query strings, SQL and exceptions.
   Fix: allowlist in the SDK and again in the Collector, a planted-secret
   test, no ids as metric labels. `sol`, `luna`, `gemini`, `muse`, `deepseek`
   and `codex` go further: the ledger envelope and the telemetry payload must
   be different types.

9. **The user-delete cascade is a live defect (6 of 10:** `claude`, `devin`,
   `opencode`, `glm`, `muse`, `deepseek`). Fix now, ahead of the ledger:
   `on delete set null`, a pseudonymous actor reference, identity mapping in a
   separate table. Confirm the legal basis with counsel.

10. **"Timeline and audit trail can never disagree" is false (6 of 10:**
    `claude`, `codex`, `devin`, `sol`, `luna`, `deepseek`). Delivery lag, access
    limits and content deletion all cause legitimate differences. Fix: claim
    reconcilable projections; replay cursors; a job that checks every
    `call_id` in a message exists in the ledger.

11. **Pin and isolate the GenAI conventions (10 of 10).** Status was still
    Development. Fix: one adapter module, a pinned version, a vendor prefix
    for the app's own attributes, content capture hard-disabled in code.

12. **Missing basics (7 to 8 of 10 each):** time and clock rules; retention
    mechanics for an append-only table (monthly partitions, sealed segments);
    schema evolution and per-name attrs schemas; pipeline self-monitoring; the
    actor model (`on_behalf_of`, session, client, source address); a
    pre-chain genesis for existing rows.

13. **Defer the telemetry backend, the personal activity view and the
    Collector forwarding (about 8 of 10).**

## Dissent and single-reviewer findings worth keeping

- **Hash chain versus Merkle batches.** `gemini` wants per-row chaining
  dropped for periodic Merkle roots; `claude` offers signed Merkle tree heads
  (RFC 6962) as a better option. `luna` and `muse` would defer the chain until
  the threat model and an external store exist. Resolved: keep the chain with
  a sequencer and signed checkpoints, which is simpler and matches the
  existing export manifests; treat Merkle proofs as a later option.
- **Tracing early or late.** `sol`, `codex`, `muse` and `deepseek` want OpenTelemetry
  context in the first step; `glm` and `gemini` would defer the SDK and
  Collector until off-machine shipping. Resolved: API context and `traceparent`
  early (cheap, no exporter), exporters later.
- **Aggregation destroys the main audit query (`deepseek`).** Collapsing a
  `grep -r` into a count means "was version 9f3 read" cannot be answered.
  `claude` prefers a sibling forensic table; `muse` wants a two-tier model.
  Adopted: one row per document version, aggregated only in the view; system
  paths filtered.
- **Trust, not just capture (`claude`, `deepseek`, `opencode`).** The in-VM
  hook is written by code the model controls. Adopted as a `trust` field
  (`guest_reported` versus `host_observed`) with attribution confidence.
- **Access states (`sol`, `luna`, `codex`).** An open is not a read; a version
  id is not the excerpt the model saw. Adopted: attempted, succeeded,
  returned, included in a request, cited.
- **Events are not spans (`sol`, `codex`, `luna`, `deepseek`).** Keep business
  ids independent of trace ids; link detached work. `devin`, `muse`: a
  subagent shares the parent's trace. Both adopted.
- **Retention and holds belong in the design now (`sol`, `deepseek`,
  `devin`).** Adopted as a retention matrix with proposed defaults for owner
  decision.
- **Smaller finds adopted.** `devin`: `price_version` instead of stored cost;
  `ingested_at`; a per-name schema test. `deepseek`: HMAC instead of bare
  hashes of short strings; dual-control, customer-visible break-glass; telemetry
  excluded from holds; Sentry default-on is an egress decision (also `muse`,
  `sol`). `claude`: OCSF mapping at export only; a retention-safe object-lock
  period. `glm`: sealed segments so retention can drop whole partitions.
- **Not adopted.** `muse`: telemetry as a separate emission path with no
  shared helper; the shared helper keeps ids from drifting. `luna`: do not
  store full URLs at all; they are kept encrypted instead, because "which URL
  was fetched" is a core source fact. `gemini`: cut fanotify and the Python hook
  too; the hook is cheap and kept. `deepseek`: remove `capture` from the
  envelope; it was moved to `source.access` instead. `deepseek`: fix a ledger
  retention default of 7 years now; left as an owner decision with the
  telemetry defaults proposed.
- **Panel errors.** `gemini` cited GenAI conventions "v1.28.0+", which is out
  of date (see below). `glm` took the proposal's claims about code at face
  value; `devin` showed one of them was wrong.

## Web research against the panel

- **Confirmed.** OTel GenAI conventions are still Development status (not
  stable). Content capture is opt-in. They moved on 2026-06-12 to a separate
  repository with no tagged releases, so pin a commit. This sharpens the panel
  advice: the ledger keeps its own names as the stable contract and maps to
  `gen_ai.*` only at the export edge.
- **Sharpened.** The agent span tree (`invoke_agent` > `chat` >
  `execute_tool`) gives the mapping that `claude` described. OWASP logging
  guidance supports the panel on access logging, tamper protection, separate
  writer account, event time versus log time, and never logging tokens or keys.
- **Confirmed and sharpened on the chain.** A per-organisation chain needs an
  advisory lock or single sequencer and an explicit `seq`; anchoring in the
  same database protects nothing against an insider. This supports findings 2
  and 3 and the rejection of an async-queue path that computes the chain.
- **Sharpened on keys.** Layered keys (organisation key wrapping per-matter or
  per-subject keys) with legal hold blocking key deletion matches the panel.
  Pseudonymised data remains personal data (EDPB Guidelines 01/2025). ABA
  Formal Opinion 512 covers confidentiality and informed consent for
  generative AI.
- **New to the panel.** Human-oversight events (accept, reject, edit of AI
  output) and model, prompt-template and retrieval versions by reference: not
  raised by any reviewer. Added as section 10. Only the EU AI Act Article 12
  logging duty for high-risk systems motivates it; whether law-firm drafting
  and research is in scope is unverified, and the delay of the high-risk dates
  to 2027-12-02 comes from secondary sources and is not relied on.
- **Unverified.** NIST SP 800-53 AU controls, ISO 27001 A.8.15/8.16 and SOC 2
  CC7 as cited by reviewers were not checked against primary text. NIST SP
  800-92 Rev. 1 is still a draft. Merkle inclusion and consistency proofs were
  not checked. Backend advice (a ClickHouse-based or single-binary store for one
  node) is a judgment, not a measured result.
- **Contradicted.** `gemini`'s version number for the conventions. Nothing
  else was contradicted.

## What to cut or defer

- **Cut:** TLS interception (unless a client requires it and legal signs off);
  the `LD_PRELOAD` shim; the single `client_content` flag; the claim that the
  timeline and ledger "can never disagree".
- **Defer:** eBPF and cgroup per cell; fanotify until a measured gap; the
  telemetry backend choice; the personal activity view; Collector forwarding;
  Merkle proofs; OCSF export; full per-file lists beyond one row per document
  version.
- **Do not do:** prompts or responses in telemetry, in production or staging.

## Changes made to the proposal

1. Headline changed from one envelope to one correlation model and emission
   helper with two payload types.
2. Section 1 corrects the description of `recordAudit` and notes the
   Sentry default.
3. Threat model stated; "tamper-evident" withheld until external checkpoints
   exist.
4. Envelope revised: `seq`, `recorded_at`, `matter_id`, richer `auth` and
   `actor`, separate business ids, authz, idempotency key, per-name schemas.
5. New section 5: outbox, durability classes, sequencer and chain, canonical
   bytes, sealed monthly segments, external signed checkpoints, time handling,
   self-monitoring, genesis import.
6. Source capture rewritten: access states, trust label, one row per document
   version, never capture raw request buffers, cut TLS interception.
7. Telemetry section: double allowlist, planted-secret test, OTel mapping
   confined to the export edge, Sentry question.
8. Privacy section: cascade fix, layered keys, blind indexes, designed legal
   holds, retention matrix, telemetry outside holds.
9. New access section with matter limits, ledger-access events and dual-control
   break-glass; new section 10 on human-oversight events.
10. Order of work re-sequenced: cascade fix first, then ids, durable ledger,
    chain with external checkpoints, logger, then tracing, views and workstation
    capture. Open questions updated.
