# Recovery drill and operator runbook

Agentic-consensus convergent verdict, 2026-10-07 (5–4 for B over A).
Panel outputs: `.agentic-consensus/agentic-consensus-20261007-convergent/`.

## The drill

Run against the compose stack with a synthetic matter. No builder help.
One operator, one page of notes, one stopwatch.

1. Start a chat turn on an attested lane (or any lane), plus one project
   chat turn and one Word turn if those surfaces are in scope.
2. Mid-stream, `kill -9` the backend process (not SIGTERM — the drill is
   the worst case, not the graceful one).
3. Restart the backend. Reopen each chat.
4. Check, per turn:
   - Conversation tree resumes at the pre-kill leaf; branch controls
     (edit, regenerate, navigator) render once history loads.
   - `audit_events` holds the turn's rows. Completed and cancelled turns
     drain attested receipts into `inference.attested` rows (content-free:
     receipt id, endpoint, measurement, verifier version, request id).
   - The known loss window: a turn killed between attestation verification
     and its turn-audit enqueue leaves its receipts in the process-local
     ring, which dies with the process. `drainReceiptsSince` documents this:
     unknown cursors drain everything (widen, never narrow), but nothing
     can drain a dead process's memory.
5. Check the queue: `db_jobs` rows the killed worker had claimed return to
   pending via the claim-timeout path and are recovered by another worker.
6. Record every step that needed the builder. Each one is a runbook gap.

Pass criterion: the operator restores service, identifies what persisted
and what was lost, and names the loss window above without prompting.

## What survives a restart (by design)

- Chat history, branches, leaves: Postgres (`chat_messages`, leaf state).
- Attested receipts for completed/cancelled turns: `audit_events`
  (`action = 'inference.attested'`), via the DB-queue fan-out with retries.
- Queued work: `db_jobs` claim recovery.
- In-flight stream text, the process-local receipt ring, turn SSE state:
  gone. The client replays from the server's stored rows on reload.

## Operator runbook (single node)

- Start: `docker compose up -d`. Verify: backend health endpoint, then one
  scripted chat turn end to end.
- Stop (planned): stop the backend first, let in-flight turns finish or
  cancel; nothing special is needed for receipts — completed turns already
  drained at their audit point.
- Crash: restart the backend, run the drill's step 4. If `audit_events`
  lacks a turn's rows, check `db_jobs` for a stuck `audit.chat_turn` row
  before assuming loss (at-least-once retries cover transient DB errors).
- Upgrade: back up Postgres first. Migrations in `backend/migrations/`
  replay in filename order; `docker-compose.yml` mounts each one.
- Strict private mode: `STRICT_PRIVATE_MODE=true` refuses to boot with
  hosted keys present or without `SENTRY_DISABLED=true`. Attested lanes
  require a pinned `expectedMeasurement`; a measurement rotation is a
  config edit plus restart, and the mismatch fails closed (loud, at
  request time — that is the rotation alarm until a scheduled check lands).

## Re-drill triggers

After retrieval-to-chat wiring lands (new turn-pipeline behavior), after
any attestation or queue change, and before any live pilot. Keep the
procedure feature-agnostic so it stays cheap.
