# Architecture repair plan

Date: 2026-10-28. Status: reviewed plan (Devin and DeepSeek closure reviews
accepted the first-round integration); updated the same day with evidence from
the mobile investigation. The owner authorized: commit this plan, then delegate
its bounded implementation with the parent assistant orchestrating. Open
decisions are not implicit authority.

## Starting receipt

- Plan base: `0531331f`; the plan commit is `4f4581ee`. The timeout removal
  `4aaadb29` landed afterward and is deployed to staging (CI and deploy green;
  running frontend and source marker both `4aaadb29`).
- Owner observation, confirmed on the phone: switching apps during a turn
  produced a failed or cancelled-looking turn, for dictated and typed prompts
  alike. After `4aaadb29` was deployed the owner re-tested and reported that it
  worked. This is one passing comparison, not a proof of the whole class.
- Observed server facts. A typed turn (chat `6bd07688-8131-4c83-95aa-cbc7b572069b`)
  completed on the server (all 51 execution tasks completed, no abort request,
  7,401 answer characters stored) while the phone showed two steps and a generic
  error. Four turns in `509a8d5f-5b0a-4908-9250-5f8ad533913e` were genuinely
  aborted (`abortRequested`), with no stored reason; their initiator is
  unidentified. The stored label "Cancelled by user" is not evidence of a Stop
  press.
- The podcast trace in that conversation exposed incompatible transcription
  instructions, missing runtime dependencies, and undiscoverable speech
  packages. It ultimately built audio without ASR QA.
- Sentry is not configured; there is no client exception history to consult.
- The working tree held uncommitted edits to this plan only. No other
  application source, remote state, or infrastructure was changed by the
  investigation, except the owner-approved removal of unused container images
  on node-a (3,016 to 8 images; root disk 93% to 83%).

## Settled owner decisions

1. One installed application serves one client organization on that client's
   own infrastructure. Separate client installations are the client boundary;
   do not build a shared cross-client tenancy platform.
2. Each user has one persistent workstation VM. Coding is always part of the
   product; unavailable execution is an explicit failure, not a code-less mode.
3. Projects remain visible and retain their document-oriented interface,
   invitations, membership, and collaboration. Do not delete or feature-flag
   them as part of this repair.
4. Projects govern access between people. Do not add isolation between one
   user's projects or conversations. The user's authorized files can be
   available across conversations, including files from several projects.
5. Account-wide files remain available inside projects. Authorization still
   applies: account-wide availability does not mean every organization member
   may read every document.
6. Files should be available to Python; do not automatically inject document
   bodies into model context. Reading a requested file is different from
   preloading it unasked. An identifier/path index is not a permission system.
7. The searchable archive is an external NAS appliance, to be exposed through
   Python functions for agentic retrieval. Building the archive, ingesting it,
   mirroring it wholesale, and designing its integration are out of scope.
8. The confidential toggle was not requested. Its false promise and the
   recent-document sweep are to be removed, not expanded into a classification
   product. Preserve unrelated useful overnight work.
9. Automatic restart/resume after an incomplete answer is a recorded future
   request, not authorization to build a new retry feature now. Repair existing
   background execution/reconnection behavior first.
10. Defer shared-chat expansion, deletion, handoff, and execution-placement
    redesign. Preserve existing code and approval safeguards; it is unaccepted,
    not certified safe. Prioritize single-user chat and project/file sharing.
11. NEW publication links default to following the document (live links).
    Preserve existing frozen links. Explain live behavior plainly; keep the
    frozen-copy choice secondary rather than removing that capability.

These decisions supersede Mission 20 item 7's agent-authored confidential-flag
requirement, the linked document-scope page's proposals where they conflict,
and the subsequent proposal for per-project sandboxes. They do not authorize
changing existing project memberships or broadening other users' permissions.

## Ordered work

### 1. Repair mobile turn continuity

Separate server execution from the phone's SSE reader. The server close handler
in `streamRuns` only unsubscribes the reader; it does not cancel the run (the
older `assistantSse` path is route-specific and aborts; do not generalize).

Landed: `4aaadb29` removed the 90-second client stream-idle deadline and its
unused machinery. A silent connection no longer fails the reader. It is not a
general fix and does not repair the gaps below.

Known gaps, in the order they hurt:

- A finished run's replay buffer is retained 60 seconds
  (`FINISHED_RUN_RETENTION_MS`). After that a reconnect to a completed turn gets
  `404 turn_not_found`; the reader retries 404s for 15 seconds and then surfaces
  its original stream error although the answer is safely stored.
- A finished local turn stays attached to the mounted hook until the thread
  changes, and `overlayTurn` replaces a same-ID saved row with it, so a stale
  error can mask the saved answer on a later history load.
- No foreground reconciliation: nothing asks the server for the turn's state when
  the app returns, except an opt-in background-agents refresh.
- EOF without `[DONE]` returns normally, so `readAssistantTurn` skips
  reconnection and the hook finalizes locally.
- Abort propagation in the reconnect loop replaces a Stop that lands during a
  wait or re-attach with the earlier stream error (pinned by an existing test
  that must be revisited, not preserved as incidental behavior).
- Native voice: backgrounding ends a voice session as an interruption, and the
  web handler can turn an interrupted answer into the chat's cancellation
  callback, which sends the server an explicit Stop. The callback is not bound
  to the interrupted turn's identity. Conditional suspect for the four genuine
  aborts; unproven. Typed and dictated turns must never be stopped by it.
- The cause of the four genuine aborts is unattributed. Durable abort records
  carry no reason. Candidate sources found by reading: the explicit Stop route,
  run lifetime/idle deadlines, a tool-failure halt, Pi owner cascades, and the
  voice path above. None is linked to the incident by evidence.

Work:

- Reconcile with the server on return and on reader failure: ask the existing
  `active_turn` / messages lookup for the turn's state. Running: re-attach by
  cursor. Completed or stopped: load the saved answer. Never infer task failure
  from connection silence and never start another generation to repair a broken
  observation connection.
- Resolve a `404 turn_not_found` for a turn the transcript already holds to the
  saved answer, not to an error. A finished local overlay must yield to an
  authoritative saved row for the same message ID.
- Treat premature EOF as incomplete delivery, not successful completion;
  reconnect to the existing turn using the existing replay protocol. Require
  completion markers only for assistant-turn readers that promise them; preserve
  other consumers of the shared SSE parser that legitimately end at EOF.
- Preserve explicit Stop. Revisit the reconnect loop so Stop surfaces as Stop.
- Bind a voice interruption's cancellation to the turn it interrupted.
  Background audio interruption must not Stop a turn it did not start.
- Give durable aborts an attributable source (Stop route, deadline, tool halt)
  using the existing redacted logging helpers, so the next incident is
  explainable. This is an observer upgrade, not a new subsystem.
- Investigate pre-admission disconnects separately: a reader without a turn ID
  cannot simply resume by cursor.
- The remaining client deadlines from `5ff405f9` are not part of this repair and
  change only on evidence: the 45-second first-response race does not cancel the
  losing request, so a late acceptance can follow a reported failure; the
  30-second timeout covers every authentication request, including account
  mutations, not only the session read. Review each separately.
- Delivery contract shared with workstation errors: restore a queue entry only
  after a confirmed refusal before persistence. After admission/persistence,
  errors are terminal SSE plus a stored failed turn, not an HTTP rejection
  that invites resubmission. An ambiguous disconnect stays paused for existing
  turn/transcript reconciliation; never automatically resend an unknown outcome.
  Reuse the existing active-turn/messages lookup, not a new retry subsystem.
  Today every send error restores the entry (`useChatQueue.drain`), and a
  terminal error frame does not pause the queue (it does not advance
  `turnFailedAt`). Both are code-path findings from review, not reproduced
  incidents. Keep one authoritative in-memory queue state and persist it best
  effort; storage must not be the source for mutations.
  Acceptance includes queued pre-admission refusal, post-admission workstation
  failure, and a lost connection before the first turn-ID frame.

Acceptance: on the actual mobile surface, background during generation and
code execution; foreground and recover the same turn/result, including after the
replay window has expired (return after more than a minute). Also exercise
connection loss, normal completion, and explicit Stop. Prove no duplicate
user message, generation, or tool side effect. If the server itself stops,
identify that additional failure rather than declaring the reader fix complete.
A physical-device result is required for the mobile claim; a browser smoke is
supporting evidence only.

### 2. Make workstation capabilities real and discoverable

Retain the on-demand environment mechanism where it works. Reconcile the
actual x86-64 Linux CPU execution environment with the interpreter, packages,
model assets, skill scripts, and capability description.

- Establish one supported Python import/entry path rather than relying on
  session-specific `sys.path` patches to discover `/home/agent/pylibs`.
- Supply and exercise the compatible speech runtime/model/runner combination
  needed by the podcast workflow. Do not advertise Apple GPU/MLX execution as
  usable on the Linux CPU guest. Choose exact packages from existing working
  assets and licensing evidence, not from a new speculative model survey.
- Distinguish available now, fetchable on demand, and unavailable. A manifest
  row or downloaded model is not proof of an operational capability.
- Reconcile skill saves with filesystem copies: a saved script must either be
  available at the documented boundary or clearly reported as not refreshed.
  Do not silently execute the older copy.
- Preserve one VM assignment per user. Remove silent tool-less continuation
  on assignment/configuration failures; report provisioning/capacity problems
  intentionally. No new VM-per-project scheme or automatic capacity platform.
- Apply explicit provisioning failure to execution that requires the account
  workstation, not deliberate guest approval waits or orphaned-host
  restrictions. An approved guest whose turn needs a host that failed to
  provision follows section 1's terminal-SSE contract. Preserve guest gating
  without granting execution or turning the existing wait into a new hard
  failure.
  Preserve non-production local-kernel configuration for development/tests.
  Leave nullable workstation resolution for non-generation callers such as
  vault lookup intact. History, document, and publication reads must still work
  while provisioning is unavailable. Surface failures at the phase described
  in section 1; do not introduce post-persistence HTTP refusal.
- The supported entry point is the actual persistent kernel's Python, with
  subprocess instructions using its compatible interpreter/environment.
  Record runtime versions, model identity/checksum, and license with the
  capability. A layer-specific interpreter must not masquerade as kernel state.
  Exercise discovery in a real agent turn, not only a shell import demo.
- Use local/disposable development resources for new VM acceptance. Node-a VM
  rebuilds, package installation, and guest mutation remain owner-gated; if a
  required device/VM is unavailable, report that verification boundary rather
  than substituting a mocked success.

Acceptance: a fresh representative user VM, not just the manually repaired
owner VM, runs synthesis and a real transcription round trip using documented
entry points. Package imports work from the actual persistent kernel. Check
skill update visibility and a genuine unavailable-workstation path. No skipped
ASR step counted as success.

### 3. Remove the unrequested confidentiality feature and prompt sweep

- Remove the composer row, row actions/labels, upload option, API client and
  PATCH surface, flag-specific publication refusals, and obsolete contracts.
- Remove automatic recent-document inclusion. Preserve explicit references,
  citations, generated-document continuity, and normal document authorization.
- Before dropping stored classification data, inventory flagged rows through
  an authorized read-only query and let the owner decide their disposition.
  Do not print client file contents or identifiers into public artifacts.
- Use a NEW forward migration for shipped schema changes. Never delete or
  rewrite the shipped confidential migrations or falsify the migration ledger.
  Remove the obsolete sweep index with the final schema change.
  Update `search_library_documents`'s returned row shape and every publication
  projection of `confidential` in the same cutover. Code must stop depending on
  the column before a destructive migration is applied. Recheck flags just
  before application; the read-only 2026-10-28 staging count was zero, not an
  enduring disposition or migration authority. A guard must refuse deletion
  if flagged rows now exist without owner-approved disposition/recovery.
- Correct docs, tests, and the misleading 'stays in this chat' promise. Do not
  replace the feature with another per-file switch.

Acceptance: composer regains its space on mobile; no confidentiality controls
remain. A file never attached in the current thread can be reached through
its authorized filesystem path. An unasked-for document body is not preloaded.
Explicit references and citations still work. Existing publications are not
silently revoked or changed by the removal.

### 4. Align document tools with the account's authorized file access

The filesystem and document tools currently disagree: the mirror includes
readable projects/library/templates, while tools rely on an assembled per-chat
store. Remove that reachability mismatch without making every file prompt text.

- Account-wide expansion applies only in private owner execution. Resolve IDs
  using the ACTING SENDER's authorization on every lazy load, never the chat
  starter's authority. Shared/project-audience/guest turns keep their existing
  referenced/project document scope and authorization checks; do not enable
  account-wide listing, search, or reads there. This is preservation of the
  shared boundary, not a new shared-chat design.
- Preserve stable document/version identity and citation behavior across file
  and tool reads. Reuse the existing mirror inventory/manifest where practical
  for path-to-ID discovery; choose and document that mapping before coding
  resolution. No second index of document bodies and no NAS scope.
- Keep environment instructions small: stable paths, discovery and callable
  signatures, not recency-selected bodies. In private execution, search covers
  the actor's authorized projects/library; the active project is a task default,
  not an additional user-level permission boundary.
- Preserve the distinction between consulting another project's file and the
  existing project picker operation that moves standalone documents or copies
  documents from another project.

Acceptance: in private owner execution, a member of A and B can find/read/cite
authorized material from both, and original and derived files resolve, not only
picker labels. A user with only A cannot retrieve B through
tools or the mirror. In shared/project-audience/guest turns, an unattached
host-private OR sender-private document must not become newly listable,
searchable, readable, or citable through this change. Preserve project-scope
reads, explicit authorized references, invitations and membership checks.
Guest VM access already granted by the existing design remains an acknowledged
deferred risk; this repair must not broaden it.

### 5. Shelve shared-chat redesign; preserve existing safeguards

Current approved guests execute in the chat starter's VM. Separate conversation
kernels do not prevent access to the host's unrelated home files, snapshots,
processes, or temporary state. This remains an unresolved risk.

Do not delete shared chat, expand it, migrate guest execution to another VM,
copy private files between users, or implement conversation handoff in this
repair. Preserve existing approvals and memberships. Project document sharing
is still in scope; shared execution redesign is not.

Before enabling shared-chat execution for a client installation, settle its
access/disclosure contract and verify it, or make that execution path unavailable
under separately agreed authority. Deferral is not a claim that it is safe.
Any repairs elsewhere must preserve the current shared-audience fences and
must not silently expose account-wide files to guests or shared transcripts.

### 6. Repair document-version creation; keep live links as the default

The linked context reports that repeated revisions of generated documents
collide because version-number allocation omits `source = 'generated'`.
Verify the function and reproduce this independently before patching it.
Verified source mechanism: the latest RPC locks the document row `for update`,
then computes max only over upload/user_upload/assistant_edit; generated
replacements pass a null version number. Prefer source-independent numbering
over extending a brittle source list, after checking all source semantics.
Preserve the lock, explicit numbering, idempotent same-version behavior,
grants and hardening. Use the complete current function in a new migration.

Acceptance: reproduce through `save_to_mike` replacement (not only
`edit_document`), revise a generated document at least three times, and observe
distinct increasing versions. Exercise two concurrent replacements and mixed
source history. An explicitly followed publication serves updated contents
through the same link. Server and UI already default to following; preserve
that behavior rather than rebuilding it.

New links follow by default. Normal publishing should say that saved changes
update the link, without forcing an equal-weight live-versus-frozen decision.
Keep the frozen-copy option secondary, preserve existing frozen publications,
and retain revocation/expiry behavior. Verify both modes. Do not silently
convert stored links.

### 7. Composer and queue behavior

Owner-reported, in scope:

- Queued messages must not show the model name. Model and effort stay in the
  entry because they decide the eventual send; this is display only. Show only
  what helps the owner recognise the entry, such as its text and attachment
  count, in the existing queue strip.
- Dictation must work while a response is running, queuing the dictated message
  as typing does. Today the dictation hook is created disabled while a response
  runs and the microphone button is disabled. Finishing a dictation must use the
  existing queue path and must never press Stop. Hands-free voice mode stays
  unavailable while a response is running.
- The Home screen composer must not restore a message after it was sent and
  created a thread (owner-reported). Suspected mechanism, not yet reproduced:
  sending clears React state, but the persisted draft is cleared only by a
  later effect, and navigation may unmount the composer first. Reproduce before
  fixing. The fix clears the stored draft when the message is handed off, and
  only then; an unsent or refused message must still be kept. Separately, the
  project composer remounts when a new chat gains its id and the text stays
  stored under the old key (a code-path finding); carry the draft across that
  key change.
- Remove queue metadata nothing consumes (`stampedAt`, pause time, the
  `sending` status) only if the slice is already editing those files; do not
  make that cleanup a goal.

Acceptance: with a response running, dictate a message and see it queued and
sent when the response ends, without Stop. A queued entry shows no model name.
Send from Home, create the thread, return Home: the composer is empty. Type,
leave without sending, return: the text is restored. A refused send (no model,
rejected key) keeps its text. Verify on the phone.

## Preserve, defer, and guard against repeats

- Preserve useful queue/draft behavior, media rendering, publication management,
  layers, and docs audit unless a specific reproduced defect requires a fix.
- Existing review is not an acceptance receipt. In particular, queue failures
  before admission versus after persistence need different handling to avoid
  silent loss OR duplicate submissions; section 1 owns that contract and
  section 7 owns the composer behavior that sits on top of it.
- Do not add automatic restart loops, project encryption/sandboxes, project
  hiding flags, a new classification scheme, or NAS features in this repair.
- Membership revocation can stop future authorized retrieval and clean managed
  mirrors. It cannot honestly promise erasure of copies, kernel variables, or
  outputs a user already acquired. Document this boundary; do not invent secure
  deletion guarantees.
- Land small, behavior-named changes. Do not sweep concurrent agent work into
  a coverage/test commit or treat a reviewer suggestion as owner authorization.

## Evidence and execution rules

For each implementation slice: establish the failure, update the affected
producer/consumer contracts and docs, exercise the real path, then run the
relevant repository checks. Access-control/schema/shared-execution changes need
independent security review, not just unit-test counts. Preserve unrelated work.

Production/client migrations and node-a configuration changes require explicit
authority and a confirmed target. Follow the repository's CI/staging process
when implementation is authorized; distinguish deployment from product-path
acceptance. Plan rollback before landing each slice. For data removal, preserve
a recovery export before applying the forward migration; never restore a
misleading privacy promise as an emergency fallback.

## Delegation and landing contracts

Independent slices: A continuity/queue delivery, B workstation/runtime/skills,
C confidentiality UI/API removal, D private document resolution + sweep removal,
E generated-version allocation + secondary publication UI, F composer and queue
behavior (section 7). A and F both edit `useChatQueue.ts`, `chatQueue.ts` and
`ChatInput.tsx`, so one agent owns both and does them in that order; F's
acceptance is separate. C and D land together after account-resolution and
shared-scope checks; do not ship an intermediate tool-discovery regression. E
may proceed independently.

Parent owns final integration and all canonical commits. Agents do not commit,
push, migrate remote databases, deploy, or run builds/lint/tests/formatters
mid-flight. They may perform safe throwaway reproduction/smoke probes, preserve
consumer-visible regression tests, and return exact verification commands.
Parent runs the combined checks once the mutation wave is finished.

Shared files have one named owner: D owns `contextBuilders.ts` and
`toolDispatcher.ts`; B owns `streaming.ts` integration; C sends flag-removal
requirements to those owners. C owns confidentiality SQL removal, E owns
version SQL; parent reserves distinct migration sequences before either writes.
Use existing typed boundaries; reviewer-suggested `ConversationAudience`,
`DocumentRef`, or `WorkstationAvailability` frameworks are not requirements.

No push that auto-deploys a destructive migration until target, latest flag
inventory, recovery/disposition and deployment authority are reconciled.
Available local implementation and verification continue without that authority.

## Current state and next action

- Wave One landed, passed full CI (`40772094437`), and deployed to staging
  (`40772688814`; `/var/lib/mike-staging/src/.git-sha` and `NEXT_PUBLIC_GIT_SHA`
  both `efa529ce`; `20261028_01_generated_version_numbering.sql` applied):
  - `fa35ccbe` (Slice F): queue dictation while a response runs without Stop,
    clear sent Home drafts at handoff and adopt new-chat drafts when a chat
    gains its ID, and hide model/effort labels on queued entries.
  - `17d77029` (Slice A): reconnect on premature EOF for named turns, preserve
    Stop across reconnect backoff/re-attach, resolve `404 turn_not_found` to the
    saved answer in chat history, yield finished local error overlays to saved
    rows, reconcile on foreground return, keep queue mutations in memory and
    restore only pre-admission refusals (`TurnRefusedError`), bind voice
    interruption cancellation to the active voice turn while ignoring background
    audio interruptions, and record `stop_reason` / tool-halt attribution.
  - `32d0f3a0` (Slice E): allocate generated-document revision numbers across
    all existing versions of the document (`20261028_01_generated_version_numbering.sql`)
    and keep frozen-copy publishing secondary to automatic updates.
  - `efa529ce` (Slice B repo-side): put `~/pylibs` on the persistent kernel's
    `PYTHONPATH`, refresh `~/skills` when a skill is saved or installed (or
    report when refresh fails), and surface workstation provisioning/capacity
    failures as terminal SSE errors rather than continuing silently without tools.
- Next wave: C+D (remove unrequested confidentiality controls/API and prompt
  sweep; align private-owner document tools with the account's authorized file
  access while preserving shared/project-audience fences). Staging's current
  `documents.confidential = true` count is `0`; destructive schema removal of
  `documents.confidential` remains gated on owner confirmation before push.
- No whole-stack revert. No hidden expansion of this plan into new features.

## Investigation references

- `backend/src/lib/codemode/kernel/manager.ts`: per-conversation kernels,
  snapshot paths, restore, idle lifetime.
- `backend/src/lib/codemode/kernel/bundle.ts`: starts in the VM user's home.
- `backend/src/modules/workspace/workspace.view.ts` and `workspace.sync.ts`:
  authorized account-wide mirror.
- `backend/src/modules/chat/engine/streaming.ts:628-687`: workstation selection,
  guests, conditional code capability; first-cell sync later in the same file.
- `backend/src/lib/workstation/assignments.ts` and `config.ts`: assignment and
  null/failure paths; `capabilities.ts`: static environment description.
- `frontend/src/app/lib/sse.ts:108-166` and
  `assistantTurnStream.ts:1703-1729`: normal EOF and error-only reconnection.
- `backend/src/lib/streamRuns.ts:416-435`: reader close detaches, not cancels.
- `frontend/src/app/components/modals/AddDocumentsModal.tsx:224-258`: project
  assignment versus selection semantics.
- Published owner-supplied context:
  <https://guitarra-3407-akane-4004-wonton-727-2195-sombrilla.choir.chat>.
  Its historical allegations and proposed fixes are evidence/leads, not
  authority overriding the settled decisions in this plan.
