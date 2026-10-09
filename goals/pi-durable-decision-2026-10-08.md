# Runtime decision: embed Pi Durable or port its patterns

Date: 2026-10-08. Branch `spike/pi-durable-embed` (on top of
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

## Spike limits (not production)

- Tools still run through the request binding, so after a restart every
  in-flight Mike tool behaves as unsafe (interrupted). Durable server tools are
  Stage 2.
- OpenCode Go models only. Per-user keys are deliberately out of scope (a
  separate gateway, per owner).
- Lineage matching uses user-message text; production should key on Mike message
  IDs ↔ entry IDs.
- `chat_messages` is still written as the UI projection, so there are two stores.
- On the Pi path Pi's own compaction applies; Mission 2's adapter compaction does
  not. If B is chosen, Mission 2 becomes the legacy path's fix and is retired with
  that path.
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
