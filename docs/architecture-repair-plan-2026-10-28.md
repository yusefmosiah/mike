# Architecture repair plan

Date: 2026-10-28. Status: proposed execution plan awaiting independent review.
The owner authorized: commit this plan, review it with Devin and DeepSeek,
integrate justified findings, commit the reviewed plan, then delegate its
bounded implementation with the parent assistant orchestrating. Implementation
starts only after that sequence. Open decisions are not implicit authority.

## Starting receipt

- Local HEAD: `0531331fa15446705d4eb619e008c0e0f1cfa569`; working tree clean
  immediately before this documentation change.
- Read-only investigation observed staging source marker `67af87a1`.
- The owner reports that mobile backgrounding stops processing. A client
  premature-EOF defect was reproduced, but the particular incident has not been
  correlated to a server turn. Do not claim the incident's cause is proved.
- The podcast trace in conversation `509a8d5f-5b0a-4908-9250-5f8ad533913e`
  exposed incompatible transcription instructions, missing runtime dependencies,
  and undiscoverable speech packages. It ultimately built audio without ASR QA.
- No application source, remote state, or infrastructure was changed during
  the investigation or in writing this plan.

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

Separate server execution from the phone's SSE reader. In the existing reader,
EOF without `[DONE]` returns normally; `readAssistantTurn` consequently skips
reconnection and the hook finalizes locally. The server close handler only
unsubscribes the reader; it does not cancel the run.

- Correlate a controlled background/foreground scenario with server turn ID,
  execution progress, and stored result before selecting the full fix.
- Treat premature EOF as incomplete delivery, not successful completion;
  reconnect to the existing turn using the existing replay protocol.
- Preserve explicit Stop behavior. Do not resubmit the prompt or start another
  generation to repair a broken observation connection.
- Investigate pre-admission disconnects separately: a reader without a turn ID
  cannot simply resume by cursor.

Acceptance: on the actual mobile surface, background during generation and
code execution; foreground and recover the same turn/result. Also exercise
connection loss, normal completion, and explicit Stop. Prove no duplicate
user message, generation, or tool side effect. If the server itself stops,
identify that additional failure rather than declaring the reader fix complete.

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

- Resolve requested document IDs against user authorization, regardless of
  whether a thread already attached them. Preserve stable identity/version and
  citation behavior across filesystem and tool reads.
- Keep the turn's environment instructions small: stable paths, discovery,
  and callable signatures; no recency-selected bodies. Determine whether any
  additional name/path index is needed before adding one.
- Define cross-project tool search as search over the requesting user's
  authorized documents; an active project may provide a task default but not
  silently erase other authorized reach.
- Preserve the distinction between consulting another project's file and the
  existing project picker operation that moves standalone documents or copies
  documents from another project.

Acceptance: a member of A and B can find/read/cite authorized material from both
in an ordinary or project conversation. A user with only A cannot retrieve B
through tools or their VM mirror. Project invitations and membership checks
continue to work. Verify original and derived files, not only picker labels.

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

Acceptance: create a generated document, revise it at least three times, and
observe distinct increasing versions. An explicitly followed publication serves
the new versions through the same link.

New links follow by default. Normal publishing should say that saved changes
update the link, without forcing an equal-weight live-versus-frozen decision.
Keep the frozen-copy option secondary, preserve existing frozen publications,
and retain revocation/expiry behavior. Verify both modes. Do not silently
convert stored links.

## Preserve, defer, and guard against repeats

- Preserve useful queue/draft behavior, media rendering, publication management,
  layers, and docs audit unless a specific reproduced defect requires a fix.
- Existing review is not an acceptance receipt. In particular, queue failures
  before admission versus after persistence need different handling to avoid
  silent loss OR duplicate submissions. Check this alongside turn-continuity
  work rather than assuming the previous strict-throw patch solved it.
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

## Current state and next action

- Plan proposed for independent review; no implementation started.
- After review and integration, delegate bounded slices using the configured
  task model; the parent owns integration, final checks, and honest receipts.
- Main uncertainty: the specific mobile incident's server fate. Shared-chat
  redesign is deferred, not a prerequisite for the single-user repairs.
- First implementation slice after review: reproduce mobile backgrounding with
  correlated client/server turn identity, then repair existing continuity.
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
