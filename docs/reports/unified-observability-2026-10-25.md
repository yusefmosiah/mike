# Unified activity log and observability

Date: 2026-10-25. A design proposal; no code changed. It follows the source
and summary design in `docs/reports/step-summaries-2026-10-24.md`, which
needs the same events.

## Summary

- **One event model, emitted once, sent to several stores.** Every user
  action, data access, agent step, model call and summary is described by the
  same event envelope. Each is emitted once, at a chokepoint the code already
  has, and the same ids tie it to everything related.
- **Two planes, not one physical stream.** The **record** is a complete,
  unsampled, append-only and tamper-evident activity ledger. It is what users,
  organisations and auditors see: the step timeline, source lists, activity
  views and exports. **Telemetry** is sampled operational traces, metrics and
  logs for operators, with no client content. They differ in completeness,
  audience, sensitivity and retention, so they cannot be one store. They are
  unified by schema, ids and emission point. The live stream to the browser is
  a third consumer of the record.
- **Content by reference, never inline.** Events carry document version ids,
  content hashes, snapshot ids and model-store message ids, not the text
  itself. The log never becomes a second copy of privileged material, and
  deleting content does not mean rewriting the log.
- **Standards.**
  - **Correlation:** W3C trace context, OpenTelemetry trace and span ids.
  - **Model calls:** the OpenTelemetry generative-AI conventions, with prompt
    and response capture off.
  - **Logs:** structured JSON lines carrying the trace ids.
  - **Transport:** OTLP to a local OpenTelemetry Collector, which can later
    ship logs off the machine without code changes.
- **Start small.**
  1. Ids and context propagation.
  2. A structured logger.
  3. Evolve `audit_events` into the ledger.
  4. Then tracing.

  The source-recording work feeds the ledger directly.

## 1. What exists today

| Piece | What it holds | Notes |
| --- | --- | --- |
| `public.audit_events` (`lib/audit.ts`) | About 20 user-action kinds: `document.uploaded`, `chat.message`, `document.edited`, `subagent.run`, `inference.attested`, org changes, exports | Written through the DB queue without blocking the request. Has `detail jsonb`. `user_id ... on delete cascade` erases a person's audit history when the account is deleted. |
| `public.user_mcp_tool_audit_logs` | Connector tool calls | A second, separate audit table. |
| Assistant message events | The timeline: `doc_read`, `code_cell`, `subagent`, citations | Per message, for display. Not queryable as activity. |
| Pi Durable store | Every model turn the runtime made | Full content. The deletion policy already covers it (`docs/deletion-policy.md`). |
| Sentry (`docs/observability.md`) | Errors only, rebuilt from an allowlist | On by default to the project's own Sentry; traces and other payloads blocked. |
| `console.*` | About 340 call sites in `backend/src` | Unstructured, to stdout and journald. Uses `safeError` redaction. |
| Request id | `X-Request-ID` per HTTP request (`app.ts`) | The only correlation id. It does not reach model calls, tools, kernels or jobs. |
| Workstation proxy | Every outbound request from a workstation VM (`journalctl -u tinyproxy`) | Host only for HTTPS. |
| Tamper-evident exports | SHA-256 per document version, plus the accept/reject trail | The hashing pattern to reuse for the ledger. |

There is no tracing, no metrics, and no single place that answers "what
happened in this turn" or "who touched this document".

## 2. The two planes

| | Record (activity ledger) | Telemetry (operations) |
| --- | --- | --- |
| Purpose | What happened, for users, organisations, auditors and legal holds | Why it was slow or failed, for operators |
| Completeness | Every event; never sampled | Sampled; dropping data is acceptable |
| Content | References and metadata (filenames, queries and URLs are sensitive metadata) | No client content or metadata; allowlisted attributes only, as with Sentry |
| Integrity | Append-only, hash-chained, exportable with verification | Best effort |
| Retention | Policy-driven: per organisation, with legal holds (deletion policy) | Short: days to weeks |
| Store now | Postgres table | Local OpenTelemetry Collector, then a self-hosted backend |
| Readers | The person (their timeline), organisation admins (activity view), exports | The operator only |

The browser's live stream (SSE) and the step timeline are projections of the
record, so the timeline a user sees and the audit trail can never disagree.

## 3. The event envelope

One shape for everything: a TypeScript type in `packages/contracts`, and a
JSON line on the wire and in logs.

```text
id              ULID (time-ordered, unique)
ts              when it happened (server clock), plus duration_ms for spans
name            dotted, from a closed list: user.*, auth.*, org.*, document.*,
                chat.turn.*, model.call, tool.call, source.access,
                summary.generated, subagent.*, workstation.*, system.*
schema_version  integer
org_id          the tenant
actor           { type: user | agent | subagent | system | operator, id, address }
trace_id        one per user-initiated unit of work (a turn, an upload, a review)
span_id         this event; parent_span_id links it into the tree
chat_id, turn_id, step_id, call_id   the step-tree ids (StepNode, SourceRef)
resource        what it acted on: { kind, id, version_id, sha256, uri }
outcome         ok | error | denied | cancelled, plus a short error code (never a raw message)
model           { purpose, provider, model, served_model, tokens_in, tokens_out,
                  tokens_cache, cost, attestation_id }
capture         recorded | observed_code | observed_system
classification  { client_content: bool, sensitive_metadata: [field names] }
attrs           small, typed extras per event name
```

Rules:

- **Ids are the unification.** `trace_id` is the turn. Spans are steps, tool
  calls, model calls, summaries, subagent runs, kernel cells and data
  accesses. `call_id` is the existing tool-call id, including the
  `<cell>.<n>` ids for calls made from a cell and a subagent's address prefix.
  The step tree, source lists, ledger and traces are then four views of the
  same ids.
- **Every model call has a `purpose`:** chat, summary, title, auto-mode gate,
  memory curator, citation check or compaction. Cost and latency can then be
  attributed, and the summariser's spend is visible.
- **Names are a closed list, checked by a test,** so dashboards and exports
  do not break when someone adds an event.
- **No free text from exceptions or providers** (`lib/httpError.ts` and
  `lib/safeError.ts` rules). Outcomes carry codes.

## 4. Where events are emitted

The code already has chokepoints, so emission is a handful of places, not 340.

| Chokepoint | Events |
| --- | --- |
| HTTP middleware (`app.ts`, already mints the request id) | the root of each trace; `user.*`, `auth.*`, `org.*` actions (today's `recordAudit` calls) |
| `lib/llm/index.ts` (`streamChatWithTools`, `completeText`): every model call goes through here | `model.call` with purpose, models, tokens, cost, latency, attestation; content stays in the Pi store, referenced by id |
| `runTurnToolsNow` and `runToolCalls` (direct and in-cell tool calls) | `tool.call`, plus `source.access` from each branch's sources |
| Kernel protocol (cells, the audit hook, `sitecustomize` children) | `workstation.cell`, `source.access` with `capture: observed_code` |
| Workstation observers (fanotify or eBPF) and the egress proxy | `source.access` with `capture: observed_system`, `workstation.net` |
| Subagent host and runtime | `subagent.started` and `subagent.ended`, with the child trace linked to the parent span |
| Summariser | `summary.generated`: level, covered steps, source ids, model call span |
| DB queue jobs (`lib/dbq`) | job spans linked to the trace that enqueued them |

The context travels with Node's `AsyncLocalStorage`, so deep code does not
need ids passed by hand. It reaches the kernel as `MIKE_TRACE_ID` and
`MIKE_CELL_ID` in the cell's environment, and the queue as job metadata.

## 5. Storage and pipeline

**Now (one node):**

- **Ledger.** Evolve `audit_events` into an `activity_events` table with the
  envelope's columns.
  - **Append-only:** no update or delete grants; corrections are new events.
  - **Hash chain:** each row stores `hash = sha256(prev_hash || canonical
    row)`, chained per organisation.
  - **Anchors:** a periodic anchor row records the chain head, so an export
    can be verified like the tamper-evident document manifests.
  - **Write path:** through the DB queue, as `recordAudit` does today, so
    recording never blocks the user. Model and tool events that the timeline
    depends on are written in the turn's own transaction where they already
    persist.
  - **Indexes:** by `(org_id, ts)`, `(resource.id, ts)` and `trace_id`.
- **Logs.** Replace `console.*` with one structured logger (pino is the usual
  Node choice). It emits JSON lines with `trace_id` and `span_id`, keeps
  `safeError` redaction, and writes to stdout, which journald keeps. Migrate
  gradually; a lint rule stops new `console.*` calls.
- **Traces and metrics.** The OpenTelemetry Node SDK, exporting OTLP to an
  OpenTelemetry Collector on node-a. Behind the Collector, a self-hosted
  backend; choose later between the Grafana stack (Tempo, Loki, Prometheus)
  and a ClickHouse-based one (SigNoz, OpenObserve). Nothing leaves the machine
  by default. Use the generative-AI semantic conventions for model spans
  (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.*`), with
  content capture off. Check the conventions' current stability before
  pinning attribute names.

**Later (off the machine):** the Collector forwards OTLP to central
infrastructure, with no application change. The ledger is exported on a
schedule to write-once storage (object lock), so its hash chain is anchored
outside the database too.

**Volume.** The kernel audit hook and file observers can be noisy: a `grep -r`
opens hundreds of files. Aggregate at the source, per cell, into one
`source.access` with a count and the pattern (from `execve`). Keep the
per-file list as an attribute, capped, with the full list only where the
organisation's policy asks for it.

## 6. Privacy, retention and deletion

- **References keep the ledger lean.** Deleting a document or a conversation
  removes the content. The ledger keeps "this version, with this hash, was
  read at this time by this actor" without the text.
- **Metadata is still sensitive.** Filenames, search queries and URLs can
  reveal privileged matters. Mark those fields in `classification` and encrypt
  them with a per-organisation key. Deleting the key (crypto-shredding)
  removes them everywhere, including backups, without breaking the hash
  chain, which covers the ciphertext.
- **Cascade versus retention.** Today `audit_events` cascades on user
  deletion. Under a retention duty or a legal hold, the activity record must
  outlive the account. The ledger should reference users by a pseudonymous
  id, keep the record, and shred the identifying fields. This belongs in
  `docs/deletion-policy.md` as an open question for legal review.
- **Telemetry carries no client data.** The same allowlist approach as Sentry
  applies to every OpenTelemetry exporter that could leave the install.

## 7. Who sees what

- A person sees their own activity: the step timeline and a personal activity
  view.
- Organisation admins see the organisation's ledger: an activity view with
  filters by person, document, matter and connector, and verified exports.
- Operators see telemetry, and see the ledger only through break-glass access
  that is itself logged.

Row-level security and service-role access follow the existing table
pattern.

## 8. Order of work

1. **Context and ids.** `AsyncLocalStorage` context from the HTTP middleware,
   carried through `lib/llm`, the tool dispatcher, the kernel environment and
   DB-queue jobs.
2. **Structured logger.** Pino with trace ids, replacing `console.*` module by
   module, plus a lint rule.
3. **Ledger.**
   - A migration that evolves `audit_events` into `activity_events`:
     envelope columns, append-only grants and the hash chain.
   - Emit `model.call` from `lib/llm`, and `tool.call` and `source.access`
     from the dispatcher (the sources work).
   - Fold `user_mcp_tool_audit_logs` into the ledger.
4. **Summaries and subagents** emit into the ledger as they are built.
5. **Tracing.** The OpenTelemetry SDK and a local Collector on node-a, with a
   self-hosted backend.
6. **Workstation capture.** Kernel audit hook, `sitecustomize`, per-cell
   cgroup and fanotify or eBPF, feeding `source.access`.
7. **Views.** Admin activity view, verified ledger exports.
8. **Off the machine.** Collector forwarding and write-once ledger export.

Steps 1 to 3 make every later feature (summaries, sources, subagents,
billing, compliance exports) cheaper, because each one only emits events.

## 9. Open questions for the owner

1. Ledger retention defaults, and whether organisations can set their own.
   This ties to the deletion policy's legal questions.
2. Should the personal activity view ship with the ledger, or only the admin
   view first?
3. Telemetry backend preference: the Grafana stack or ClickHouse-based?
4. Should the per-file lists from `grep -r`-style scans be kept in full, or
   summarised with a count and pattern by default?
5. Should model prompt and response content ever enter telemetry (for
   example, opt-in for debugging on staging), or stay only in the Pi store?
