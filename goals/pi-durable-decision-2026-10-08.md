# Runtime decision: embed Pi Durable or port its patterns

Date: 2026-10-08. Branch `feat/pi-runtime` (on top of
`feat/mission-2-compaction`). **A recommendation with measured evidence, not an
owner decision.** Background and the option space are in
[`pi-durable-recon-and-design.md`](pi-durable-recon-and-design.md) §7 and §10;
this file records what was measured and built on 2026-10-08 and what it implies.

## Recommendation

**Embed Pi Durable and pi-ai as Mike's chat runtime (option B), staged as a
strangler behind the existing `streamChatWithTools` boundary, rather than porting
its patterns (option A).**

The hard parts — durable tasks with checkpoints, crash recovery with replay
policy, exactly-once submissions, forks, compaction that keeps originals,
positional system-prompt deltas, subagents — ship in Pi already, pass its own
conformance suite on Mike's Postgres, and survived a real `SIGKILL` here. Option
A would rebuild each of those in Mike. Option B's costs are integration costs, and
the spike shows the integration seam is small: ~500 lines, with Mike's product
logic (prompts, guardrails, Auto Mode, client tools, dispatcher, citations,
persistence) unchanged and running in the real UI.

The earlier recon recommended A mainly because no Postgres storage existed and
the single-owner rule looked like a blocker. Both changed: a conformance-passing
Postgres adapter is published, and Mike already runs one replica with an
in-process turn registry, so a single owner per schema is today's constraint, not a
new one.

## What was measured (local Docker, Postgres 17.6 Supabase image)

Scripts are in `backend/src/durable/spike/`; each runs against a throwaway
`pi_spike` database.

| Experiment | Result |
|---|---|
| Upstream storage conformance (`registerStorageConformance`) against `@netzlabor/pi-durable-postgres` 0.2.0 + `pi-durable` 1.1.0 | **24/24 pass** |
| One Harness, N concurrent conversations, scripted streaming model, one tool round each (`bench.mts`) | 1 → 8.6 s/run · 25 → 10.7 s · 50 → 14.2 s · 100 → 19.2 s. Commit line saturates at **~150–160 commits/s**, commit p50 4–5 ms, p99 15–20 ms. Degrades by coalescing progress commits, never by failing. |
| Real `SIGKILL` mid-run, reopen in a new process (`crash.mts`) | Reopen **75 ms**. Streaming answer → partial kept as `aborted`, request resent, run completes. Replay-safe tool → reran once. Unsafe tool → **not rerun**; model got an `interrupted` error with the partial output and finished. Same `requestId` returned the original submission. |
| Reopen and derive context of a long conversation (`hydrate.mts`) | 1,000 entries: open 36 ms, context 28 ms. 5,000 entries: context 113 ms, view 193 ms. |
| Live adapter, `opencode-go/glm-5.3` (`liveAdapter.mts`) | Tool call through Mike-shaped `runTools`; a fact seen **only in a tool result** was recalled on a later turn from Pi's transcript (an open gap in today's loop). Regenerate forked the lineage. Misses were the model refusing to disclose a "code word"; the derived contexts were byte-identical and contained the result. |

**Capacity reading.** One Harness covers a firm where ~25 people generate at the
same moment with negligible slowdown. Beyond that, shard by organization: one
schema and one Harness per org, each with its own connection; the adapter's
per-schema advisory lock already prevents two processes owning one org. Postgres
on Linux will do better than Docker on macOS; these numbers are a floor.

## What was built and run in the real app

`MIKE_LLM_RUNTIME=pi` routes OpenCode Go turns to `backend/src/lib/llm/pi/runtime.mts`:

- One Harness per process, schema `pi_durable` in Mike's database, direct `pg`
  connection (`PI_DURABLE_DATABASE_URL`).
- Each Mike chat maps to a **lineage** of Pi conversations (a session document).
  The conversation whose user inputs match the client's history continues; a
  history that diverges forks before the first difference. Matching ignores the
  `[Sent: …]` stamps Mike re-derives per request.
- Mike's system prompt is the conversation's `instructions`; Pi appends a system
  delta only when its text changes. A fork with an unchanged prompt adds none.
- Mike tools are Pi tools whose `execute` calls the live request's `runTools`
  (sequential rounds, matching the dispatcher's turn state).
- **Memory** is snapshotted once into a new thread's first user message (still
  user-role, untrusted) and never re-sent; `read_memory` returns current memory.
  Per-turn injection is gone on this path.

In the browser, against the rebuilt backend image and the existing frontend: a
first turn and a follow-up streamed and persisted through Pi (`pi_durable` holds
user, positional system, and assistant entries with reasoning). **Regenerate**
from the UI produced conversation 18 forked from conversation 2 at the first
answer, sharing the cached prefix. **Edit prompt** could not be tested: the
frontend saved the branch and then never sent the re-answer — the previously
reported stale-live-turn defect, which happens before the backend is involved.

## Progress since the spike (stage 1)

- **Lineage by message id.** Each stored Mike message maps to its Pi conversation
  and entry; a turn continues its parent answer's conversation or forks at it.
  Text matching remains only for chats begun before the runtime.
- **Every provider on pi-ai** (`backend/src/lib/llm/pi/providers.mts`). Mike's
  static catalog (Claude, Gemini, GPT) and the OpenCode Go, OpenRouter and Vercel
  ids resolve to pi-ai's native catalogs. OpenCode Go uses three protocols
  (chat completions, Anthropic Messages, Responses) and pi already knows which
  id speaks which. Ids pi does not know, Ollama models, and
  `MIKE_MODEL_CONFIG_JSON` endpoints become one-model providers. One wrapper
  around the catalog applies a turn's user key (else the deployment key, with
  Mike's env aliases), the attestation pre-check (fail closed), and the
  local-model tolerance shim (`<think>` → reasoning, prose tool calls → real
  calls). Keyless endpoints send no `Authorization` header.
- **One-shot calls** (`completeText`: titles, tabular extraction, the guardrail
  classifier) and tool loops without a chat (memory curator, diligence) run on
  pi-ai too, the latter on an in-memory Harness so they leave no durable rows.
  Models that cannot turn thinking off get their lightest effort plus headroom,
  so a 64-token title is not eaten by reasoning.
- `maxIterations` is enforced: past the budget a tool call returns "answer with
  what you have" instead of running, and the model finishes.
- Live check (`backend/src/durable/spike/liveProviders.mts`): a tool round plus a
  title through glm-5.3 (chat completions), minimax-m3 (Messages),
  muse-spark-1.3 (Responses), and OpenRouter Gemini and Claude Haiku. All recalled
  the fact that appeared only in the tool result.

## Mission 3 branching (stage 3, browser-checked on the global chat)

On the rebuilt stack with `MIKE_LLM_RUNTIME=pi` and an OpenCode Go model:
regenerate adds a sibling answer with a "‹ 2/2 ›" navigator and no duplicate
prompt; stepping between answer versions and prompt versions shows each
branch's own answers (D2); editing the prompt just sent saves a version and
answers it immediately (D1/D3); "Branch into new thread" opens a new chat
holding the path up to that answer, and its next turn continued Pi conversation
77, a fork of the source chat's conversation at the answer's entry (D4).
Browser QA also found and fixed: edit and regenerate hidden until a reload in a
live session, and a finished turn grafted onto another branch after navigation.
Not browser-checked: the project chat page (same hook and server routes; fork
navigation differs), phone width, and the D1 failure path (unit-tested).

## Turns survive a restart (stage 2, checked with `docker kill`)

A global or project chat turn records its durable context (user, chat,
project, model, options, displayed and attached documents, prompt id) in a Pi
session document before its input is sent. On startup each module re-prepares
its recorded turns from storage, so access is checked again and documents are
reloaded. It then drives each one into a server-owned run that a reloading
client attaches to. Tool schemas are persisted, so the Harness can re-install
them before resuming. Reads (tier 1) replay as safe. Writes are unsafe: Pi
gives the model an interrupted result instead of running them twice
(unit-tested). The record is cleared only once the module has stored the
outcome. A crash after the model finished but before the store therefore
returns the same answer again, with no new model request. A turn that cannot
be driven gets an error answer.

Killing the backend mid-answer on both surfaces resumed the turn after
restart and stored one clean answer. This live check found that Pi's aborted
partial was being replayed in front of the resent answer; the replay now
skips aborted messages. Word and tabular turns are not recorded: Word needs
its client tools to wait on durable documents (stage 4). After a restart
their runs are stopped, so they no longer run on for no one.

## The old loop is gone (stage 5, first half)

Pi is the only runtime. The Vercel AI SDK loop, its provider layer, the
local-model middleware, Mission 2's adapter compaction (`lib/compaction`) and
the raw-stream log are deleted, along with the `ai`, `@ai-sdk/*` and
`@openrouter/ai-sdk-provider` packages. Pi's own compaction applies to every
chat: it compacts above `contextWindow - 16k` and keeps about 20k recent tokens
verbatim. Chat needs `DATABASE_URL` (a direct session-mode Postgres
connection), which startup now requires.

Removing the old loop showed several behaviors that only it had. They now live
in the pi-ai wrapper or the runtime, each with a test:
- the strict-private-mode egress gate on every model request;
- first-chunk and between-chunk stall limits, reported as the provider having
  stopped responding;
- provider failures classified (a rejected key, out of credits, rate limited)
  with their HTTP status, both for turns and for titles;
- a failing tool batch (the `ask_inputs` pause) ends the turn with no further
  model request;
- configured endpoints send `max_tokens` unless they declare otherwise;
- an omitted reasoning level means off for bulk work.

Persisted tool schemas are now stored as plain JSON. Before that fix they
failed to save, so a resumed tool call would have found no tool.

## Supabase, step 1: queries go straight to Postgres

`Db` is now Mike's own client (`backend/src/lib/db/`): the slice of the
supabase-js query builder the backend uses, executed over `pg`. Not one of the
roughly 565 call sites changed. It builds SQL the way PostgREST does: rows come
back through `json_agg` (ISO timestamps, numeric bigints, jsonb objects), and
written values go in as one JSON document that Postgres coerces per column. RPCs
pick their overload by argument names. Anything outside the supported subset
fails as an error result instead of guessing. A conformance suite in the stack
tests runs every supported chain through both PostgREST and the new client and
requires identical results; the stack suites now query through it too. The only
embed (MCP tools joined to connectors) became two queries. GoTrue calls moved
off `Db` to `authAdmin()`.

Checked live with the PostgREST container stopped: projects, project
documents, library, tabular reviews, workflows, and a chat turn (create,
messages, reserved answer, title, Pi transcript) all worked, with no database
errors and the workers running. PostgREST now serves only the RLS stack tests.
Next: transactions where the code wants them (`db.transaction`), then auth
(GoTrue: password, OAuth, SAML SSO, TOTP MFA).

## Remaining limits

- Word add-in and tabular-review turns end with a restart (their runs are
  stopped, nothing is resumed). `ask_inputs` pauses and connector approvals
  are still in-memory.
- Not live-verified for lack of local keys: direct Anthropic, Google and OpenAI
  keys (the same pi-ai catalogs that OpenRouter exercised), Ollama, and
  configured endpoints (covered by tests against a local OpenAI-compatible
  server).
- `chat_messages` is still written as the UI projection, so there are two stores.
- One backend process per database: the transcript schema is held by a session
  advisory lock.
- Pi's compaction thresholds are harness-wide. A model with a context window
  under about 36k tokens (some local models) compacts badly; per-model policy
  needs an upstream setting.
- Pi retries a failed generation up to three times, so a provider that keeps
  stalling holds a turn for several stall periods before it fails.
- Entries are immutable by Pi's contract, but the table does not enforce it, and
  tasks, submissions and "latest" documents are upserted. The audit journal
  (trigger, hash chain, anchoring) is ours in every option.

## Staged plan if B is accepted

1. **Harden the seam.** All pi-ai-supported providers; message-ID lineage mapping;
   vendor the MIT Postgres adapter (1.6k lines) with its conformance suite in CI;
   cross-turn tool history on by default.
2. **Durable tools.** Server tools become self-contained Pi tools built from a
   durable turn context (user, chat, project, effective role, nonce) with replay
   policies: reads `safe`, writes `unsafe`. Re-check authority at each effect.
3. **Branching on lineages (Mission 3).** Mike chat = lineage; per-user leaf =
   conversation; edit/regenerate = fork + durable resend (pi-pocket pattern);
   **fork into new chat** = fork + new `chats` row. Frontend fixes: keep the draft
   on failed save, never re-attach a finished live turn to a reloaded branch.
4. **Pauses and client tools.** `ask_inputs`, connector approvals and Word client
   tools become tools that wait on a durable document, so they survive restarts;
   SSE from `watch`/`watchEvents` replaces the in-memory `streamRuns` registry.
5. **Remove the old loop.** Delete the AI SDK loop, its compaction and
   `streamRuns`; `chat_messages` becomes a read projection or goes.
6. **Audit journal and multi-user.** Entry-table trigger and hash chain;
   attribution in request IDs (`u:<user>:<key>`, as pi-pocket does); per-org
   schemas when one Harness is not enough.

## Risks

| Risk | Mitigation |
|---|---|
| Pi Durable is experimental; API changes between releases | Exact pins (done); upgrade deliberately behind the conformance suite |
| Postgres adapter is an alpha by one maintainer | Vendor it; it is small, MIT, and conformance-tested |
| Single owner per schema | Matches today's one-replica rule; shard per org; fail closed on lost connection |
| ESM-only packages in a CommonJS backend | Isolated in `.mts` modules loaded by dynamic `import()`; verified in the Docker image |
| Frozen memory snapshots leak private memory if a thread is later shared | Project-only memory in shareable threads, or strip on share by forking |

## Related owner questions

- **Supabase.** Orthogonal to this decision. Mike uses Supabase for GoTrue
  (password, OAuth, SAML SSO, TOTP MFA) and the PostgREST query builder (~565
  `.from()` and 65 `.rpc()` call sites); there is one RLS policy, no Supabase
  Storage and no Realtime. Pi needs only a direct `pg` connection, which works
  today. Dropping Supabase is two separate projects — replace the query builder
  (gaining real transactions) and replace or standalone GoTrue — best done after
  B has moved chat state out of PostgREST.
- **Prior art.** [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket)
  is the closest: one Harness for a multi-user web app, forks as sessions,
  attribution in request IDs, one commit coordinator feeding SSE rooms.
  [`j-koester/pi-durable-postgres`](https://github.com/j-koester/pi-durable-postgres)
  is the adapter used here.

## Local environment left by the spike

- Backend container runs the spike image with `MIKE_LLM_RUNTIME=pi`, started with a
  scratch compose override. The previous image is tagged `mike-backend:pre-pi-spike`.
  To return to the old loop: `docker compose up -d backend` (no override); to the old
  image: `docker tag mike-backend:pre-pi-spike mike-backend:local` first.
- Local database: schema `pi_durable` (spike data), throwaway database `pi_spike`,
  and the additive migrations `20261007_03` and `20261007_04` applied.
- Test chats in the owner's local account: "Pi runtime check…" (one regenerate fork,
  one edit branch without an answer).
