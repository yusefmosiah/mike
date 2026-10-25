# Unified activity log and observability

Date: 2026-10-25. A design proposal; no code changed. It follows the source
and summary design in `docs/reports/step-summaries-2026-10-24.md`, which
needs the same events.

Revised 2026-10-25 after a ten-model review and web research; see unified-observability-review-2026-10-25.md.

## Summary

- **One correlation model and one emission helper, two payload types.** Every
  user action, data access, agent step and model call gets the same ids and is
  emitted once, at a chokepoint the code already has. The helper builds a
  **ledger event**, which may carry sensitive references, and a **telemetry
  record**, built from an allowlist so it cannot. They share ids, not a wire
  shape.
- **Two planes.** The **record** is a complete, append-only activity ledger
  that users, organisations and auditors see as timelines, source lists,
  activity views and exports. **Telemetry** is sampled traces, metrics and
  logs for operators. They differ in completeness, audience, sensitivity and
  retention, so they are separate stores. The ledger never lives in the
  telemetry backend.
- **Content by reference, never inline.** Events carry version ids, hashes,
  snapshot ids and message ids. References do not remove privilege or
  discovery duties: filenames, queries and hashes are still sensitive.
- **Durable first.** A ledger fact is committed in the same transaction as the
  action it describes, or written to an outbox there. Loss is not allowed.
- **Claims match the evidence.** Until signed checkpoints are kept outside the
  database, the ledger is append-only, not tamper-evident. Guest-side capture
  is labelled as reported, not observed. The timeline and the ledger are
  reconcilable projections, not identical views.
- **Standards.** W3C trace context for correlation. The ledger keeps its own
  stable names, mapped to the OpenTelemetry generative-AI conventions only at
  the telemetry export edge, because those are still in Development status.
- **Start small.** Fix the audit cascade, then ids, then the durable ledger,
  then the chain with external checkpoints. Tracing exporters, workstation
  capture and off-machine shipping come after.

## 1. What exists today

| Piece | What it holds | Notes |
| --- | --- | --- |
| `public.audit_events` (`lib/audit.ts`) | About 20 user-action kinds: `document.uploaded`, `chat.message`, `document.edited`, `subagent.run`, `inference.attested`, org changes, exports | `recordAudit` is a direct insert whose errors are logged and swallowed; only chat-turn audits use the DB queue (`enqueueChatTurnAudit`). An action can commit with no audit row and nothing notices. Has `detail jsonb`, an inline `user_email` and `project_id`. `user_id ... on delete cascade` erases a person's audit history when the account is deleted. |
| `public.user_mcp_tool_audit_logs` | Connector tool calls | A second, separate audit table. |
| Assistant message events | The timeline: `doc_read`, `code_cell`, `subagent`, citations | Per message, for display. Not queryable as activity. |
| Pi Durable store | Every model turn the runtime made | Full content. The deletion policy already covers it (`docs/deletion-policy.md`). |
| Sentry (`docs/observability.md`) | Errors only, rebuilt from an allowlist | On by default to the project's own Sentry; traces and other payloads blocked. |
| `console.*` | About 340 call sites in `backend/src` | Unstructured, to stdout and journald. Uses `safeError` redaction. |
| Request id | `X-Request-ID` per HTTP request (`app.ts`) | The only correlation id. It does not reach model calls, tools, kernels or jobs. |
| Workstation proxy | Every outbound request from a workstation VM (`journalctl -u tinyproxy`) | Host only for HTTPS. |
| Tamper-evident exports | SHA-256 per document version, Ed25519-signed manifests, canonical JSON (`docs/tamper-evident-exports.md`) | The signing and canonicalisation pattern to reuse for the ledger. |

There is no tracing, no metrics, and no single place that answers "what
happened in this turn" or "who touched this document".

## 2. The two planes

| | Record (activity ledger) | Telemetry (operations) |
| --- | --- | --- |
| Purpose | What happened, for users, organisations, auditors and legal holds | Why it was slow or failed, for operators |
| Completeness | Every event in scope; never sampled. Gaps are recorded, not hidden | Sampled; dropping data is acceptable |
| Content | References and metadata. Filenames, queries, URLs and hashes of short strings are sensitive | No client content or metadata; allowlisted attributes only, enforced in the SDK and again in the Collector |
| Integrity | Append-only, sequenced, hash-chained, with signed checkpoints kept outside the database | Best effort |
| Retention | Policy-driven per organisation, subject to legal holds | Short: 14 to 30 days. Not part of the record of business and excluded from holds |
| Store now | Postgres | Local OpenTelemetry Collector, then a self-hosted backend |
| Readers | The person, organisation admins within matter limits, exports | The operator only |

The browser's live stream (SSE) and the step timeline are projections of the
record. They are reconcilable, not identical: they can differ through lag,
access limits, and content deleted while the ledger entry stays. A
reconciliation job checks that every `call_id` shown in a message exists in
the ledger. The stream carries cursors so a reconnecting client can replay.

**Threat model, stated plainly.** The ledger defends against application bugs,
lost writes and a user or admin without database access. On a single
self-hosted node a database superuser can rewrite rows and any anchor stored
in the same database. Protection against that actor comes only from signed
checkpoints held somewhere that actor cannot rewrite (section 5).

## 3. The event model

A shared correlation context travels with everything. The ledger event adds
the sensitive references. The telemetry record takes only allowlisted fields.

```text
LEDGER EVENT
id              ULID, unique; not an ordering key
seq             per-organisation sequence, assigned by the sequencer (the order)
occurred_at     when it happened (server clock); duration_ms for spans
recorded_at     when it committed; the gap to occurred_at is the lag
name            dotted, from a closed list, with a per-name attrs schema
schema_version  integer, per event name
org_id          the tenant
matter_id       the project or matter, nullable; scopes access, holds, retention
actor           { type: user | agent | subagent | system | operator, id (pseudonymous),
                  on_behalf_of (the responsible human), subagent chain }
auth            { session ref, method, client: web | add-in | api, source ip, user agent }
                for operators: break-glass reason and approver
trace_id, span_id, parent_span_id   OpenTelemetry correlation; nullable
run_id, chat_id, turn_id, step_id, call_id, attempt   business ids, independent of tracing
resource        { kind, id, version_id, sha256, uri }; sensitive parts encrypted
outcome         ok | error | denied | cancelled | unknown, plus a short code
authz           for denials: policy id, role, scope
idempotency_key the event id; duplicates are dropped on insert
attrs           typed extras, validated against the schema for this name
```

`model.call` adds `purpose`, provider, model, served model, token counts,
finish reason, retry count, attestation id, `price_version`, prompt-template
and retrieval versions by reference, and time to first token. Cost is computed
at read time from tokens and the frozen price version. `source.access` adds
the capture label and trust level (section 6).

Rules:

- **Ids are the unification.** `call_id` is the existing tool-call id,
  including `<cell>.<n>` ids and a subagent's address prefix. The step tree,
  source lists, ledger and traces are views of the same ids.
- **A business id is not a trace id.** An event is not a span. One span can
  produce several events, and a long-running or replayed job can span several
  traces. `turn_id`, `step_id` and `attempt` are stored independently. A
  synchronous subagent shares the parent's `trace_id`, with its root span
  parented to the delegating span. Detached or background work starts a new
  trace with a span link.
- **Every model call has a `purpose`** (chat, summary, title, auto-mode gate,
  memory curator, citation check, compaction), and each provider attempt is its
  own event.
- **Names and attrs are a registry.** One zod or JSON schema per event name in
  `packages/contracts`, a database check against the name list, validation on
  ingest, and a test that fails when a name or its attrs change without a
  version bump. A second test runs a scripted turn and asserts each model call
  produced exactly one ledger event.
- **Field sensitivity is declared per event name** in the same registry,
  replacing a single `client_content` flag.
- **No free text from exceptions or providers** (`lib/httpError.ts` and
  `lib/safeError.ts` rules). Outcomes carry codes.
- **Values are untrusted.** Filenames, URLs and labels are escaped and
  length-capped, and rendered as text, never markup.

## 4. Where events are emitted

| Chokepoint | Events |
| --- | --- |
| HTTP middleware (`app.ts`, already mints the request id) | the root of each trace; `auth.*` including failures before a tenant is known |
| Domain services, at the mutation | `user.*`, `org.*`, `document.*`, sharing, role and policy changes, written where the action commits (middleware cannot know the outcome) |
| Document download, preview, share and export endpoints | human reads of protected resources |
| `lib/llm/index.ts` (`streamChatWithTools`, `completeText`) | `model.call` per provider attempt; content stays in the Pi store, referenced by id |
| `runTurnToolsNow` and `runToolCalls` (direct and in-cell calls) | `tool.call`, plus `source.access` from each branch's sources |
| Add-in `clientTools.execute` | client-reported events, marked as low trust and reconciled against server records |
| Kernel protocol (cells, audit hook, `sitecustomize` children) | `workstation.cell`, `source.access` with trust `guest_reported` |
| Workstation observers and the egress proxy | `source.access` with trust `host_observed`, `workstation.net` |
| Subagent host and runtime | `subagent.started` and `subagent.ended`, same trace as the parent |
| Summariser, DB queue jobs (`lib/dbq`) | `summary.generated`; job spans linked to the trace that enqueued them |
| Governance paths | the events listed in section 9 |

Context travels through the OpenTelemetry API's context manager (which uses
`AsyncLocalStorage` in Node) and W3C `traceparent`, so the app does not grow a
private tracing model. It reaches the kernel as ids in the cell's environment
and the queue as job metadata. Ids from the VM, browser or add-in are hints,
not trusted attribution: the server validates them against session and
tenant. Add a propagation test at each boundary (HTTP, queue, kernel,
subagent); context is easily lost across worker threads.

## 5. Ledger write path, integrity and time

**Write path.**

- **Same transaction.** The ledger intent is inserted in the same transaction
  as the change it describes. For external effects (a connector write),
  record the intent before the call and the outcome after, `unknown` if the
  acknowledgement is lost.
- **Durability classes**, published per event name. Class A (`auth.*`, role
  and permission changes, exports and downloads, connector approvals and
  denials, hold, retention and configuration changes, break-glass, deletion
  requested and completed, key operations) fails closed: if the record cannot
  be written, the action does not proceed. Class B (`model.call`, `tool.call`,
  `source.access`, `workstation.*`) is written through the outbox, never
  silently dropped, and an unavoidable loss produces a `capture.gap` event and
  an alert.
- **Idempotent.** The event id is the `dedupe_key` and a unique constraint.
- **Roles.** A separate insert-only writer role, no update, delete or
  truncate grants, and a trigger that rejects them. A distinct audited purge
  role does retention disposal.
- **Self-monitoring** as metrics: outbox lag, dead-letter depth, last
  verification result, checkpoint age.

**Sequencing and the chain.** ULIDs and wall-clock times do not commit in
order. One sequencer per organisation takes `pg_advisory_xact_lock` on the
organisation's chain head, assigns `seq` (unique on `(org_id, seq)`), and
computes `hash = sha256(prev_hash || canonical bytes)`. Only the sequencer
computes it, since racing writers would fork the chain, and it works in
batches from the outbox so a streaming turn never holds the lock. Canonical
bytes (RFC 8785) are stored as `bytea`; `jsonb` reorders keys and normalises
numbers. The chain lives in its own table so it can be rebuilt. Benchmark
before putting every file observation on it.

**Segments and retention.** Partition by organisation and month, each sealed
with a signed final head. Retention drops whole sealed partitions; history
before the oldest kept checkpoint is unverifiable by design, and exports say
so. Existing `audit_events` and `user_mcp_tool_audit_logs` rows are imported
as a pre-chain segment behind a `ledger.genesis` event, not given invented
hashes.

**External checkpoints.** The sequencer signs a checkpoint (org, `seq`, head hash,
time) at an interval, with an Ed25519 key held outside the database (KMS or a
separate service; public key published like the export manifest key). It is
pushed to Object Lock storage or an organisation-owned address early, not in
a last phase. Lock periods are set only after the retention schedule exists.
Every export includes the latest checkpoint, and a verifier CLI that runs
without the app checks it. A recurring job pages the operator on mismatch.
RFC 3161 timestamps can add independent time attestation. Merkle batches
would give per-row proofs; that is a later option and was not verified here.

**Time.** `occurred_at` is event time, `recorded_at` is commit time, and
ordering comes from `seq`. The host keeps clocks synchronised and alerts on
drift. Durations use monotonic clocks. Timestamps are UTC.

**Volume.** Observed-system events can exceed audit events by orders of
magnitude. Keep audit-grade events in the main partitioned table and forensic
detail in a sibling table with shorter retention. Index `(org_id, ts)`,
`(org_id, matter_id, ts)`, `(org_id, actor, ts)`,
`(resource kind, resource id, ts)` and `trace_id`.

## 6. Source and workstation capture

- **Access states.** An open is not a read. `source.access` records separately:
  attempted, succeeded, returned to the agent, included in a model request,
  cited in an answer. A document version id identifies the object, not the
  excerpt or transformation the model saw, so the selection and truncation
  metadata are kept where reconstruction matters. A `web_search` result is
  what the model saw, not what it read.
- **Trust, not just capture.** `capture` says how it was recorded
  (`recorded`, `observed_code`, `observed_system`). A separate `trust` says who
  can vouch: `guest_reported` for the in-VM audit hook and `sitecustomize`
  (code the model controls can omit or forge them), `host_observed` for the
  proxy and host-side observers. Exports state that only host-observed events
  are tamper-resistant. A guest event never overrides a host one. Size and
  rate are capped per cell. Record attribution confidence per event.
- **Aggregation, revised.** Resolve every path in the synced workspace folder
  to `(document_id, version_id)` and keep one row per document version,
  because "was this version read" is the auditor's question. Aggregate only
  what has no document identity, and aggregate in the view ("searched 412
  documents for a pattern"), not at capture. Filter system paths. Cap rows per
  cell; when a cap is hit, record the fact and the count, and never present a
  capped list as complete. Search patterns and full URLs are encrypted.
- **Never capture** raw `http.client.send` buffers or whole command lines;
  they can hold credentials and request bodies. Extract hosts and paths.
- **Mechanisms.** Keep the Python audit hook, `sitecustomize` and proxy
  attribution per cell (cheap). Add fanotify on the synced folder only for a
  measured gap. Defer eBPF, the `LD_PRELOAD` shim and a cgroup per cell:
  fragile, bypassable, and a persistent kernel spans cells anyway. Cut TLS
  interception unless a client requires it and legal signs off: it makes the
  proxy a store of privileged plaintext and breaks pinned clients.

## 7. Telemetry and logs

- **Logs.** One structured logger (pino) emitting JSON lines with trace ids,
  keeping `safeError` redaction. Migrate gradually; a lint rule stops new
  `console.*` calls and a test checks that error text is not interpolated into
  messages. Journald can drop messages, so it is never the record.
- **Traces and metrics.** The OpenTelemetry SDK exporting OTLP to a local
  Collector that first writes to files. Add a backend only when someone needs
  to query traces; for one node a ClickHouse-based or single-binary store is
  simpler than Loki, Tempo and Prometheus together.
- **Allowlist, twice.** Auto-instrumentation records `url.full`, query strings,
  `db.statement`, headers and exception text. Trim those, allowlist attributes
  in a span processor, and enforce it again in the Collector (attributes,
  transform and redaction processors). A test runs a canned turn with planted
  filenames, queries and URLs and fails if any appears in exported spans,
  logs or metrics. No org, user, document, query or trace ids as metric
  labels; hash the organisation id in telemetry. Trace ids can identify a
  matter once joined with the ledger, so telemetry access is controlled too.
- **OpenTelemetry mapping at the edge.** The generative-AI conventions moved
  on 2026-06-12 to a separate repository with no tagged releases and are still
  in Development status. Keep the ledger's own names as the stable contract.
  One module maps them to `gen_ai.*` on telemetry only: the span tree
  `invoke_agent` > `chat` > `execute_tool`, with the tool call id set from
  `call_id` and the conversation id from `chat_id`. Pin a commit of the
  conventions, put the app's own `purpose` under a vendor prefix, and
  hard-disable content capture in code, not just by environment variable.
- **Sentry.** Default-on Sentry is an off-machine transfer chosen on the
  customer's behalf; see question 6.
- **Metrics.** Turn latency, model and tool error rates, queue depth, disk.
  Billing and usage totals come from the ledger, never from sampled spans.

## 8. Privacy, retention, holds and keys

- **Actor identity.** Reference people by a stable pseudonymous id, with the
  mapping to identity in a separate table that follows the deletion policy.
  Pseudonymised data is still personal data (EDPB Guidelines 01/2025), so ids
  and hashes are treated as potentially identifying.
- **Cascade is a defect now.** Change `audit_events.user_id` to
  `on delete set null`, add the pseudonymous actor reference and move the
  inline `user_email` out, in a small migration ahead of the ledger work. The
  record must be able to outlive the account where a retention duty or hold
  applies. Counsel should confirm the legal basis.
- **Layered keys.** Sensitive metadata (filenames, queries, URLs, search
  patterns) is encrypted with a data key per matter or per subject, each
  wrapped by a key per organisation. One organisation key cannot erase one
  person or one matter, and shredding it destroys unrelated evidence. Key
  destruction is a ledger event, and the key service refuses it while a hold
  applies. Back up wrapped keys separately from the data. The chain covers the
  ciphertext, so shredding does not break it. Admin filters use plaintext ids
  and kinds plus blind indexes (an HMAC under a separate key) for filename,
  URL host and connector. Never store a bare SHA-256 of a short string such as
  a query; it can be guessed. `docs/deletion-policy.md` records that no
  regulator has been found to accept key destruction as erasure, so shredding
  is one mechanism, not the only erasure claim.
- **Legal holds are designed, not a question.** A `legal_holds` object scoped
  by organisation, matter, custodian and date range. Document, conversation
  and account deletion, Pi store pruning, key shredding, partition drops and
  retention sweeps all check it. A hold also protects what the ledger points
  to: document versions, model-store turns, web snapshots and identity
  mappings. Hold changes are ledger events. Enforcement lands with the
  deletion policy's phases; the schema fields land with the ledger.
- **Retention matrix** per record class: ledger, forensic detail, identity
  mappings, snapshots, transcripts, workstation copies, exports, telemetry,
  backups. Proposed defaults for owner decision: telemetry 14 to 30 days,
  logs 30 to 90 days, ledger by organisation policy with a contract floor.
  Under the EU AI Act, deployers of high-risk systems keep logs at least six
  months (Art. 26(6)). Whether law-firm drafting and research is in scope is
  unverified; probably not, absent use by or for a judicial authority.
- **Deletion consistency.** A deletion orchestrator checks holds, then
  removes or shreds across content, summaries, snapshots, the Pi store, VM
  disks, caches and indexes. The timeline shows a placeholder for deleted
  content; the ledger stays canonical.
- **Telemetry sits outside holds.** If a hold comes after telemetry has
  expired, the trace is gone. That is accepted and documented.

## 9. Who sees what, and the audit of the audit

- A person sees their own activity: the step timeline first, a personal view
  later.
- **Matter limits.** Organisation admins do not see everything. Access to the
  ledger is scoped by matter membership with row-level security, applied to
  the admin view, search, SSE, exports and break-glass. Ethical walls and
  restricted matters are respected. Define whether history stays visible after
  access is revoked.
- **Reading the ledger is an event.** `ledger.viewed`, `ledger.exported`,
  `ledger.verified`, plus `hold.placed`, `hold.released`, `retention.changed`,
  `key.created`, `key.shredded`, `connector.granted`, `model.config.changed`,
  `role.changed`, `breakglass.used` and `access.denied`. Bulk export needs
  re-authentication, since it is also an exfiltration path.
- **Operators.** Break-glass is time-boxed, needs a reason code and a second
  approver, notifies the organisation admin, and appears in an
  organisation-visible vendor-access view. Application logging does not cover
  a database administrator, so external checkpoints (section 5) are the
  independent evidence.
- **Export formats.** Native verified export first; OCSF only if a firm's
  monitoring system needs it.

## 10. Human oversight and AI-use record

Add events for a human accepting, rejecting or editing an AI output (the
accept/reject trail already exists for document edits), a citation being
checked, and a draft leaving the app. Record the model, prompt template and
retrieval configuration by version reference on each model call, so a firm can
say which configuration produced an answer. This supports the supervision
duties in ABA Formal Opinion 512 (2024).

## 11. Order of work

1. **Fix the cascade and decide the actor model** (section 8). Independent of
   everything else.
2. **Context and ids.** OpenTelemetry API context and `traceparent` through
   `lib/llm`, the dispatcher, kernel environment and queue jobs. No exporter.
3. **Ledger, durable.** Outbox in the action's transaction, `activity_events`
   with `seq`, `recorded_at`, `matter_id`, per-name schemas, idempotency,
   writer role, hold fields, a pre-chain genesis import and the merge of
   `user_mcp_tool_audit_logs`. Emit `model.call` from `lib/llm` and
   `tool.call` and `source.access` from the dispatcher (the sources work).
   Add the reconciliation test and pipeline metrics. Call it append-only.
4. **Chain and external checkpoints.** Sequencer, canonical bytes, sealed
   monthly segments, signed checkpoints in Object Lock storage, verifier CLI
   and verification job. Only now say tamper-evident.
5. **Structured logger and telemetry allowlist tests,** in parallel with 4.
6. **Summaries, subagents and human-oversight events** emit as they are built.
7. **Tracing.** SDK and file-writing Collector, with the double allowlist and
   the planted-secret test. Backend choice later.
8. **Views and exports.** Admin view with matter limits and ledger-access
   events, verified exports, the personal view if wanted.
9. **Workstation capture** beyond the audit hook and proxy tagging, only for
   measured gaps (fanotify first).
10. **Off the machine.** Collector forwarding, with destination approval,
    encryption in transit and residency controls.

Steps 1 to 4 make every later feature cheaper, because each one only emits
events.

## 12. Open questions for the owner

1. Ledger retention defaults and contract floor, and whether organisations
   can set their own (tied to the deletion policy's legal questions).
2. Is "matter" the existing project boundary? If not, the envelope still needs
   a scoping key.
3. Who holds the checkpoint signing key, and where do checkpoints go: storage
   the vendor controls, or an organisation-owned destination?
4. Should the personal activity view ship with the ledger or after the admin
   view?
5. Should prompts and responses ever enter telemetry? The review recommends
   never, including staging; debug through logged access to the Pi store.
6. Should Sentry default to off for self-hosted installs?
7. Which class A events should block the action if the ledger is down?
