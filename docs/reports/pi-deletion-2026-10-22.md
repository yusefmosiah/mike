# Deleting Pi conversations: investigation (2026-10-22)

What it would take for Mike to delete the content Pi Durable stores for a
chat, and what retention controls deletion needs. Paths are relative to the
repository root; line numbers are as of commit `d8a1c67f`. Items marked
**[Verified]** were read in code or docs at the cited line, or tested;
items marked **[Inference]** were read but not run.

**Update after this investigation:** the document-revision finding below was
confirmed on Postgres (`backend/src/durable/spike/retireDoc.test.mts`), and
`deleteChatAgentsOnPi` now retires a deleted chat's subagent records instead
of blanking them, which drops their revisions. Everything else stands as
written.

## Summary

- Deleting a chat, project or account removes Mike's relational rows but leaves its Pi content in place. The surviving data is the whole transcript: prompts, answers, tool results, compaction summaries and system prompts. It also includes the subagent tasks and reports, any memory-review forks, and the per-chat bookkeeping documents. The UI says "permanently delete" (`frontend/src/app/(pages)/settings/privacy-data/page.tsx:53-55`; account: `settings/page.tsx:385-386,406`). **That claim is currently untrue for Pi data.**
- A second gap exists even for content Mike already tries to scrub. Every `mike.*` session document is declared `checkpointWhen: () => false` (`backend/src/lib/llm/pi/runtime.mts:126,147,173,674,697,980,994,2690`). With that policy Pi never rewrites the base, so every old delta stays in `pi_durable.document_revisions`. `deleteChatAgentsOnPi` (runtime.mts:1551) therefore blanks the *current* value of the subagent records but not their history. The same applies to the `mike.turns` document, which holds `userId` and `userEmail` for every turn ever run. **[Verified by test; the subagent records are now retired instead, see the update above. `mike.turns` and the other singletons still keep their deltas.]**
- Real deletion of a conversation can only happen offline today. Upstream's `deleteConversation` takes the same advisory lock the live Harness holds for its whole life. It refuses to run while any storage owns the schema. The backend must be one process per database (`docs/deployment.md:209-213`).
- Recommended first step: **(1)** make the `mike.*` documents checkpoint periodically, so old deltas fall away, and use `tx.retireDoc` for per-chat family documents. This is live, supported, S-M effort, and closes the retention hole that already exists. **(2)** In parallel, add a `chats`-side tombstone and a retention-policy table (no behavior change yet). **(3)** Then build an offline purge that runs at boot before the Harness opens. Defer live deletion and crypto-shredding until upstream offers support or a regulator asks.
- Regulatory and legal-hold needs argue for a **delay-and-hold** design. Delete the UI rows now and mark the Pi content tombstoned. Purge it after a configurable grace period. A legal hold, or a deployment setting "retain", skips the purge. Nothing like legal hold or retention exists in the code today, and organizations have no settings column (`backend/schema.sql:314-320`).

---

## 1. Inventory: where a chat's content lives, and what deletion does today

### 1a. Pi (`pi_durable` schema)

Tables **[Verified]** in `backend/src/lib/llm/pi/postgres/migrations.mts:31-92`: `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`. Records are JSON-encoded `text` (migrations.mts:19-22), parsed client-side. `storage.mts` has no server-side JSON queries (grep for `jsonb` and `->>` is empty). The only identifying relational columns are ids, `owner_conversation_id`, `owner_task_id`, and the document address columns.

| Pi artifact | Produced by | Holds | Removed by chat/project/account deletion? |
|---|---|---|---|
| Chat conversation(s), `entries` | `conversationFor` roots and forks, runtime.mts:2046-2118; per-turn `conversationForTurn` | Prompts, answers, tool calls and results, thinking, compaction summaries (`pi.compaction` entries; "older entries stay in storage", Pi README "Compaction") | **No** |
| Forks of a chat's own conversations | edit/regenerate (`conversationFor`), `forkChatLineageOnPi` (runtime.mts:2655) | A fork *shares its ancestors' entries* by reading through `parent` up to `parent.at` (storage.mts:348-350, 376-378, 441-444) | **No** |
| Memory-review forks | `reviewMemoryOnPi` (runtime.mts:2784,2801) | Ownerless fork of the chat conversation plus the review prompt and the model's tool calls. **Not recorded in any Mike document**, so findable only by the `parent` edge. | **No** |
| Foreground subagent conversations | `createConversation({ownership:{kind:"task"}})`, runtime.mts:798 | Task text, tool results, report | **No** (owned by a task, `owner_task_id`) |
| Background subagent conversations | runtime.mts:1113 (ownerless) | Same | **No.** `deleteChatAgentsOnPi` stops them and retires their `mike.subagent` and `mike.chat-agents` records, revisions included, but "Pi keeps a conversation's own entries". |
| `tasks`, `submissions` | Pi's generation and tool tasks | Checkpoints, inputs, likely partial text and tool args. Terminal tasks are never pruned. | **No** |
| Conversation-scoped docs (`pi.agent`, `pi.usage`, `pi.provider`, `pi.inbox`, `pi.live`, `pi.tool.nested-call`, codemode journal/store) | Pi built-ins | `pi.agent` holds the system prompt (`instructions: params.systemPrompt`, runtime.mts:2194); codemode docs hold executed code | **No** |
| `mike.chat` (ChatLineage, runtime.mts:120) | per chat | Conversation ids and message-to-entry map (no text) | **No** |
| `mike.subagent` (runtime.mts:670) | per child | `envelopes[].body = spec.task` (runtime.mts:827,1140) = the prompt given to the subagent; reports | Retired, with its history, for *background* children of a deleted chat. Foreground children are not scrubbed at all. |
| `mike.subagent-children` (693), `mike.chat-agents` (976), `mike.agent-state` (990), `mike.memory-reviewed` (2686), `mike.tools` (143) | runtime | Ids, and tool schemas | Only `chat-agents` and `agent-state` entries are cleared. Others remain. |
| `mike.turns` (DurableTurns, 169) | every durable turn | `context` = `userId`, `userEmail`, `chatId`, `projectId`, `timeZone`, `delegatedWork` text (`ChatTurnResumeContext`, `modules/chat/chat.turn.ts:61-80`) | The entry is deleted at turn end (`forgetTurn`, 2612) but as a delta; the PII stays in the revision chain. |
| `document_revisions` | storage | For a **session**-scope document (`isCurrentOnly`, storage.mts:121) a new *base* deletes older revisions (storage.mts:972-974) and so does retiring the document (990-992). Deltas never delete anything. | n/a |

Other facts **[Verified]**:
- Word, tabular and project chats use the same store, keyed by `conversationId: chatId` (`wordChat.turn.ts:330,343`; `projectChat.turn.ts:310`). `deleteChatAgents` is only called from `chat.crud.ts:111` (assistant and project chats) and `user.dataCleanup.ts:809,845,1000`. Deleting a tabular review chat (`tabular.chats.ts:381`) or a Word chat does not call it.
- One-shot runs (memory curator, extraction) use `MemoryStorage` and vanish (runtime.mts:2143).
- Pi ids come from a monotonic counter (`durable_metadata.next_id`), so deleted ids are never reused. Code that follows a stale id degrades safely: `forkChatLineageOnPi` returns on a missing conversation (runtime.mts:2666), and `memoryReviewPointsOnPi` returns null.

### 1b. Mike relational and file stores

| Store | Evidence | Removed today? |
|---|---|---|
| `chats`, `chat_messages` (content, files, citations jsonb), `chat_leaf_state`, `chat_access_grants`, `citation_checks`, `verification_tasks`, `chat_code_approvals` | `backend/schema.sql:2111,2274,2461,7286,7343,8184` (all `on delete cascade` from `chats`) | **Yes**, by FK cascade (`deleteChat`, `chat.crud.ts:98-108`) |
| `word_chats`/`word_chat_messages`, `tabular_review_chats(_messages)` | schema.sql:2502-2520, 3186-3203 | Yes by cascade, but no Pi cleanup |
| `audit_events` | schema.sql:4942-4956. `chat_id` has no FK. Rows hold `user_email`, `title` (chat title or filename), model, cost. Written by `chatTurnAuditEvents` (`lib/audit.ts:122-250`); `audit.chat_turn` jobs carry the title. | **Chat/project deletion: no.** Account deletion: yes, by `user_id` (`user.dataCleanup.ts:988`; the comment says rows carry "prompt excerpts"). I found only titles and filenames written. |
| `citation_snapshots` | schema.sql:7320. Full retrieved text of web pages, cases and document versions. No `chat_id`. The only inbound FK is `citation_checks.snapshot_id ... on delete restrict` (7355). | **No.** I found no code that deletes snapshots (grep `citation_snapshots` + delete is empty). Orphans remain. |
| Memory (`memory_files`, `memory_file_versions` with `source_chat_id`, schema.sql:5003-5060) | Learned from chats by the curator | Not removed with a chat, by design (`docs/memory.md:291-297`). Chat deletion fences in-flight curation (`fence_memory_conversation_delete` trigger, schema.sql:5640-5662). Wipe/account/project deletion purges it. |
| Documents/uploads (`documents`, `document_versions`, R2/object store) | schema.sql:807. No `chat_id`. Chat files are library or project documents, referenced only by `chat_messages.files` jsonb. | Not removed with a chat (independent objects). Removed on project/account deletion via cleanup jobs (`user.dataCleanup.ts:948,965`, `docs/deployment.md:624`). |
| Exports | 24 h artifacts, swept by `runDbJobRetentionSweep` (`lib/dbq/runner.ts:375-392`); purged on account deletion (`user.dataCleanup.ts:957`) | Eventually; a chat export built before deletion lives up to 24 h |
| `db_jobs` payloads | Done rows kept 7 days, failed 30 (`runner.ts:72-74`). Payloads are ids and cursors (`docs/memory.md:325-327`); `audit.chat_turn` carries a title. | Time-expired |
| In-memory run buffers | `lib/streamRuns.ts:33` (60 s after finish); `docs/backend-architecture.md:177-186` | Self-expiring |
| Vault | `purgeVaultUser` on account deletion (`user.dataCleanup.ts:928`) holds credentials, not chats | n/a |
| Sentry / logs | `docs/observability.md:205-235`: prompts "never retained", messages replaced by a template; `docs/sentry-data-audit.md:174-177`: Sentry-side retention is not audited. Console logging in chat code is content-free where I looked (`streaming.ts:1305,1464`, `compactionHooks.mts:112`) but I did not audit every log line. | Out of our control after send |
| Workstation VMs | One persistent VM per employee, not per chat (`infra/workstation/README.md:3`); the agent's files live in `/home/agent`; host btrfs snapshots before turns (`lib/workstation/snapshot.ts:1-12`, `infra/node-a/workstations.nix:93-125`); tinyproxy logs every egress request to the journal (workstations.nix:9-11). Only temporary test VMs are wiped (`ws wipe`, `assignments.ts`). | **No.** Content written by code mode and the snapshots persist beyond chat deletion. |
| Backups | `infra/node-a/choir-backup-target.nix`: append-only restic repo; deletion only through an owner-supervised prune window. Postgres backups therefore keep deleted Pi data until pruned. Policy beyond that is not documented in the files I read. | Never by itself |
| Model providers | Out of repo scope; prompts were sent to them | Provider policy |

---

## 2. What deleting a Pi conversation would take

### Mechanics (from upstream `delete.ts`, read only) **[Verified]**
Delete order: document revisions, then documents (conversation-scoped and task-owned), entries, submissions, tasks, conversations, then `record_ids` for every removed id. This is one maintenance transaction. The tree walk follows `owner_conversation_id`, `owner_task_id`, and the `parent.conversationId` edge, which lives only in record JSON and needs a full-table `record::jsonb` scan per node (delete.ts:107-137). It refuses if a surviving task is owned by, or waiting on, a removed task. **Session-scoped documents are never touched** (delete.ts:39).

### Mike-specific complications
1. **Cross-chat fork dependency.** "Branch" copies the relational messages but forks the Pi conversation (`chat.branches.ts:230-326`). The branch reads the source's entries through `parent` up to `at`. Deleting chat A's conversation would break chat B's context or silently change its meaning. Options: refuse while a live descendant exists; keep the shared prefix (entries up to the highest live fork point) and delete only the tail; or materialize (copy) the prefix into the branch first. Whether branching may cross users (shared chats) is an open question; if it can, the retained prefix is another person's data.
2. **Orphaned descendants.** Memory-review forks and subagent conversations are not all indexed. Discovery needs both the Mike docs (`mike.chat`, `mike.subagent-children`, `mike.chat-agents`) and the `parent`/owner edges. A purge must read `ChatLineage` for the chat *before* retiring it, so it needs a durable tombstone holding the conversation ids.
3. **Session documents referencing ids.** `mike.subagent`, `mike.chat-agents`, `mike.subagent-children`, `mike.chat`, `mike.memory-reviewed` are per-chat family documents (live-retirable, see option (a0)). `mike.turns`, `mike.agent-state`, `mike.tools` are singletons shared by all chats, so they can only be pruned by key and need a base checkpoint to drop history.
4. **Upstream's cost profile.** `assertNoExternalTaskReferences` loads every surviving task record in the database (delete.ts:152). Ideally it filters to non-terminal tasks. The parent-edge scan is O(conversations) per tree node. Both need batching for a purge job that handles many chats.
5. **Live runs and caches.** Pi caches contexts and documents for 10 minutes (`contextRetentionMs`, `documentRetentionMs`, Pi CHANGELOG). Any Storage error closes the whole Session (runtime.mts:404-410 comment). A conversation deleted under a live Harness that later touches it takes the runtime down.
6. **Single owner.** `acquireOwnership` takes a session advisory lock (storage.mts:193; node.mts:75-85). `database.transaction.maintenance` rejects on the owning facade (node.mts:96) and `lockMaintenance` try-locks the same key (locking.mts:10-15). A second process cannot do maintenance while the API process runs. `docs/deployment.md:209-213` and `docs/memory.md:306-313` say the API process alone owns the store. The worker thread or process must never open it (`index.ts:138`, `ownsConversationStore`), so it cannot do the purge.

### Options

**(a0) Live, supported scrubbing of session documents (no Pi change).**
- Use `tx.retireDoc(token, key)` (Pi `session/transaction.d.ts:101-106`) for per-chat family documents. Retiring a current-only document deletes its revisions (storage.mts:990-992). Mike must handle a retired address reading as fresh.
- Switch the `mike.*` definitions to a periodic base, for example `checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 32` (Pi's own codemode store does this, `codemode.js:82`). Each new base deletes older revisions (storage.mts:972-974). This bounds retention of `mike.turns` PII and also replay cost.
- Risk: low. Effort: S-M. Does **not** remove entries, tasks, or conversations.

**(a) Offline purge before the Harness opens.**
- Vendor `delete.ts` (the vendored `database.mts` already has `transaction.maintenance`). Run it from a new boot step in `index.ts` main(), after `enforceDocumentLifecycleMigration()` and before `listenOrFail`/`resumeInterruptedTurns`. Piggyback on deploys, or add an operator CLI that requires the backend to be stopped.
- It takes work from a Mike-side tombstone table (public schema): chat id, conversation ids captured at deletion, `purge_after`, `hold`.
- During a rolling deploy the old container still holds the lock, so the try-lock throws; catch it and skip until next boot.
- Pros: upstream-sanctioned, one transaction, can also delete Pi `record_ids`. Cons: needs restarts; a long-running single instance may go weeks between boots; must resolve fork dependencies (item 1) in code Mike owns; a purge runs while no turns run, which is also a safe time to compact `document_revisions`.
- Effort: M for the CLI/boot step; M more for fork handling and tests (use the storage conformance suite in `backend/scripts/test-stack.sh`).
- Variant: an in-process quiesce, purge and reopen cycle (stop admitting turns, drain as the SIGTERM path does with `SHUTDOWN_TURN_DRAIN_MS`, close the Harness, purge, reopen). `resetPiRuntime` (runtime.mts:297) already closes and reopens but is test-only and does not wait for runs. Effort L, risk medium.

**(b) Deferred purge queue.**
- Same as (a) with the tombstone table as the queue, claimed by a new db job kind that runs in the API process (precedent: `API_PROCESS_JOB_KIND = "memory.consolidate"`, `jobs/registry.ts:33`; today it is a single constant and would become a set).
- The job cannot take the maintenance lock while the Harness is open. So it would either (i) close and reopen the runtime in-process (variant above), or (ii) delete *cold, tombstoned* conversations with plain SQL on a separate connection while the Harness stays open.
- [Inference] (ii) is mechanically possible because no route can address a deleted chat's `ChatLineage`, and its subagents are stopped. But it is unsupported by upstream: caches are not evicted, and a stray reference can close the Session. Treat it as a stopgap only after a soak test.
- Effort M-L. Risk medium for (ii).

**(c) Live deletion with upstream support.** What Pi would need:
- A `Harness.deleteConversation(id, {subtree, materializeDescendants})` that aborts tasks, waits for quiescence, evicts every cache and watcher, and checks the wait graph.
- A matching `Storage.deleteConversation` so adapters implement it.
- Session-scoped document deletion, or a "compact and drop history" call.
- Events so subscribers see the removal.
- Effort for Mike: S once shipped. Effort to get it: unknown, depends on upstream. Upstream's own doc comment says live deletion "requires upstream lifecycle coordination". Worth filing as a request now.

**(d) Crypto-shredding.**
- Feasible because the adapter parses and serializes all records client-side in `encodeJson`/`parseJson` (storage.mts:65-66), so it could encrypt the `record`, `content` columns. Ids, owner ids, and document addresses (including `key_value` = chat id) stay in clear text, so metadata survives.
- Hard parts: forks share ancestors across chats (one key per chat breaks branch B when A's key is destroyed unless branches re-encrypt a copy); singleton documents mix all chats (`mike.turns`, `mike.agent-state`) and would need restructuring into per-chat families; Pi expects readable records, and a decrypt failure is a Storage error that closes the Session, so reads of shredded data must be turned into "missing"; key backup deletion; plaintext still sits in process memory and provider logs.
- Upside: covers backups and document history uniformly, works while live.
- Effort L-XL. Not recommended until a requirement (backup erasure with no restore-and-reapply window) forces it.

---

## 3. Retention controls

### Existing hooks **[Verified]**
- No legal hold, retention setting or soft-delete of chats exists (grep for "legal hold" finds only eval cases at `backend/evals/auto-mode-gate/cases.mts:199-200`).
- `organizations` has only name/creator/timestamps (schema.sql:314-320). User settings are columns on `user_profiles` (schema.sql:13-60), including `quick_actions_visible`, `legal_research_us`, `autocompact_tokens`. Deployment flags are env vars (`STRICT_PRIVATE_MODE`, `lib/privateMode.ts:34`; `DB_JOBS_ENABLED`).
- Closest precedents: org-owned projects survive their creator's account deletion by detaching (`user.dataCleanup.ts:932-935`, `detachOrgProjectContent` at 301); `org_id ... on delete restrict` makes an organization with content undeletable (schema.sql:657, `lib/orgs.ts:56-62`); documents already soft-delete versions and keep them in the manifest (`docs/tamper-evident-exports.md` "Deleted versions"); `db_jobs` retention sweeps (`runner.ts:72-74,375`); memory has an "erase now" semantics (`docs/memory.md:297`).
- **audit_events is not tamper-evident.** The tamper-evident design covers project-export manifests (SHA-256 digest plus optional Ed25519 signature, `docs/tamper-evident-exports.md`). `audit_events` has no hash chain or immutability, and account erasure deletes by `user_id` (`user.dataCleanup.ts:988`).

### What a policy layer could look like
1. **Policy table**, e.g. `retention_policies(scope: deployment|org, org_id, chat_content_days, pi_content_days, audit_days, mode: soft|delayed_hard|hard|retain)`, plus `legal_holds(scope: org|project|chat|user, id, reason, placed_by, placed_at, released_at)`. Resolve most-restrictive-wins: a hold or `retain` beats any delete. Deployment-level defaults come from env, per-org overrides from the table. Do not put this in `user_profiles`: the data owner may be the firm, not the person.
2. **Deletion verbs in the UI**: "Delete" hides and removes Mike rows after policy allows, "Delete permanently" is available only if no hold or retain policy applies. The UI wording should state the retention window truthfully. Replace the "permanently delete" copy where Pi content is retained.
3. **Tombstones**: on delete, in the same transaction as the `chats` delete (the BEFORE DELETE trigger at schema.sql:5659 is a natural place), write `{chat_id, surface, org_id, owner, conversation_ids, deleted_at, purge_after}`. This also gives an auditable "deleted, content purged at X" record and the queue for options (a) and (b).
4. **Per-store treatment** (suggested):
   - Mike rows: delete when requested unless held. If an org needs retention, soft-delete (hide) instead and keep the rows.
   - Pi content: purge after `purge_after`, default for example 30 days. Hold or retain skips it.
   - `audit_events`: keep content-free metadata (ids, timestamps, action, model, cost) per audit policy. Null `title` and `user_email` on chat deletion or erasure (decision for owner). Audit has no tamper-evidence today. If the owner wants it, add a hash chain over metadata-only rows so redaction of identifiers is the only permitted mutation.
   - Citation snapshots and uploaded documents: attach to the chat's tombstone and apply the same clock. They currently have no owner link; snapshots need one.
   - Memory: separate policy (derived data; see `docs/memory.md:291-297`).
   - Workstation files and snapshots: per-user, not per-chat. They need their own retention rule and cannot be tied to a chat.
   - Backups: document expiry period; deleted data in backups should be re-deleted on restore.

### Regulatory landscape (high level, not legal advice; the owner needs counsel for specifics)
- **GDPR / UK GDPR**: right to erasure (Art. 17) applies "without undue delay" (commonly read as within a month) but has exceptions, including compliance with a legal obligation and establishment, exercise or defence of legal claims (Art. 17(3)). Storage-limitation (Art. 5(1)(e)) requires a defined retention period. Regulators generally accept backups being "put beyond use" and overwritten on schedule, provided the policy is documented. In a firm deployment the firm is typically controller and the operator a processor, so the firm's instruction governs, and a DPA usually requires deletion or return at end of service.
- **CCPA/CPRA and similar**: deletion rights with exceptions for legal obligations and claims.
- **Legal practice**: duty to preserve once litigation is reasonably anticipated (spoliation sanctions, for example FRCP 37(e), which the repo's own eval cases reference), client-file retention periods set by bar rules (often several years, varying by jurisdiction), and confidentiality and privilege. A user deleting a chat in a matter under hold can create exposure for the firm, which is why hold must override the deletion button and the purge.
- Practical consequence: the product should default to **truthful, configurable, hold-aware** deletion rather than "always erase".

---

## 4. Recommended phased plan

| Phase | What | Changes | Effort | Notes |
|---|---|---|---|---|
| 0 | **Truth in UI/docs** | Reword "permanently delete" copy (privacy-data page, settings page); add a deployment doc section "what deletion removes" using the Section 1 table | S | No behavior change; do this now |
| 1 | **Live scrub of session documents** | `checkpointWhen` periodic base for `mike.*` docs; `retireDoc` for per-chat family docs on chat delete; make foreground-subagent records scrubbed too; call cleanup for word/tabular chat deletion | S-M | Test with the real Postgres adapter that revisions shrink. Also fixes unbounded delta replay on `mike.turns`. |
| 2 | **Tombstone and policy skeleton** | Migration for tombstones (written from the chat BEFORE DELETE trigger and from the user/project cleanup paths), retention and hold tables, env default; capture conversation ids (ChatLineage, SubagentChildren, ChatAgents) at deletion time; null `audit_events.title`/email on chat deletion if owner agrees | M | No Pi deletion yet. Gives audit trail and queue. |
| 3 | **Offline purge** | Vendor `delete.ts` (with task-scan and parent-scan optimisation); boot-time step before the Harness opens, plus an operator CLI; fork rule (refuse or keep prefix); skip held tombstones; metrics and a "purged" marker | M-L | Requires conformance-suite run and a staging soak. Test fork, subagent, memory-review and mid-compaction cases. |
| 4 | **Policy UI and enforcement** | Org admin setting, hold placement, "delete" vs "delete permanently", citation snapshot and document cleanup under the same clock | M-L | Needs owner decisions below |
| 5 | **Upstream request or crypto-shredding** | File the live-delete request with Pi; revisit crypto-shredding only if backup-erasure becomes a hard requirement | L-XL | Optional |

### Open decisions for the owner
1. What default should "delete" mean: immediate Pi purge at next maintenance, a grace period (what length), or retained until an admin acts? Different for personal vs organization chats?
2. Who may place a hold (org admin only? project owner?) and what does the user see when a hold blocks deletion?
3. Branching across chats and users: may a branch outlive its source's deletion, and whose data is the shared prefix?
4. `audit_events`: retain with identifiers redacted, delete with the chat, or add tamper-evidence first? Who is the audit's audience?
5. Backups: how long are they kept, and is "beyond use until overwritten" acceptable to your counsel and customers?
6. Is a periodic restart or maintenance window acceptable, or must purge be live (which pushes toward upstream work or option (b)(ii))?
7. Per-chat vs per-user scope for workstation files and snapshots.
8. Counsel review of the GDPR/legal-hold design before any customer commitment.

### Caveats
- The document-revision retention finding was confirmed against Postgres by `backend/src/durable/spike/retireDoc.test.mts` (a blanked document keeps its earlier content in `document_revisions`; a retired one keeps none). Nothing else here was run.
- I did not audit every `console.*` call or Sentry runtime setting, only the documented guarantees.
