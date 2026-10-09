# Pi Durable recon and integration design for Mike

Date: 2026-10-07. Status: **design proposal, not implemented.** Owner review required
before any code work. Every external claim cites a primary source; every repo claim
cites a file and line. Where a claim is inference rather than verified fact it says so.

Produced from six parallel research slices (provenance in §9): Pi Durable internals
(README, normative spec, examples), Pi 1.0 principles, subagent patterns (Pi examples
+ `pi-subagent-manager` docs), Mike branching/streaming/audit recon, Mike tool-call
trajectory recon, and audit-immutability prior art.

---

## 1. Executive summary

Mike already re-implements, piece by piece, what Pi Durable ships as one coherent
model: a message tree with per-user leaf state (`chat.tree.ts`), an SSE runtime with
sequenced resumable frames (`streamRuns.ts`), token-triggered compaction wired into
the OpenCode Go adapter (`aiSdk.ts`), artifact-level audit rows (`audit_events`), and a
job queue (`lib/dbq`). What is missing is the *substrate* that makes those pieces
durable and cache-stable:

1. **Raw tool trajectory is never persisted.** Only display events are stored; the
   model never sees a prior turn's tool call arguments or tool results. The 4,000-line
   file an agent read last turn is gone at the turn boundary.
2. **Prior messages are mutated between turns.** `enrichWithPriorEvents` rewrites the
   last assistant message, and project chat rewrites message content — both invalidate
   the provider prefix cache at that position.
3. **No durable run/task model.** A crash mid-turn loses the run; there is no
   checkpoint, no resume, no exactly-once admission.
4. **No subagents.** Everything runs in one conversation and one model loop.
5. **Audit is artifact-level and mutable.** `audit_events` records mined artifacts;
   nothing is hash-chained, WORM-exported, or streamed as an immutable journal.

**Recommendation.** Do **not** adopt `@earendil-works/pi-durable` as a dependency — it is
experimental, owns its own storage line (memory/SQLite/JSONL; one process per storage
with no cross-process locking), and has no tenant concept, so its writes bypass Mike's
RLS. §7 sizes the alternative (delete the loop, embed Pi Durable, re-add the tools): the
model layer is less of a blocker than expected (pi-ai natively speaks OpenCode Go), but
the **owner-routing layer the package does not provide is larger than the loop
replacement**, and client-side Word tools plus the human-pause flows need emulation.
Adopt Pi Durable's **patterns** in Mike's stack instead: an immutable, append-only
conversation entry log in Postgres, derived deterministically into model messages;
tasks/checkpoints with resume; task-owned subagent conversations; and a separate,
hash-chained audit journal that streams with resume. That is five workstreams (M0–M5,
§6), each independently shippable, three of them small.

---

## 2. What Pi Durable actually is (primary sources)

### 2.1 The core rule

> "A Session atomically commits immutable entries, full task records, and
> Chord-tracked documents. Only committed state is observable."
> — `docs/spec.md` §1 (normative)

Invariants that matter to us: one commit is atomic across records and documents;
*all visible progress is durable — there is no volatile publication path*; external
effects (model calls, tool execution) must run **outside** the commit transaction;
entries and IDs are immutable and never reused; storage is owned by exactly one
process (no cross-process locking).

### 2.2 Entries, heads, and context derivation

An **entry** is an immutable transcript record. Built-in kinds: `pi.user`,
`pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`
(spec §8.1). Modification of how history projects into the model context happens
**only through newer entries**: a `head` marker plus `ContextEdit`s (`omit` /
`replace`) (spec §2, §2.1). Context derivation rules (spec §2.1) include:

- start scanning from the newest applicable `head`, else transcript start;
- newest edit wins per target; `omit` contributes nothing, `replace` substitutes;
- **relocate each assistant's tool results directly after it, in tool-call order**;
- synthesize an error result for every call without one (fork cut, interrupted tail);
  drop orphan tool results;
- exclude assistant messages whose stop reason is `aborted`, `error`, or `deferred`;
- keep positional system messages and their tool/section patches;
- move a system message that only user messages precede to the front — because
  otherwise "a later tool change rewrites the request's tool list and invalidates the
  whole prompt cache" (spec §2.1, verbatim rationale).

### 2.3 Compaction keeps storage, changes only projection

Compaction appends a `pi.compaction` entry carrying the summary as a user message and
`head: firstKept` — *the first entry kept verbatim*. Context derivation then starts at
that head. Crucially: **older entries are never deleted**; they stay readable via
`scanEntries()` and `entry(id)` (spec §8.7). This is exactly the property Mike's
Mission 2 lacks: compaction there is a prompt-only projection with no retrievable
original.

### 2.4 Prompt-cache (KV-cache) discipline

- The system prompt is assembled from extension `sections`, rendered in order before
  every request; **only what changed is appended** as a positional `pi.system` entry
  with `sections` patches and `toolsAdded`/`toolsRemoved`. Prefix tokens before the
  delta stay byte-identical, so the provider's prefix cache stays warm
  (spec §7.4; README "System Prompt").
- Renderers must be deterministic for equal inputs: "any change in rendered text,
  such as an embedded timestamp, appends a system delta and invalidates provider
  prompt caches" (spec §7.4; README repeats it).
- After a head cut (compaction/reset), the next generation writes a **complete
  baseline** `pi.system` entry plus `ContextEdit` omissions for the earlier system
  entries still retained behind the cut (spec §7.4) — the patch model cannot "restate"
  its way to a new baseline, so Pi rebaselines explicitly.
- Each conversation persists a **provider session identity** (`pi.provider.sessionId`,
  UUIDv7) forwarded to the provider for prompt-cache/session affinity; it survives
  reopen, retries, reset, compaction and model changes; **forks and child
  conversations mint a fresh identity** (spec §2, README "Persist and Resume").

### 2.5 Tasks, crash recovery, replay safety

Every model call, every tool call, and every application step is a **task**: a durable
state machine that commits a checkpoint before moving on (spec §5). Recovery
reconciles `running` → `pending` and resumes from the last checkpoint. Specifically:

- **Interrupted model request:** the committed partial becomes an `pi.assistant` entry
  with `stopReason: "aborted"` (excluded from future context by derivation rule 9) and
  the request is resent (spec §8.3).
- **Interrupted tool call:** re-executes **only if** both the stored replay policy and
  the current tool declaration are `replay: "safe"`; otherwise the model receives an
  `interrupted` error result with whatever output was durably flushed (spec §8.4).
- **Exactly-once admission:** `submit({ requestId })` returns the existing submission
  instead of double-admitting; reusing a `requestId` for a different submission type
  is rejected (spec §6).
- Progress (partial text, tool output) is committed at throttled intervals — 100 ms
  defaults — so a crash loses at most that window; remote storage can raise the
  interval at the cost of a larger window (README "Watching a Conversation").

### 2.6 Subagents and the task graph

Pi Durable has **no built-in subagents**; it has the primitives (spec §13 non-goals;
README "Abort and Subagents"):

- A subagent is a **task-owned conversation**: `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })`.
  The ownership edge is recorded even after the owner is terminal and drives abort
  propagation and idle waits — aborting the call aborts the child; the parent is idle
  only once the child is.
- A `{ background: true }` task is a boundary: work it owns survives the parent's
  abort and does not keep the parent busy (`root.abort(context, { background: true })`
  still reaches it).
- **Child tasks + wait policies**: a parent commits `waiting` naming children with
  `allSettled` or `failFast`, and reads their outcomes on resume.
- **Task graph**: `taskGraph()` / `watchTaskGraph()` expose live tasks, owner edges,
  status, and owned conversations for a UI panel.
- The third-party `pi-subagent-manager` adds the *product* layer on top: agent
  **types** as markdown+frontmatter, **paths** (`/root/fix-auth/review`), steer /
  pause / resume / report, resume-after-restart, and a fullscreen tree UI. It also
  documents the constraint we care about: children share the working directory and OS
  permissions — "tool policies are **not** a sandbox".

### 2.7 Observation streams are convergence-oriented, not audit-grade

`viewState()`/`watch()` deliver committed structural state; `watchEvents()` derives
coding-agent-style events from commits with snapshot + deltas. Both keep **at most 100
undelivered frames**; a slow consumer's queue is replaced by a fresh snapshot. The spec
is explicit that these are observation mechanisms, not journals: "This is convergent
observation, not an audit stream; consumers requiring every transition must persist
those facts separately" (spec §9.2) and "Publications and watches are convergence
mechanisms, not audit streams" (spec §4). Pi Durable's non-goals likewise include "no
Session-kernel semantic event journal or independently maintained event state"
(spec §13).

**Consequence for our NFR:** the immutable, streaming audit log is *ours to build*.
Pi Durable gives the durable commit line, not the journal.

### 2.8 Storage and operational limits

Memory / SQLite (WAL, `synchronous = NORMAL`) / JSONL / Cloudflare Durable Object.
SQLite survives process crashes but "the newest [commit] may be lost on power or host
failure"; JSONL needs `fsync: true` for the same guarantee; one process owns a storage
at a time; an uncertain storage failure poisons the Session (README "Storage").
Third-party analysis (MindStudio) emphasises the same caveats and adds the honest
limits: context windows still apply; APIs are experimental; replay safety is opt-in.

---

## 3. What Mike has today (evidence)

| Concern | Current state | Evidence |
|---|---|---|
| Transcript persistence | `chat_messages.content` is `jsonb` holding **AssistantEvent display events** (doc ids, versions, filenames) — not tool-call/tool-result messages | `backend/schema.sql:2122-2137`; recon slice 4 |
| HTTP request shape | `parseChatMessages` accepts only `{role: "user"\|"assistant", content: string\|null}` (+files/workflow) — tool parts cannot cross | `backend/src/modules/chat/engine/requestValidation.ts:174-200` |
| Cross-turn recap | `enrichWithPriorEvents` appends `[Tool activity in your previous turn]` to the **last assistant message**, derived from the newest persisted assistant row | `backend/src/modules/chat/engine/contextBuilders.ts:164,354-373` |
| Branching | `parent_message_id` + per-user leaf state, leaf-to-root traversal, sibling navigation live on both chat surfaces | `goals/station-5-pi-tree-branching.md`; `backend/src/modules/chat/chat.tree.ts` |
| Compaction | Token-triggered, wired into the OpenCode Go adapter: preflight replay, per-step checkpoint, one overflow retry; prompt-only, nothing durable | `backend/src/lib/llm/aiSdk.ts:735-742, 806-860, 1018-1019`; Mission 2 receipts in `goals/station-4-…md` |
| Provider cache hints | OpenAI `prompt_cache_key = conversationId`; Anthropic last-message ephemeral breakpoint; no session identity for the OpenCode Go route | `backend/src/lib/llm/aiSdk.ts:444-489`; `backend/src/lib/llm/types.ts:110-114` |
| SSE resume | Server-owned runs with monotoic `seq`, `id: <seq>` frames, replay-from-sequence, 60 s retention after finish — **in memory only** | `backend/src/lib/streamRuns.ts:161-163,166-199` |
| Tool lifecycle | `runToolCalls` (`engine/tools/toolDispatcher.ts:282`) returns `{role:"tool", tool_call_id, content}`; results flow back to the model via `NormalizedToolResult`; raw args and full result payloads are **not** persisted anywhere; SSE frames `tool_call_start`/`mcp_tool_start`/`mcp_tool_result` carry names/status only | recon slice 4 (`toolDispatcher.ts:282,426-428,493-546`; `streaming.ts:754,761,1024-1049`) |
| Audit | `audit_events` one `chat.message` + artifact rows per turn (`document.generated/edited`, `workflow.applied`, `inference.attested`); `detail` jsonb carries flags/identity only; tool calls are not audited per-call | `backend/schema.sql:4784-4799`; `backend/src/lib/audit.ts:120-235` |
| Project chat suffix | project chat appends `displayed_doc:` to the **current (last) user message only**, so it stays at the tail — not a prefix mutation | `backend/src/modules/project-chat/projectChat.service.ts:555-575` |

One mutation site is a certain prefix divergence: the recap is appended to the *last
assistant message* of each request and derived from the *newest* persisted assistant
row, so the same historical message carries the recap in one request and not the next.
The token prefix diverges at that position every turn (`[INFERENCE]` from the code
paths above; it is exactly the failure mode Pi's deterministic-render rule forbids).

A second, subtler risk sits in the time stamper. Historical user messages are stamped
from persisted `created_at` values (`contextBuilders.ts:553-577`), which are stable —
**but the loader selects every `role = 'user'` row for the chat with no active-path
filter and aligns stored times to the sent history *positionally from the newest
backwards*** (`contextBuilders.ts:565-573`). On a chat with abandoned sibling branches,
the newest stored rows can belong to another branch, shifting which timestamp lands on
which active-path message; the rendered text then changes between turns.
`[INFERENCE]` — the alignment bug is read from the query and loop, not yet reproduced
in a test.

Additional repo facts that constrain the design:

- The single transcript assembly point is `buildMessages` (`contextBuilders.ts:410`;
  called at `chat.prepare.ts:497`), fed by the **client-supplied** `ChatMessage[]`,
  not by the persisted transcript (`chat.prepare.ts:74-95` declares the prepared
  shape; `chat.routes.ts:779` hands `apiMessages` to `runLLMStream`). Historical reads
  for the web UI use `getChatMessages` (`chat.messages.ts:152`), which walks the active
  path — a different consumer.
- The stream run registry is process-local with 60 s retention after finish, but it
  already provides `id: <seq>` frames and a resume endpoint
  `GET /chat/:chatId/turn/:turnId/stream?from=<seq>` (`chat.routes.ts:172-212`).
- `audit_events` is written only by the backend `service_role`, has RLS **enabled with
  no policies** and explicit `select/insert/update/delete` grants to `service_role`
  (`schema.sql:4790-4800`) — append-only by convention, **not** enforceable today.
- `chat_messages` has **no RLS**; access control is service-layer.
- `db_jobs` is a mature Postgres queue: `FOR UPDATE SKIP LOCKED` claim RPCs with stale
  recovery, `dedupe_key`, exponential backoff, dead-letter retention, and fenced writes
  guarded by `id+status+attempts+claimed_at` (`dbq/runner.ts:92-97,146-155`). Lease
  patterns already exist for uploads, tabular generation, and memory turns.

---

## 4. Gap analysis

| Property we want | Pi Durable mechanism | Mike today | Gap |
|---|---|---|---|
| Append-only transcript, raw tool calls/results included | `pi.assistant` / `pi.tool-result` entries, immutable | Only display events persisted; raw args/results dropped | **Large** — new table + engine writes |
| Stable prefix across turns (KV cache) | Positional `pi.system` patches; deterministic renderers; no in-place mutation | Recap + `displayed_doc` mutate prior messages; client resends its own copy | **Small** — move injections to appended entries |
| Compaction that keeps originals retrievable | `pi.compaction` entry with `head`; `scanEntries()` keeps everything | Prompt-only projection; nothing durable (Mission 2) | **Medium** — entries table + retrieval endpoint |
| Crash-proof runs | Tasks with checkpoints; resume on reopen | In-process run; crash loses the turn | **Large** — run/task records + resume |
| Exactly-once submissions | `requestId` dedupe across retries/restarts | None (a client retry re-runs the turn) | **Small–Medium** |
| Subagents | Task-owned conversations; background anchors; child-task waits | None | **Large** |
| Branching/forks | `parent.at` + fork; new provider identity per fork | `parent_message_id` + `chat_leaf_state` already live | **Small** — align with entries, no UI change |
| Immutable audit journal, streamed | *Explicitly a non-goal*; watch streams converge, not deliver | `audit_events` mutable; stream is in-memory | **Large** — new journal + WORM export |

---

## 5. Target design (Mike-native, Postgres)

### 5.1 Source of truth: `conversation_entries` (append-only)

One immutable row per transcript fact. Applies Pi's entry model with Mike's keys.

```
conversation_entries
  id            uuid  pk default gen_random_uuid()
  chat_id       uuid  not null references chats(id) on delete cascade
  seq           bigint not null            -- per-chat monotonic (unique (chat_id, seq))
  kind          text   not null            -- user.message | assistant.message | tool.call |
                                           -- tool.result | system.section | compaction | reset |
                                           -- agent.config | note
  payload       jsonb  not null            -- canonical, application-visible content
  model_payload jsonb                      -- exact provider-facing message(s) for this entry
  parent_entry_id uuid references conversation_entries(id)   -- tree edge
  head_entry_id uuid references conversation_entries(id)     -- compaction/reset cut (nullable)
  edited        jsonb                      -- ContextEdit[] (omit|replace) attached to THIS entry
  by_task_id    uuid                       -- attribution (subagent / background task)
  created_at    timestamptz not null default now()
  prev_hash     bytea not null             -- chain within chat
  hash          bytea not null             -- sha256(canonical(row) || prev_hash)
```

Invariants (enforced by the database, not by convention):

1. **Privileges:** `revoke update, delete, truncate on conversation_entries from authenticated, service_role`;
   grant `select, insert`. Runtime roles never own the table.
2. **RLS:** enabled *and* `force row level security`; `select` policy = chat membership;
   `insert` policy = membership + `auth.uid()`/service context; **no** update/delete policies.
3. **Trigger guard:** `before update or delete` → `raise exception`. Catches the owner and
   `service_role` too (both bypass RLS). Document that a superuser can still drop the
   trigger; that is why the chain exists.
4. **Chain:** `hash = sha256(canonical_json(entry) || prev_hash)` per chat; a nightly
   `audit-manifest` job signs the per-chat head hashes into one Merkle root and writes it
   to WORM storage (S3 Object Lock, compliance mode) so tampering is detectable by a
   third party, not just by the database owner.
5. **Single writer per chat:** a lease row (mirror `upload_processing_jobs`) held by the
   process running the turn; a stalled lease is reclaimed by the same stale-recovery
   rule the queue uses. This replaces the "reservation row with `content = null`"
   trick and gives an explicit `seq` allocator.

Backfill: each existing `chat_messages` row becomes one entry (`user.message` /
`assistant.message`), `parent_entry_id` from `parent_message_id`, preserving abandoned
branches. `chat_messages` stays as the **UI projection** so no frontend work is forced.

### 5.2 Derivation: entries → model messages

Port Pi's derivation rules (spec §2.1) into one function, `deriveConversation(chatId, leafId)`:

- newest applicable `head` (from `compaction`/`reset`) starts the scan;
- newest `edited` (omit/replace) per target wins;
- tool results are relocated directly after their assistant call, in call order;
  synthesize an error result for every unanswered call (fork cuts, interrupted tails);
  drop orphan results;
- exclude assistant messages with `aborted`/`error`/`deferred` stop reasons;
- system sections are **positional deltas** replayed in order; a head cut triggers one
  full-baseline `system.section` entry (Pi's rebaseline rule);
- normalize a leading system message to the front.

`buildMessages` remains the composition point for Mike-specific content (spotlight
nonce, doc availability, memory injection), but every one of its outputs becomes a
**rendered section of a `system.section` entry**, not an ad-hoc string concatenation —
otherwise determinism cannot be checked.

### 5.3 Tool trajectory, exactly once

- `tool.call` entry is committed **before** execution (intent + arguments), like Pi's
  tool-task intent commit.
- `tool.result` entry carries the full payload, or a pointer + hash + bounded preview
  when the payload exceeds a threshold (large document reads go to object storage;
  derivation expands the preview and can page the full body on demand).
- Each tool declares a replay policy: `safe` for read-only tools (`read_document`,
  `find_in_document`, legal search); `unsafe` (default) for anything that mutates
  documents, sends approvals, or calls connectors. A crash during an unsafe call
  produces an `interrupted` result the model can see and reason about.
- Side effects stay outside the entry commit, exactly as Pi requires.

### 5.4 Prefix discipline (the KV-cache work)

Checklist, all of it cheap and mostly independent of the entry table:

1. **Stop mutating prior messages.** `enrichWithPriorEvents` appends a new
   `note` entry (or a system delta) instead of rewriting the last assistant message;
   project chat does the same for `displayed_doc`. This alone removes the prefix
   divergence described in §3.
2. **Forward provider cache identity.** Keep OpenAI `prompt_cache_key`; add a persisted
   per-chat provider session id; send it wherever the provider supports one
   (OpenCode Go support is unknown — measure, do not assume).
3. **Deterministic renderers.** Any section whose text varies without a real content
   change (current time, "now" strings) must be pinned per turn or excluded from the
   cached prefix. `userMessageStamper` needs an audit: if it re-renders historical
   messages with new text on each request, it is a cache killer.
4. **Measure.** `contextTokensFromUsage` already parses provider usage; record
   cache-read vs cache-write per request and chart it. Mission 2's >90 % claim was
   deliberately not asserted — this is the instrumentation that would settle it.

### 5.5 Durable runs

`conversation_runs` (or a `run_tasks` table keyed by `db_jobs` id):

- phases: `prepare → generate → tools → commit`, each committed as a checkpoint with
  the payload needed to resume;
- resume on worker start (`harness.resume()` analogue): `running` → `pending`, then
  continue from the last checkpoint; a cut-off model request resends and marks the
  partial aborted; a tool resumes or reports `interrupted` per replay policy;
- `request_id` on submissions for exactly-once admission;
- UI: `GET /chat/:chatId/runs/:runId` + the existing SSE resume endpoint; the run
  registry becomes DB-backed so resume survives a process restart (today it dies with
  the process after 60 s).

### 5.6 Subagents

- `chats` gains `parent_chat_id`, `forked_at_entry_id`, `owner_task_id`, `background bool`.
- A `subagent` tool creates a task-owned child chat whose agent config is a copy of the
  parent's (model, tools, instructions) with per-type narrowing — reviewer on a cheaper
  model, read-only tools, no subagents of its own.
- Abort propagates down the ownership edge; `background: true` children survive the
  parent's abort and do not block idle.
- Steering uses the existing message API with `whenBusy` semantics
  (`steer` = after the current tool round, `followUp` = after the answer, `reject`).
- The task graph (`GET /tasks/graph`) is the UI contract for nested progress.

### 5.7 Branching

Station 5 already implements the user-visible half (`parent_message_id`, per-user leaf,
sibling navigation). The design only needs: entries carry the same tree edge, a **fork**
is a new `chats` row with `parent_chat_id` + `forked_at_entry_id`, and **regenerate** is
a new sibling entry under the same parent. Forks mint a **fresh provider session id**
(Pi does the same), so branch caches never fight.

### 5.8 The audit journal (production NFR)

Pi's watch streams are convergence-oriented by design and its spec lists a semantic
event journal as a non-goal; our requirement is stricter, so it is built as a
first-class journal rather than derived from UI state:

- **Journal:** the `conversation_entries` chain *is* the per-chat journal (append-only,
  hash-chained, DB-enforced). A thin `audit_events` remains for cross-domain actions
  (document lifecycle, exports, permissions) and gains the same immutability treatment.
- **Streaming:** SSE from the durable table ordered by `seq`, resumable via
  `Last-Event-ID` — the protocol already exists in `streamRuns.ts` (frames carry
  `id: <seq>`); the change is to serve resume from Postgres rather than an in-memory
  buffer, with at-least-once semantics and explicit client acknowledgement for audit
  consumers. Delivery guarantees must be stated: the journal is the source of truth;
  the stream is a convenience with replay, never the record.
- **Immutability layers:** privilege revocation + `force row level security` +
  `before update/delete` trigger + hash chain + **external anchoring** (signed Merkle
  root of per-chat heads to S3 Object Lock / WORM, daily). Any single layer is
  insufficient: privileges are bypassed by the table owner, RLS by `service_role`,
  triggers by `session_replication_role = replica` or a superuser, and a chain by
  anyone who can recompute it — anchoring is what makes tampering detectable by a third
  party.
- **Legal hold / retention:** per-matter retention windows and a hold flag that blocks
  any purge job; purge is itself an audited, chain-preserving operation (tombstone
  entries rather than deletes).

---

## 6. Migration plan (option A)

Each stage is independently shippable and reversible. Sizes are relative effort, not
calendar time.

**M0 — Prefix discipline and instrumentation (small).**
End recap and `displayed_doc` mutation; append notes instead. Add cache-read/write
metrics per request. *Acceptance:* in one chat, turn 2's derived prompt is byte-identical
to turn 1's prompt plus the appended suffix (property test on the derivation output);
provider usage shows non-zero cache reads on a cache-supporting route.

**M1 — Entry log, double-write, derivation switch (large).**
Create `conversation_entries` with privileges/RLS/trigger/chain; write entries for
`user.message`, `assistant.message`, `tool.call`, `tool.result`; backfill from
`chat_messages`; derive model context from entries behind a flag; keep `chat_messages`
as the UI projection. *Acceptance:* adapter test proving a prior turn's `read_document`
result reaches the next request; `update`/`delete` rejected for service_role and
authenticated; chain verification CLI green on a fixture with an injected tamper.

**M2 — Durable runs and resume (large).**
Run records + checkpoints + resume-on-start; `request_id` idempotency; DB-backed SSE
resume. *Acceptance:* kill the process mid-tool-round and prove the run resumes with the
same `seq` stream and no duplicate side effect (unsafe tool → `interrupted` result).

**M3 — Compaction as an entry, with retrieval (medium).**
`compaction` entry with `head_entry_id`; reuse Mission 2's budgeting; add
`GET /chats/:id/entries?before=` and a UI affordance to open the originals behind a
summary. *Acceptance:* after compaction the next request carries the summary + kept
suffix and the pre-compaction tool results are still retrievable byte-for-byte.

**M4 — Subagents (large).**
Ownership edges, `subagent` tool, background anchors, steer/follow-up, task graph.
*Acceptance:* parallel read-only research over N documents with one child failing
(`failFast` vs `allSettled` tested), abort propagation, restart survival.

**M5 — Audit journal streaming, anchoring, holds (medium).**
DB-backed resume stream, daily signed Merkle root to WORM, retention/legal hold.
*Acceptance:* export → independent verifier re-derives the chain; a tampered row fails
verification; legal hold blocks purge.

---

## 7. Radical option evaluated: replace the loop with Pi Durable

Owner question: *rip out the existing loop, embed Pi + Pi Durable, and add Mike's custom
tools and workflows back on top* — versus *rewrite Mike's internals using Pi Durable's
patterns*. Three options were sized against primary sources and the repo.

| | A. Pattern adoption | B. Wholesale embed | C. Scoped hybrid |
|---|---|---|---|
| Loop | keep `runLLMStream` + AI SDK adapter | delete (~5.5k LOC driver: `streaming.ts` 1159, `aiSdk.ts` 1078, `providers.ts` 489, `toolDispatcher.ts` driver 2166, `streamRuns.ts` 403, `assistantTurnRuns.ts` 188) and run `Harness` | keep for chat; run `Harness` for background/durable work only |
| Storage | Supabase Postgres (existing) | **write a Postgres `Storage` adapter** (~1.1–1.4k LOC *estimate*; reference backends total 3,221 LOC) **plus an owner-routing layer the package does not provide** | Postgres adapter, scoped to background runs |
| Model layer | AI SDK (keep) | pi-ai — **OpenCode Go is natively supported** (`opencodeGoProvider()` + required `x-opencode-session` header); OpenAI-compatible custom providers supported; `CacheRetention`/`sessionId` gives per-provider cache affinity | pi-ai for background runs |
| Tenancy | RLS + service layer (keep) | harness has **no tenant concept**; its writes bypass RLS; isolation moves into routing + our service layer | unchanged for chat |
| Client tools (Word) | unchanged | **absent natively** — must be emulated (terminate-and-wait or an out-of-band bridge) | n/a |
| `ask_inputs` pause / approvals | unchanged | **needs an adapter** (`deferred` is provider-side polling, not a human pause; the mapping is a tool with `control: { terminate: true }` + a later submission) | n/a |
| MCP | host-wrapped (existing) | no native MCP runtime; wrap into `defineTool` | n/a |
| Frontend contract | unchanged (`AssistantEvent` SSE) | translate `watch`/`watchEvents`, or rewrite the contract consumed by the assistant UI | unchanged |
| Audit journal (NFR) | we build it | **still ours** — spec calls a semantic journal a non-goal | still ours |
| Effort | ~4–5 staged workstreams (M0–M5) | adapter + routing + tool/provider port + contract translation; net new code likely exceeds what is deleted | one workstream on top of A |

**Corrected concurrency finding (whole-project accounting).** The initial claim of
unavoidable corruption from a bare metadata update was overstated. As §10 records,
commits validate duplicate IDs transactionally; counter allocation, Session-local
document baselines, ownership/fencing, effect execution and stream resume are distinct
problems. Mike already has a process-local single-run assumption that needs its own
deployment treatment. This is an architectural cost to evaluate, not proof that
embedding is impossible or that one host process per human conversation is required.

Against that, B's genuine wins are real: checkpointed crash recovery, exactly-once
admission, and positional system-prompt deltas are specified in enough detail to copy
directly, and pi-ai already speaks OpenCode Go with a per-conversation session header —
something Mike's adapter does not send today.

**Historical recommendation, not an owner decision.** The first research pass favored
A (pattern adoption), with C as a background-work spike. The owner subsequently asked
for divergent concurrency alternatives and explicitly remained uncommitted. A, B and
C therefore remain alternatives to evaluate against raw history, compaction/archive,
Word client tools, branching, task recovery, RBAC and immutable audit requirements.
The whole-project course in `goals/TRIAGE.md` supersedes any apparent build-order
commitment here. Do not start a pattern port or reject embedding on this paragraph's
authority alone.
Either way, the audit journal (§5.8) is unaffected: it is ours in all three options.

## 8. Risks and open questions

1. **Table owner bypass.** Supabase migrations run as the owner; the owner can drop the
   guard trigger. Mitigation: chain + external anchor (M5) and an alert when the trigger
   is absent (schema-drift check already runs in CI — extend it).
2. **Volume.** Full tool payloads are large (document reads). Mitigation: hash +
   preview in-row, body in object storage; entry rows stay bounded; compaction budgets
   operate on previews.
3. **Prompt growth.** Carrying real tool trajectory (correctly) grows prompts; that is
   why M1 and M3 belong together. Mission 2's thresholds and recovery logic are the
   budget engine; they must be re-pointed at derived entries.
4. **Provider cache semantics for OpenCode Go are unknown** — `prompt_cache_key` is an
   OpenAI convention. Do not promise a hit-rate improvement; measure it (M0).
5. **`pi-durable` is experimental** and its storage/model layers do not fit Supabase
   multi-tenancy. Pattern adoption avoids the risk; a spike against the npm package is
   optional and separate.
6. **Single-writer leases** add a failure mode (stalled lease during long tools).
   Reuse the queue's stale-reclaim rule and keep tool calls out of the lease where
   possible.
7. **Open question — branch-safe time stamping.** The stamper reads persisted
   `created_at` values, but aligns them positionally against *all* user rows in the
   chat, so a branched chat can stamp the active path's messages differently between
   turns. Confirm and fix (filter to the active path) before M0 lands; the derivation
   property test in §9 catches it.

---

## 9. Verification (how we would know it works)

- **Derivation property tests:** for any transcript prefix P and appended turn T,
  `derive(P)` is a byte-prefix of `derive(P + T)` (the cache invariant), except across an
  explicit head cut.
- **Immutability tests:** SQL-level update/delete attempts fail for both `authenticated`
  and `service_role`; the chain verifier detects an injected mutation made by a
  superuser.
- **Crash tests:** process-kill at each run phase resumes without duplicate side
  effects; unsafe tools surface `interrupted`.
- **Cache metrics:** per-request cache-read/write counters persisted and charted; the
  M0 change shows a measurable delta on a cache-supporting route.
- **Audit end-to-end:** export → external verifier → tamper detection → legal-hold
  enforcement.

---

## 10. Divergence: can the concurrency problem be solved?

A divergent panel (6 substantive members: Gemini-3.8, DeepSeek-V4.1-flash, Kimi-K3,
GLM-5.3-flash, MiniMax-M3, Muse-Spark; 5 members failed on quota/route errors:
Codex, GPT-6.1-sol, GPT-6-Luna, Claude-Opus-4.6, DeepSeek-V4-pro), one extra
corrected-evidence member, and a cross-chat state inventory were run to expand — not
settle — the option space. Raw outputs: `.agentic-consensus/concurrency-divergent/`.

### 10.1 The constraint is weaker than §7 assumed

Reading the package source changes the mechanics:

- `commit()` re-reads `next_id`/`next_seq` **inside** the transaction, validates every
  global ID against a `record_ids` table (`checkGlobalIds` throws on duplicates), and
  writes back `max(next_id, candidateNextId)`. Only `mintId()` is a per-process counter.
  So two processes on one store produce **failed commits, not silent corruption** —
  provided the adapter allocates IDs atomically (`UPDATE … RETURNING`, a sequence, or
  UUIDv7) instead of the in-memory counter.
- What genuinely requires single ownership is **in-process Session state** (committed
  Chord document baselines and trackers) plus the spec rule that two Harness instances
  must never own the *same Session* concurrently — not "one process per database".
- Unresolved hazard the panel named: two writers can prepare document deltas against the
  same base, and base staleness is enforced by the Session's tracker rather than by
  `Storage`; the `StorageWrite.document.change` payload's CAS-ability is unverified.

### 10.2 The finding that reframes the whole question

Mike already requires per-chat single-owner execution **today**, independent of any
harness: the run key is `<surface>:<chatId>` "so a chat may have one turn at a time"
(`assistantTurnRuns.ts:22-24`), enforced only by an **in-process** registry
(`chat.routes.ts:669-675`), and the architecture doc already instructs operators to
"run one replica, or route by session, until the buffer is moved to shared storage"
(`docs/backend-architecture.md:179-182`). The same document records a known
double-execution hazard for replayed client tool calls. So a per-chat ownership/routing
layer is **pre-existing shared infrastructure**, not a tax that Pi Durable introduces: it
fixes a latent cross-replica bug and is what SSE resume needs anyway. That downgrades
§7's "blocker" to "cost and latency", and the cost is shared with option A.

### 10.3 The option space (grouped by disposition; numbers are panel artifacts)

**Satisfy single ownership**
1. Lease + epoch fence threaded through the storage context, verified inside the commit
   transaction (generalizes Mike's existing lease RPCs).
2. Sticky-shard harness fleet: consistent-hash routing, one Session per chat per process.
3. Virtual actors via `pg_try_advisory_lock(hashtext(chat_id))` with an internal proxy —
   also fixes the process-local run registry.
4. A `sessiond` tier with a placement directory and generation epochs, plus an
   externalized stream broker (the only option that truly fixes stream attach).
5. Cloudflare Durable Objects / stateful sidecar — Pi's native shape; Postgres becomes a
   sink (data-residency caveat).
6. Per-tenant silos: one database and one writer per tenant (isolation by construction,
   unit-economics risk).
7. WORM journal in Postgres + per-session SQLite on an exclusively mounted volume
   (zero adapter LOC, worst failure class if the mount is wrong).
8. Sharded micro-databases with Litestream replication (native backend, cold-start cost).

**Dissolve the constraint**
9. Turn-scoped claims: no long-lived owner; claim the mutation window, rebuild the
   Session, release (ownership = lease lifetime).
10. Storage-per-chat slices: redefine storage granularity so the single-owner rule never
    constrains fleet concurrency (fan-out cost for cross-chat queries).
11. Adapter-level OCC/CAS with sequences/UUIDv7, deleting every shared counter — the
    honest test of whether the constraint is mechanical or semantic.
12. Journal-primary CQRS: the immutable journal is the system of record; any runtime is a
    projector (makes the audit NFR the architecture).
13. Chain-head CAS: the WORM journal *is* the storage, the head hash is the token.
14. Branch-and-merge Merkle DAG: concurrent appends become forks (breaks linear prefix
    caching; only viable if the product accepts branch semantics).
15. Preemptible ownership with a durable mailbox and migration at await points.
16. Client-owned edge harness in the Word add-in/browser (dies on background durability).

**Externalize the problem**
17. A durable-execution engine (Temporal/Inngest/Trigger.dev) owns exclusivity; Pi runs as
    a stateless step (streaming and per-turn atomicity are the stress points).
18. Outbox inside the commit transaction + one per-tenant sequencer into the hash chain
    (composes with any ownership model; audit stays off the hot path).
19. Object-store conditional writes + Object Lock as the storage of record.
20. Log partitioning (NATS/Kafka per chat): the log is queue, arbiter and audit at once.

**Reframe**
21. Measure whether the constraint is empty: census every commit's
    `(conversation_id, process_id, admitted_turn_id)`; fix only the counters; let the
    census define the serialization scope. This is the cheapest decisive experiment.

**Keep-the-loop variants**
22. Background-only harness sidecar (Pi never serves a user-visible token).
23. Mike-native state-contract port (Pi's entry/task/derivation rules, no Pi code).

### 10.4 Cross-cutting observations the panel converged on (without converging)

- **Composability, not competition:** options 1/9/18 compose (advisory lock for
  interactive turns, queue claims for background runs, outbox sequencer for audit) over
  one Postgres with the fencing discipline Mike already has.
- **The expensive part is stream attach, not write ownership.** Several members
  independently noted that the cost usually attributed to "embedding Pi" is really the
  process-local run registry and resume; the audit journal can pay for that fix.
- **Failure classes differ more than mechanisms do:** lost turn (9), duplicate external
  effect (1, because Pi runs effects outside commit), silent document merge (11),
  cross-tenant leak (5/17/19), corruption only under double-mount (7).
- **What each does to the audit NFR:** in-path (12, 13), downstream sequencer (18),
  infrastructure WORM (19), orthogonal (most others) — and Pi's own watch streams never
  qualify.

### 10.5 Private-stack boundary and option disposition

The owner excludes external orchestration services such as Temporal and Cloudflare.
Default to the existing privately operated stack. The earlier blanket exclusion of
every additional self-hosted service, object store or client execution option was an
assistant inference, not an owner-ratified decision. New dependencies still need a
specific privacy, operational-cost and failure-boundary justification; that is not
permission to add them.

This boundary does not rescind the expressly requested Phala/DGX inference lanes,
controlled source/web retrieval, development OpenCode/OpenRouter usage, or Tailscale
access. External orchestration and policy-approved inference/source access are
different decisions.

Firm handoff requires actor/authority attribution, permission rechecks and reliable
turn/effect ownership. It does not force human identity to equal process or Session
ownership, nor select turn-scoped claims or journal-primary CQRS by itself. The 23
option families remain research alternatives filtered by the above constraint; no
runtime design or new service is selected in this report.

### 10.6 Cheap, decisive experiments before any commitment

1. Two-replica double-send on one chat: does it double-run today? (Latent-bug check and
   the empirical basis for option 21's census.)
2. Run `registerStorageConformance` from two processes against one Postgres adapter
   (option 11's falsifier): do conflicts surface as failed commits, and does the Session
   tolerate them?
3. Inspect `StorageWrite.document.change` for a CAS-able base version (decides whether
   storage-level OCC covers documents or entries only).
4. Measure Session reconstruction/hydration cost on a 1,000-entry conversation (prices
   options 9/10 and the turn-scoped family).
5. Price per-tenant idle capacity (option 6) and stream-broker ops (option 4) against the
   shared-RLS model.

**No commitment is implied.** The panel's own summary: the constraint is solvable six
ways, dissolvable several more, and the decision reduces to latency budget, ops appetite,
and how much of the audit NFR the concurrency layer is allowed to pay for. §7's
recommendation stands only as the current default until the owner picks a direction.

---

## 11. Firm multi-user handoff and subagent verification (forward constraints)

Owner direction, 2026-10-07: the platform must support a firm — a partner starts a
thread, an associate continues it, a third person reads or resumes it — with RBAC over
projects and files. This is not built now, but the design must not foreclose it. The
same direction names two subagent workloads: **document review** and **citation
checking** (does the cited source exist, and does it say what it is quoted as saying —
local document, external system, or web).

### 11.1 What already exists (verified in the schema and code, not assumed)

The RBAC substrate is largely in place; the mission is semantics and gaps, not
greenfield:

| Piece | Where | State |
|---|---|---|
| Organizations and membership | `organizations`, `org_members`, `org_invitations` (`backend/schema.sql:208,222,301`) | present |
| Project roles + capability matrix | `ProjectRole = owner\|editor\|viewer`, `can()` (`backend/src/lib/permissions.ts`) | present |
| Project sharing | `project_access_grants`, `project_org_access_overrides` (`schema.sql:580,600`) | present |
| Chats inside a project/org | `chats.project_id`, `chats.org_id`, nullable `chats.user_id` (`schema.sql:1970-1984`) | present |
| Per-chat sharing | `chat_access_grants(chat_id, email, role)`, resolution `chat_access_role()` — project role wins, then creator-as-owner, then grant (`schema.sql:2000,2042-2064`) | present |
| Grant service + endpoints | `backend/src/lib/contentAccess.ts`; `chat.routes.ts:334` (create, 201) and `:361` (delete) | present |
| Per-message authorship | `chat_messages.author_user_id`, indexed; written at `chat.prepare.ts:413`, `chat.branches.ts:115` | present |
| Author-aware memory | `memory.curator.ts:384-397` scopes segments by `author_user_id`, with shared-conversation handling | present |
| Actor-attributed audit | `audit_events(user_id, user_email, action, surface, project_id, chat_id, document_id, review_id, model, detail)` (`schema.sql:4784-4800`) | present |

So "a partner starts a thread and an associate picks it up" is mostly a *semantics +
UX + gap-closing* mission over an existing model. Whether every read/write path
actually enforces the resolved role is not yet audited; that audit is part of the
mission, not an assumption here.

### 11.2 The gaps that matter for handoff

1. **Turn admission is process-local.** The run key is `<surface>:<chatId>`
   (`assistantTurnRuns.ts:22-24`) and admission uses an in-memory registry
   (`chat.routes.ts:669-675`). That registry cannot enforce one turn across replicas.
   Actor attribution, admission/fencing, effect ownership and recovery must be
   addressed by the §10 runtime decision. A DB-fenced per-chat claim is one proposal,
   not an architecture selected by human handoff or a requirement to adopt CQRS.
2. **Document version authorship is indirect.** `document_versions` has `deleted_by` but
   no `created_by`; provenance runs through `document_edits.chat_message_id` →
   `chat_messages.author_user_id`. Any new version-writing path should stamp the actor
   (and the authority used) directly.
3. **Subagent work must not outlive or exceed its actor's authority.** A verification
   task launched by a Viewer must not gain edit capability; a background task must not
   keep project access that the actor lost. Task rows should carry
   `(actor_user_id, project_id, effective_role)` and be re-checked at each effect, not
   only at spawn.
4. **Egress is a policy surface, not a tool flag.** Web/connector citation checking
   is controlled outbound source access, not the only possible approved egress.
   It needs scope-aware allow/deny, fetch attribution and durable snapshots (11.3).
   Today citation snapshots are process-local and unbounded (`STATUS.md`, station 3).
5. **Presence and hold.** Collaborators need to see who is generating, and a second
   sender needs an honest answer (today: `409 turn_in_progress`) rather than a silent
   second run or a lost message.

### 11.3 Subagent workloads and what they require

**Citation checking.** For each citation: does the source exist, and does it support the
quoted claim? Three source classes, one contract — every verified claim carries
machine-checkable provenance: local document → `document_id` + `block_id` (Mission 1c's
stable ids) + content hash; web → URL + `fetched_at` + SHA-256 of the extracted text
kept durably in Postgres; external system → connector id + record id + retrieved-at.
The checker must be a *separate* agent from the producer (no self-grading), must report
"not found" and "quote mismatch" as distinct verdicts, and its output must be a review
row per claim with the evidence, not prose. Station 3 already anticipated this in the
chunk schema (`document_chunks` carries `page_no`/`page_source` "so citation checking
can tell extracted text from OCR output downstream").

**Document review.** Multi-pass over a document by block id, findings anchored to ids
and quoted text, then a verification pass over the findings; output as review rows the
UI can act on. The block-id stability from Mission 1c is the precondition that makes a
finding survive edits between passes.

**Proposed harness shape, not a selected architecture.** Existing Postgres/worker
infrastructure could carry task checkpoints, isolated conversation scope, limits,
cancellation and parent links. Pi Durable offers comparable child-task,
background-anchor, instruction and spend-accounting primitives
(`spec.md:2094-2103,3039-3069,3077,4634-4640`). Whether to embed those primitives or
implement Mike-native equivalents remains open (§7); the private-stack requirement
does not itself choose the package or storage representation.

### 11.4 What "future-proof" concretely means here

Any concurrency decision from §10 must satisfy these; a design that fails them is
rejected even if it is simpler:

- Per-chat turn admission is enforced where a second replica can see it, and records
  the actor.
- Every persisted assistant turn, document version and audit row can name the user and
  the effective role that produced it.
- Subagent tasks inherit and re-check their actor's authority; they can never elevate.
- Verification artifacts (citation evidence, review findings) are durable rows with
  hashes, so a third person can re-check them months later.
- No new external control plane (owner decision, §10.5).

Mission drafts carrying the acceptance criteria: `goals/mission-5-firm-thread-handoff.md`
and `goals/mission-6-citation-verification-subagents.md`. Both are `readiness: drafted`
and not part of the current agenda until the owner promotes them.

---

## 12. Provenance and sources

Research slices (six subagents, 2026-10-07):

| Slice | Agent | Model | Output |
|---|---|---|---|
| Pi Durable internals | `PiDurableCore` | gemini-3.8-flash (antigravity) | `agent://PiDurableCore` |
| Subagent patterns | `PiSubagents` | deepseek-v4-pro | `agent://PiSubagents` |
| Pi principles | `PiPrinciples` | gemini-3.8-flash | `agent://PiPrinciples` |
| Audit NFR prior art | `AuditNfrResearch` | kimi-k3 | `agent://AuditNfrResearch` |
| Mike branching/streaming/audit | `MikeBranchingRecon2` | deepseek-v4-pro | `agent://MikeBranchingRecon2` |
| Mike tool trajectory | `MikeToolTrajectoryRecon` | deepseek-v4-pro | `agent://MikeToolTrajectoryRecon` |
| Embed: storage/ownership feasibility | `EmbedStorageFeasibility` | deepseek-v4-pro | `agent://EmbedStorageFeasibility` |
| Embed: model/tool/client-bridge fit | `EmbedModelToolFit` | gemini-3.8-flash | `agent://EmbedModelToolFit` |
| Loop replacement surface | `MikeLoopSurface` | deepseek-v4-pro | `agent://MikeLoopSurface` |
| Report verification | `ReportVerify` | gemini-3.8-flash | verdict accept-with-fixes; three citation corrections applied (spec quotes located to §9.2/§4/§7.4, call sites corrected to `chat.prepare.ts:497` and `chat.routes.ts:779`) |
| Concurrency divergence (panel) | `agentic-consensus-runner --mode divergent` | Gemini-3.8, DeepSeek-V4.1-flash, Kimi-K3, GLM-5.3-flash, MiniMax-M3, Muse-Spark (6 ok; Codex/GPT-6.1-sol/GPT-6-Luna/Claude-Opus-4.6/DeepSeek-V4-pro failed on quota or route errors) | `.agentic-consensus/concurrency-divergent/`; synthesized in §10 |
| Concurrency divergence (corrected evidence) | `DivergentCorrected` | muse-spark | `agent://DivergentCorrected` |
| Cross-chat shared state | `CrossChatStateRecon` | deepseek-v4-pro | `agent://CrossChatStateRecon` |

A first `MikeBranchingRecon` attempt returned placeholder output and was discarded and
re-run (`MikeBranchingRecon2`).

Primary sources:
- https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md
- https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples
- https://earendil.com/posts/pi-durable/ · https://earendil.com/posts/pi-1-0/ ·
  https://earendil.com/posts/what-is-a-harness/
- https://github.com/championswimmer/pi-subagent-manager
- https://www.mindstudio.ai/blog/pi-durable-long-running-agents (third-party analysis)
- Postgres: https://www.postgresql.org/docs/current/ddl-rowsecurity.html ·
  https://www.postgresql.org/docs/current/sql-revoke.html ·
  https://www.postgresql.org/docs/current/pgcrypto.html ·
  https://www.postgresql.org/docs/current/triggers.html
- https://supabase.com/docs/guides/database/postgres/row-level-security ·
  https://datatracker.ietf.org/doc/html/rfc6962 (Merkle) ·
  https://csrc.nist.gov/pubs/fips/180-4/upd1/final (SHA-256) ·
  AWS S3 Object Lock docs (WORM anchoring)

Repo sources: `backend/schema.sql`, `backend/src/modules/chat/{chat.tree,chat.branches,
chat.messages,chat.prepare,chat.routes}.ts`, `backend/src/modules/chat/engine/*`,
`backend/src/lib/{streamRuns,audit}.ts`, `backend/src/lib/dbq/*`, `backend/src/lib/llm/aiSdk.ts`,
`packages/contracts/index.d.ts`, `goals/station-4-…md`, `goals/station-5-…md`.
