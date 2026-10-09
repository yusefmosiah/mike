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
