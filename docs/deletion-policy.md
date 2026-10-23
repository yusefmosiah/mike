# Deletion and retention policy

Status: **draft for legal review, 2026-10-22.** This page records what deletion
does in Mike today and the policy we propose. Nothing in the "Proposed policy"
section is built yet, and nothing here is legal advice. The technical evidence,
with file and line references, is in
[the Pi deletion investigation](reports/pi-deletion-2026-10-22.md).

## Why this needs a policy

A firm may have to delete a person's data on request, for example under the
GDPR's right to erasure. A firm may also be forbidden to delete it, for
example under a litigation hold, a bar rule on keeping client files, or the
GDPR's own exception for legal claims. Deleting a chat therefore cannot always
mean erasing it everywhere at once. The product needs to say what is deleted,
where, when, and who can stop it.

## What deletion does today

When a person deletes a chat, a project or their account, Mike removes what
the app shows: the chat, its messages, sharing grants and citation checks.
Several copies remain.

| Where | What it holds | Removed by deletion today? |
|---|---|---|
| Chat rows in the app database | Messages, attachments list, citations | **Yes** |
| The model's conversation store (Pi Durable) | The full transcript the model saw: prompts, answers, tool results, summaries, system prompts, subagent work, and records of each turn including the person's email | **No.** Background subagents of a deleted chat are stopped and their task records erased; their transcripts stay. Word add-in and tabular review chats get no cleanup there at all. |
| Audit log | Chat title, email, model, cost | Not on chat or project deletion. Removed on account deletion. |
| Citation snapshots | Full text of retrieved cases, web pages, documents | **No** |
| Uploaded documents | The files themselves | Not with a chat (they belong to the library or project). Yes with the project or account. |
| Memory | Notes learned from chats | Not with a chat, by design. Yes with a memory wipe, project or account. |
| Workstation computers | Files the agent wrote, disk snapshots, logs of web requests | **No.** They belong to a person, not a chat. |
| Exports and job records | Short-lived copies | Expire on their own (24 hours to 30 days) |
| Backups | Database copies | **No.** Kept until the backup is pruned. |
| Model providers | Prompts sent to them | Governed by each provider's own policy |

The privacy settings page and the account deletion dialog say "permanently
delete". **For the model's conversation store, that is not true today.** We
should correct the wording before any customer relies on it.

## Why the model's conversation store is hard to erase

The store Mike uses (Pi Durable) can only delete a conversation while it is
not running, and while no other part of Mike holds it open. Mike's server holds
it open for as long as it runs. A conversation can also be shared: a branched
chat reads its earlier part from the chat it branched from, so erasing the
original would damage the branch. Real erasure therefore needs either a
maintenance step that runs while the server starts, or a change in Pi itself.
The investigation describes five ways to do it, from small (erase the records
Mike keeps about each chat, which can happen live) to large (encrypt each
chat and destroy its key).

## Proposed policy

1. **Delete hides at once, erasure follows.** Deleting a chat removes it from
   the app immediately. The copies in the model's store are erased after a
   grace period (for example 30 days), at the next maintenance step.
2. **A hold always wins.** An administrator can place a legal hold on an
   organization, project, chat or person. Held content is never erased, and the
   grace period does not run out while the hold stands. The person deleting
   is told that the content is retained.
3. **Settings per deployment and per organization.** The deployment sets a
   default; each organization can override it, choosing from: erase after the
   grace period, erase at once, or keep. The most protective setting wins.
4. **A record that something was deleted.** Each deletion leaves a record
   without content: what was deleted, by whom, when, and when its content was
   erased. The audit log keeps ids, times, model and cost, and drops chat
   titles and email addresses once the content is gone.
5. **Every copy on one clock.** Citation snapshots, workstation files, exports
   and backups each get a stated retention period that matches the policy, so
   no copy outlives it by accident. Restoring a backup re-applies the
   deletions made since.
6. **Truthful wording.** The app says what deleting does under the policy
   that applies, instead of "permanently delete".

## Questions for legal review

1. What should "delete" mean by default: erase after a grace period (how
   long), erase at once, or keep until an administrator acts? Should it differ
   between a person's own chats and a firm's chats?
2. Who may place and lift a legal hold, and what should a person see when a
   hold stops their deletion?
3. Who controls the data: is the firm the controller and the operator its
   processor, so that the firm's instructions govern erasure requests?
4. If one person branches another person's chat, may the branch keep the
   shared earlier part after the original is deleted?
5. What should the audit log keep after a deletion, and for how long? Does it
   need to be tamper-evident?
6. Is keeping deleted data in backups until they are overwritten acceptable,
   and for how long are backups kept?
7. How do bar rules on keeping client files, and the duty to preserve once
   litigation is expected, constrain the defaults?
8. How should workstation files, which belong to a person rather than a
   chat, be retained and erased?
9. Is a short maintenance window for erasure acceptable, or must erasure
   happen without one?

## Plan once decided

| Phase | Work | Size |
|---|---|---|
| 0 | Make the deletion wording and docs truthful | Small |
| 1 | Erase the records Mike keeps about a chat while the server runs, including Word and tabular chats | Small to medium |
| 2 | Deletion records, policy settings and holds in the database, with no erasure yet | Medium |
| 3 | Erase deleted conversations in a maintenance step when the server starts | Medium to large |
| 4 | Policy and hold settings in the app; snapshots and documents on the same clock | Medium to large |
| 5 | Ask Pi for live deletion, or encrypt per chat if backups must be erased too | Large |
