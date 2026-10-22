# Scoped memory

Mike can maintain one private Markdown file named `memory.md` for a user and
one shared Markdown file for each project. Memory is optional, inspectable, and
editable. It is reference context for later conversations; it is not a source
of authorization, instructions, or citations.

Memory has two separate paths:

- **Use during chat:** before generating an answer, Mike loads the enabled
  memory files that are safe for that conversation and supplies them to the
  chat model as lower-authority reference context.
- **Changing it:** the assistant changes memory with the `edit_memory` tool,
  either during a chat when the person asks it to remember, correct or forget
  something, or after the chat has gone quiet, when it reviews the
  conversation in the background and keeps what is worth keeping.

The background review is one more turn of the same conversation, run on a fork
of it, so it reuses the provider's prompt cache of everything the conversation
already sent. It adds nothing to the conversation, and a failed or slow review
cannot delay an answer.

## End-to-end lifecycle

1. **A turn starts.** The backend creates a durable activity lease before the
   live model runs. This prevents a curator for an older turn from committing
   while someone is still talking in the same conversation.
2. **Relevant memory is loaded.** Private conversations may receive the active
   user's app memory. Project conversations may also receive project memory.
   Shared-audience conversations never receive private app memory.
3. **Memory is fenced as data.** The files are placed in the earliest synthetic
   user message, inside delimiters the body cannot forge, and accompanied by a
   system policy that says memory is untrusted reference material. The
   delimiter is derived from the fenced text, so the turn stays byte-identical
   while memory is unchanged and provider prompt caches keep working. Current chat input
   outranks project memory, and project memory outranks app memory.
4. **The answer is persisted.** Curation is considered only after a terminal
   assistant response has been saved successfully. Cancelled responses,
   failures, and unanswered `ask_inputs` pauses release their lease without
   becoming a new learning checkpoint.
5. **A quiet window begins.** The successful turn advances a durable cursor and
   schedules a review for when the conversation has had no new activity for
   two minutes by default. More activity restarts the conversation-wide window.
6. **The job revalidates everything.** At execution time it checks that the
   job is still current, the conversation is quiet, the actor can still access
   it, each scope is still enabled, and no disable/delete epoch has superseded
   the job.
7. **The assistant reviews the conversation.** One review turn, on a fork of
   the conversation at its latest answer, covers both scopes the conversation
   may change (app memory in the person's own private conversation, project
   memory with `content.edit`). It is told which files it may change and their
   current text.
8. **It edits with `edit_memory`, or not at all.** Each edit is a targeted
   replacement, written as the curator; a review that finds nothing worth
   keeping makes no edit.
9. **The write is committed safely.** The server validates size and content,
   then uses revision, epoch, conversation generation, and the quiet window to
   prevent stale or post-deletion writes. An edit that loses a race with
   another write is applied again to the newer text.
10. **The UI reflects status.** While a job is scheduled or processing, the
    memory editor polls its status. A final failure leaves existing memory
    unchanged and shows a dismissible warning only on the relevant memory
    surface.

## Scope and permissions

- App memory belongs to one user. Only that user can read, edit, enable,
  disable, or wipe it.
- Project memory belongs to the project. Members with `project.view` can read
  it, members with `content.edit` can edit it, and members with
  `access.manage` can enable or destructively disable it.
- Both scopes are on by default: a new account's app memory is enabled when
  the account is created, and a new project's shared memory is enabled unless
  its creator clears the toggle. Turning either off clears the file but keeps
  its version history — see "Disable, wipe, and deletion".
- A user's own standalone main chats and durable Word add-in chats may update
  app memory. Chats and tabular reviews in a private personal project may
  update both app and project memory. A conversation is private only while it
  belongs to the actor, has no organization, and has no direct access grants;
  a project is private only while it has no organization and no project
  access grants. The same three tests gate whether app memory is shown to the
  model, so a conversation that cannot see private memory can never write it.
- Organization projects and personal projects with any access grant may update
  project memory only. Their conversations never update a participant's app
  memory.
- A project curator runs separately and never receives app memory. This
  prevents private app context from being copied into project memory.
- When facts conflict, the current conversation wins over project memory, and
  project memory wins over app memory.
- Shared-audience model calls never receive a participant's private app memory.
  Project conversations may receive the project's shared memory only. This is
  a data boundary rather than a prompt-only confidentiality instruction.

The live model receives enabled memory in an earliest synthetic user message,
delimited as untrusted data. A system policy states that memory cannot grant
permissions, change policy, or trigger tools by itself.

## User experience and controls

- **Settings > Memory** contains the app-memory toggle and its `memory.md`
  editor. The file saves automatically after the user stops typing; there are
  no Save or Cancel buttons. Turning memory off requires confirmation and
  clears the file while cancelling pending and future updates; earlier
  versions stay in its history. **Version history** lists every saved version
  with who or what made it, shows each as changes from the one before or as
  full text, and restores an earlier one.
- The same settings page contains the default applied when that user creates a
  project. New projects default to memory on, but the creator can change the
  value during project creation.
- **Project Memory** is a normal-size modal available from a project and from
  the project assistant chat menu. It contains the project-memory toggle,
  current file, automatic-save state, curation activity, conflicts, and
  failures, and a History view of its versions. Viewers can read the file and
  its history, editors can edit and restore, and only owners can change the
  enabled setting.
- **In a chat**, the assistant can change memory itself with the `edit_memory`
  tool when the person asks it to remember, correct or forget something. Each
  change shows in the answer as a blue "Memory updated" row with the
  assistant's one-line summary; it opens that file's version history at the
  version the change made, where the person can compare and restore.
- **Settings > Privacy & Data** can export the app file plus every project file
  the user can still view, with their versions, as a ZIP. Its Delete Memory
  action clears app memory and memories for private projects created by that
  user, and deletes their version history, while leaving memory
  enabled so future eligible conversations can rebuild it. It does not erase
  organization or otherwise shared project memory.

## How memory is learned

Memory maintenance is deliberately outside the live response path. After a
terminal assistant response has been saved successfully, the backend schedules
a review for two minutes after the most recent completed turn. Each new
completed turn restarts that quiet window for every actor with unprocessed
work in the conversation. Superseded jobs exit before invoking a model.

Scheduling state is kept per conversation and actor, while the quiet gate is
conversation-wide. If several chats become quiet around the same time, their
reviews may run concurrently. Writes to the same app or project file are still
serialized by compare-and-swap.

### The review turn

The review (`modules/memory/memory.curator.ts`) is a turn of the conversation
itself rather than a separate model call over a transcript. It forks the
conversation at its latest answer (`reviewMemory` in `lib/llm`), so the request
repeats the conversation's own model, instructions, tools and messages, and
the provider serves that prefix from its cache. The fork is never shown and
the conversation does not see it: the next turn continues from the
conversation's own last answer. The fork asks the provider for the parent's
cache session but keeps its own request keys (`providerSessionId` in
`lib/llm/pi/providers.mts`).

The fork answers an application message, marked as such, that asks it to
review the conversation for anything worth keeping, gives the scope policies
and the current text of each file it may change (and, for app memory, the
saved profile values to keep out of it), and asks for one closing sentence. It
may call only `edit_memory`; every other tool of the conversation answers that
it is unavailable. Its edits are written with source `curator` and the job's
fences, so a conversation that resumes (`memory_conversation_not_quiet`) stops
the review and defers the job, and a reset file drops out of it.

The review runs on the conversation's own model, which is what keeps its
prefix cached. Only when that model is no longer available to the person does
it run on the model their next turn would use, without the cache. Strict
private mode refuses a hosted model before anything is sent.

What the review can see is what the conversation's model saw: the person's
messages, the answers, and tool results. The scope policies tell it to keep
only what the person stated or confirmed, never credentials or other secrets,
short-lived tasks, unsupported sensitive inferences, or material copied from
documents, web pages or tool results that the person did not endorse, and
never the person's profile facts. In a private project conversation the
context includes the person's app memory, so the project policy also tells it
to keep personal preferences out of project memory.

### Compaction

A long conversation is compacted: older messages are replaced by a summary.
Each person's reviews of a conversation record how far they have looked (a
`mike.memory-reviewed` document in the conversation store). When a review
finds compactions since then, it first forks just before each of them (the
latest two at most), so the detail a summary is about to drop is looked at
once while it is still verbatim, and then at the latest answer.

### The learning cutoff

Turning memory on, or wiping it, sets the file's learning cutoff: nothing said
before that moment may be learned. A review may change a file only when
nothing from before its cutoff is still in the context verbatim. In a
conversation that began before the cutoff, that file is skipped until a
compaction has summarized the earlier part away. The compaction summary
itself can still carry earlier facts; that is a known limit of this rule.

### What is reviewed

Error and cancelled turns, `ask_inputs` pauses, local-only Word chats, title
generation, and extraction calls never schedule a review, and nothing is
backfilled. App memory is reviewed only from the actor's own private
conversation and never from a shared project. Project memory may be reviewed
from any project member's conversation in that project, by that member. App
eligibility is decided again when the review runs, and `write_memory_file`
re-checks it under the conversation's lock.

A conversation the conversation store has no record of (one older than it)
has nothing to fork, and its review records no change.

## Persistence and concurrency

Each memory file is one `memory_files` row that carries the canonical UTF-8
Markdown body itself, alongside its SHA-256, size, settings, provenance, job
receipts, and scheduling fences. An editor save and a curator update both
replace the body in place; `revision` is a monotonic change token for
compare-and-swap. Content is normalized to LF, raw executable HTML and unsafe
control characters are rejected, and a file may contain at most 16 KiB.

### Versions

Every write also records a row in `memory_file_versions`, inside the same
transaction (`record_memory_file_version`, called by `write_memory_file` and
`wipe_memory_file`). A version keeps the body, its hash and size, the source
(`manual`, `curator`, `restore`, `assistant`, `settings`, `wipe`), who made
it, the chat it came from, and for a curator or assistant update its change
summary.

Editor autosaves are coalesced: a manual save by the same person that directly
follows their own manual version (the version's revision is the one before)
within ten minutes updates that version instead of adding one, so a typing
session is one version rather than dozens. Any other write starts a new
version. Each file keeps its newest 200 versions.

Restoring writes the old body as a new version (source `restore`, summary
"Restored version N") through the same compare-and-swap, so nothing is
rewritten and a restore made against a stale revision is refused. Turning
memory off records an empty version and keeps the history; Delete Memory in
Privacy & Data, account deletion, and project deletion remove it. Users read
versions through `GET /user/memory/versions`, `GET .../versions/:id`, and
`POST .../versions/:id/restore` (and the same under `/projects/:id/memory`,
where reading needs `project.view` and restoring needs `content.edit`).

Manual and curator writes use compare-and-swap. `write_memory_file` takes the
file's row lock, re-checks the expected revision and epoch, and updates the
body in the same statement that advances the revision. A body whose hash
matches the current one is not written at all, and a retried curator job is
recognised by its job id and applied once. An `edit_memory` edit, from a chat
or a review, that loses that race is applied once more to the newer text, and
otherwise fails with a reason the model can act on.

### The assistant's edits

`edit_memory` (`modules/memory/memory.assistant.ts`) takes a scope (`app` or
`project`), a list of exact replacements (`old_text` matching one place, or
empty to append) and a summary. It applies them to the file as it is now and
writes through `write_memory_file` with source `assistant`, retrying once
against newer text if another write won the race. The tool is offered only
when the conversation may change some memory — the same scopes the curator
may write for it: app memory in the person's own private conversation, and a
project's memory when they hold `content.edit` there. A delegated subagent
cannot call it. Under its locks, `write_memory_file` requires the source
conversation for this source, takes the same conversation lock the curator
does, and refuses app memory unless the conversation is the person's own and
private, and project memory unless the conversation is in that project. Each
change streams and persists a `memory_updated` event in the answer.

## Disable, wipe, and deletion

Disabling memory fences queued and in-flight work, empties the body under the
file's row lock, records the empty version, and advances both the epoch and
the learning cutoff. Earlier versions stay in the history and can be restored
once memory is on again. Re-enabling starts with a blank file and learns only
from later completed turns.

Clearing a file in its editor saves an empty Markdown body without disabling
memory. The Privacy & Data bulk-delete action purges eligible private files and
their version history while preserving their enabled setting, so future conversations may
recreate them. Account deletion purges the user's app memory. Project deletion
purges that project's shared memory; deleting a contributor does not delete
project memory.

Erasure is immediate and transactional: the same UPDATE that empties the body
bumps the epoch, so a curator job that read the old content can no longer
commit. No object store is involved, so nothing survives the transaction that
would need a cleanup job to reclaim.

## Operations

Production deployments must leave `DB_JOBS_ENABLED` enabled; setting it to
`false` disables automatic review, though editing a memory file by hand keeps
working because a save is a single database write.

Reviews (`memory.consolidate` jobs) run in the API process, whatever
`WORKERS_MODE` says: they fork a conversation in the conversation store, and
that store has one owner, the process serving chat turns. The API process runs
a job runner that claims only that kind, and every other runner (the worker
thread, a standalone worker process) claims every kind but it. The job is not
handed to Redis delivery; the API runner's poll picks it up. A review that
reaches a process that does not own the store is deferred.

Configuration:

- `MEMORY_INACTIVITY_SECONDS` controls the quiet window and defaults to `120`.
  Local test environments may explicitly lower it to `10` for faster feedback.
- `MEMORY_ACTIVE_LEASE_SECONDS` bounds crash recovery for an active response
  and defaults to `1800` (values are clamped to 60–14400 seconds).
- There is no separate model setting for reviews: a review runs on the
  conversation's own model.

Operational logs contain sanitized identifiers and outcomes only. Queue
payloads contain IDs and cursors, not transcripts, credentials, or memory
content. Account exports include the applicable current memory body and, under
`versions/`, each earlier version.

New accounts start with app memory enabled. Existing accounts are opted out by
the upgrade migration. Existing projects receive an enabled project file;
newly created projects use the creator's project-memory default or the explicit
choice made in the creation modal. No historical conversation is backfilled.

## Launch checklist

Before enabling memory in production, run the lowest-level automated and
integration suites plus an evaluation set of synthetic conversations. Treat
the following as launch gates, not assumed properties:

- retention precision is acceptable on durable and transient examples;
- credential, API-key, privileged-data, and unsupported-sensitive-inference
  cases produce no critical secret-storage failures;
- app-only facts are not copied into project memory;
- outsider, viewer, editor, and owner API permissions match the scope model;
- concurrent manual, curator, disable, wipe, account-delete, and
  project-delete races do not lose updates or resurrect erased content;
- 95% of eligible jobs settle within two minutes after the quiet window and
  99% within ten minutes; and
- live-chat latency shows no material regression.

Use synthetic data for this evaluation and verify storage deletion directly as
described in [Safe local testing](safe-local-testing.md).
