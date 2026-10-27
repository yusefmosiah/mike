# The Night Stack Gets a Review

Written October twenty-seventh, midday. This letter covers the whole run — roughly fifteen hours from Monday evening into Tuesday morning, plus a two-model code review and the fix pass that followed. It replaces nothing; it's the first report on this stretch.

The night's work is landed, reviewed, and live on staging. A panel of two models read the full diff afterward and found one real security bug and a queue that could silently eat typed messages. Both are fixed and shipped.

## What got built

Three strands ran in parallel overnight. The first was plumbing you asked for earlier in the mission: the composer queue, so you can keep typing while a turn runs, and the capability manifest, so a turn knows which workstation layers it has. The second was the de-silo — documents are now shared across your private chats by default, capped at fifty of the newest, and a Confidential toggle on the composer or a library row opts a document out of that sharing entirely. Publishing also learned to follow a document's versions, with editable expiry and revoke. The third strand was quieter: a docs audit that makes every route, module, and tool answer to a page or a reasoned exception, and an OCR benchmark harness for picking the workstation's OCR engine by measurement instead of taste.

By mid-morning it was all committed and green. Then the review.

## What the review found

I ran the whole 148-file diff past two reviewers — Devin's model and DeepSeek's flash tier — because the diff touched sharing semantics, a migration, and a queue. They both came back with request-changes verdicts, and they agreed on the important things.

The blocker was subtle. The auto-share sweep — the piece that pulls your fifty newest standalone documents into a chat's context — ran whenever a chat id existed. That meant a guest sending a message in your shared chat had their entire personal library swept into a transcript you and every other grantee can read. The confidential flag couldn't help them; they'd never opted in to sharing that scope. Same leak in reverse: your own send inside a project chat could leak personal documents into a shared transcript. The fix uses the same shared-audience verdict that already fences your personal memory — the sweep only runs in your private standalone chats now.

The other majors were a queue that could delete your typed text on a failed send (the restore path was dead code — the error got swallowed a layer up and never reached it), a queue written for a brand-new chat that could auto-send into the *next* new conversation you opened days later, and a workstation bug where the fonts layer's nix expression referenced an unbound variable — it could never have built.

Two things the reviewers flagged that I'd already half-fixed came back in sharper form: the confidential flag's PATCH endpoint was an existence oracle (you could tell a project document existed from its error code), and the benchmark's engine comparison was unfair — it timed the package-manager startup for some engines and not others.

## What I did about it

Every finding got verified by reading the code, not taken on trust — about a dozen confirmations and one correction. All of them are fixed: the sweep gates on the same shared-audience check the memory system already uses, the queue surfaces send failures so a refused entry returns to the strip instead of vanishing, an orphaned new-chat queue pauses instead of firing into the next conversation, the nix expression binds its package set properly, the confidential check now answers "not found" before it answers "conflict," the benchmark samples deterministically and times the engine itself, and a dead partial index got replaced by one that matches the actual sweep query. One honest caveat that stays: live publication links keep serving after a doc goes confidential — that's the spec, not an oversight, but the UI doesn't say it yet.

## The one thing to remember

The review paid for itself in the first finding. The rest of the night was solid — tests at a hundred percent of statements where I held myself to it — but the one place the de-silo's new sharing touched a trust boundary, it leaked in exactly the direction the feature exists to prevent. Fresh eyes on a wide diff caught what fifteen hours of building couldn't.

If I were holding the phone: the sweep fix is the thing to re-verify on staging — open a shared chat as a guest, send a message, and confirm the model can't see the guest's library. That's the whole proof this mattered.

## Names and receipts

Review panel: Devin CLI (swe-2-max) and `opencode-go/deepseek-v4.1-flash` via the agentic-consensus runner; outputs at `/tmp/consensus-review/run/` and `run2/` on this machine.

Night's work: commits `8ed94852` through `571b0fc1`, plus `142d7ff2`, `bd563886` — composer queue, publications follow+edit, de-silo flag, docs audit, layers manifest, ocr-bench.

Review fixes: commit `67af87a1` — sweep gating, queue restore + orphan pause, nix `p` binding, ledger HTTP, confidential oracle, index migration `20261027_03_sweep_index.sql`.

Key files: `backend/src/modules/chat/engine/contextBuilders.ts` (the sweep), `frontend/src/app/hooks/useAssistantChat.ts` (strict mode), `frontend/src/app/components/assistant/useChatQueue.ts` (adoption + orphans), `infra/workstation/guest.nix` (fonts layer), `infra/node-a/workstations.nix` (ledger sink), `infra/workstation/ocr-bench/bench.py` (determinism + engine timing).

Deferred, deliberately: the OCR benchmark's real run (needs the 200-page corpus and the 4-vCPU VM, neither on this Mac); multi-tab queue sync (design decision, not a bug fix); the live-links-keep-serving warning in the confidential UI.
