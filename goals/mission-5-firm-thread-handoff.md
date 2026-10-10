---
definition_version: 4

readiness: drafted

finish:
  deliver: >-
    A firm-scoped thread that more than one member of an organization can carry:
    a partner starts it, an associate continues it, a third person reads or
    resumes it, with RBAC over projects, files and threads. Every turn is
    attributable to an actor and an effective role, and two people sending at
    once produce one run, not two.
  artifact: >-
    A per-chat turn claim that is enforced in the database (not only in process
    memory) and carries the actor; participant/share UX over the existing
    chat_access_grants model; actor stamping on document versions; per-turn
    audit rows; and tests that drive the handoff on two backend replicas.
  acceptance:
    - action: npm test --prefix backend -- src/modules/chat/__tests__/firmHandoff.test.ts
      proves: >-
        With two backend replicas and two actors, concurrent sends on one chat
        produce exactly one run (the second is refused with turn_in_progress or
        queued, never a second generation); after the turn ends the other actor
        can send and both actors appear on the transcript.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/chat/__tests__/firmHandoff.test.ts -- roles
      proves: >-
        A viewer cannot send or edit and receives an intentional 403; an editor
        can send; a grant added or removed takes effect on the next request
        without a restart; every generated turn writes an audit row naming the
        actor and the effective role.
      evidence_class: local_test
    - action: a Playwright run of the handoff flow in the real app (spec path to be
        named when the mission starts; do not record an unrun receipt)
      proves: >-
        Two signed-in browsers in one organization: the partner's turn, the
        associate's continuation and the third member's read are all visible
        with correct attribution in the real app.
      evidence_class: local_test

value:
  better_means: >-
    A firm's matter can be carried across people without copy-paste or account
    sharing, and the firm's audit can say who produced each answer and under
    what authority, months later.
  goodharting_would_be: >-
    A share button that grants read access while per-turn attribution, cross-
    replica single-run enforcement and role enforcement on the generation path
    stay as they are today.

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/STATUS.md
    - goals/pi-durable-recon-and-design.md
  must_preserve:
    - Existing project/org/chat grant semantics and the `can()` capability matrix.
    - Private-stack constraint: no external control plane.
    - One turn per chat; a second sender never causes a second generation.
---

# Mission 5: Firm thread handoff

Status: **drafted, not in the agenda.** Owner direction 2026-10-07: the platform must
support a firm (partner → associate → third person) with RBAC over projects and files.
This assistant-authored future draft is not original Phase 5 and is not execution
authority. Its database-claim design is a proposal to reconcile with the still-open
runtime decision, not a consequence forced by collaborative handoff alone.

Design constraints and the existing-substrate inventory are in
[`pi-durable-recon-and-design.md`](pi-durable-recon-and-design.md) §11.

## What already exists

Organizations, members and invitations; `ProjectRole` + `can()`; project grants and org
overrides; `chats.project_id`/`org_id`; `chat_access_grants` with role resolution
(`chat_access_role()`); per-message `author_user_id`; author-aware memory scoping;
actor-attributed `audit_events`; chat grant endpoints; and the **UI**: organizations,
members, invitations, project/tabular/workflow sharing, chat sharing with roles, and
per-resource access rosters (`AccessModal`, `ChatAccessModal`, `OrganizationWorkspace`,
`ChatView.tsx:1612`). See §11.1 for the file:line inventory and
[`TRIAGE.md`](TRIAGE.md) §2 for the full evidence/accounting.

## What is missing

1. **DB-fenced turn admission with an actor.** Today `startAssistantTurnRun` is an
   in-process registry (`assistantTurnRuns.ts:22-24`, `chat.routes.ts:669-675`), so the
   "one turn per chat" rule holds only on one replica. This is the same layer the
   concurrency decision in §10 needs; build it once, with `actor_user_id` on the claim.
2. **Actor stamping on document versions.** `document_versions` records `deleted_by` but
   no creator; provenance is indirect through `document_edits.chat_message_id`.
3. **A role audit of every read/write path.** Resolution exists; enforcement coverage is
   not yet verified end to end.
4. **Attribution and presence in shared threads.** The sharing UI and access roster
   exist; what is absent is per-turn attribution display ("who generated this"), a
   "who is generating now" affordance, and an honest answer to a second sender beyond
   the 409.

## Receipts (2026-10-10, assistant-run; not accepted until the owner says so)

What was built: a database turn claim (`chat_turn_claims`, `claim_chat_turn` /
`renew_chat_turn` / `release_chat_turn`, migration
`backend/migrations/20261010_01_firm_thread_handoff.sql`) taken in prepare before any
write, carrying the actor and their role, with a 90 s lease renewed every 30 s;
`document_versions.created_by` stamped at every version-creation site; `actor_role` on
`chat.message` audit rows; prompt attribution and a "who is generating" notice in the
global and project chat views, polled until the turn ends; a refused sender is told why
and nothing of the send is stored. A stored per-user leaf now resolves to the newest
message under it (`resolveLeaf`), so a colleague's continuation shows up on your branch
and your next send follows it, rather than forking from where you left off.

Deviation from the acceptance paths above: the replica tests need a real Postgres, so
they live in the gated stack suite as
`backend/src/__tests__/integration/firmHandoff.stack.test.ts`, not
`src/modules/chat/__tests__/firmHandoff.test.ts`.

- `npm run test:stack --prefix backend` printed `Test Files  11 passed (11)` /
  `Tests  72 passed (72)`, including the 7 handoff cases: concurrent senders on two
  replicas (one admitted, one 409 naming the holder, one prompt stored), viewer 403 with
  no write, grant added/removed effective on the next request, lease lapse frees a dead
  holder's thread, a restart resumes its own turn, `actor_role` on the audit row,
  `created_by` on a version.
- `E2E_API_PORT=3201 E2E_WEB_PORT=3100 npx playwright test e2e/firm-handoff.spec.ts
  e2e/branching.spec.ts --project=chromium --workers=1 --repeat-each=2` printed
  `13 passed (2.3m)`. The handoff spec: three signed-in browsers; the partner shares via
  the Share dialog (associate Editor, third Viewer); the associate sees the partner's
  prompt attributed and sends a slow turn; the partner's idle view sends meanwhile and
  is refused with the explanation; reopened, it names the associate as generating,
  then shows the associate's prompt (attributed) and answer without a reload; the third
  member sees both senders named, no composer, and no trace of the refused send.
- `npm test --prefix backend`: 4429 passed, 97 skipped, 1 failed. The failure was
  `blockIds.test.ts › aligns the 12,600-paragraph schedules quickly`, a timing test
  outside this change, which passed on its own (`Tests  6 passed (6)`).
- `npm run test:coverage --prefix frontend`: `Tests  2283 passed`, statements, functions
  and lines 100%, branches 99.94%. Lint: 0 errors (33 pre-existing warnings). Typecheck: 0.

Follow-up (2026-10-10, assistant-run): tabular review chats and cloud Word chats now
take the same database claim (`surface` `tabular` / `word`) before their in-process run,
release it when the turn ends, and answer a colleague's held claim with 409
`turn_in_progress` plus who is generating. A restarted turn claims again under its own
id. Local Word chats are not claimed, because they live in one pane. If the claim cannot
be read, the turn goes ahead, as before. Tests:
- `npx vitest run src/modules/word-chat src/__tests__/integration/wordChat.routes.test.ts src/modules/tabular`
  printed `Tests  163 passed (163)`;
- refusal tests: `tabular.turn.resume.test.ts` and `wordChat.turn.resume.test.ts`;
- backend `npm test`: 4478 passed.

Follow-up (2026-10-10, assistant-run; not accepted):
- Tabular presence: `GET /tabular-review/:id/chats` carries each chat's turn-claim
  holder (`generating`, with name and email); the review chat panel shows "<name> is
  generating a response", re-reads every 3 s while it lasts, then loads the thread.
  Test: `src/modules/tabular/__tests__/tabular.presence.test.ts`.
- Word: chats belong to one person, so presence there is the refusal. A send while
  the chat's turn runs in another window says so instead of printing the server's
  raw 409 body. Test: `frontend/src/wordAddin/streamRefusal.test.ts`.
- Stop: only the person generating can stop a turn. The composer dims and disables
  Stop for a colleague's turn, and the stop endpoint answers 403 `turn_not_yours`.
  Test: `chat.routes.test.ts` "refuses a stop from anyone but the person generating".
