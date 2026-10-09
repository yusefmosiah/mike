---
definition_version: 4
readiness: intent
---

# Branching and prompt editing: retained scope

**Incomplete. This file is retained intent, not implementation authorization and
not acceptance.** Original Station 5 was written as landed by the overnight run;
the accounting reduced it to unverified. Migration, server tree, UI controls and
tests exist in source, but the owner reported missing controls on the actual app
and no real-surface acceptance is established in the reviewed record. Baseline:
HEAD `4f0f186`, working tree dirty with unrelated Mission 2 WIP; no mutation is authorized from here.

## Intended outcome

Pi-style immutable conversation tree: edit a prompt as a sibling branch,
regenerate an answer, step between sibling branches with a persisted per-user
leaf, branch into a new thread, and reload onto the intended history.

## What exists now (source, not acceptance)

- `backend/migrations/20261007_01_chat_message_tree_branching.sql`:
  `chat_messages.parent_message_id` (indexed, nullable FK) and per-user
  `chat_leaf_state` with RLS, plus chronological backfill for pre-tree rows.
- `backend/src/modules/chat/chat.tree.ts`: root-first path walk (depth cap 500,
  row-scan cap 2000, cycle-safe, fail-open reads) and `resolveLeaf`.
- `chat.branches.ts` and routes: `POST /chat/:chatId/branches` (edit-and-branch;
  inserts a sibling, moves the caller's leaf), `POST /chat/:chatId/leaf`,
  `GET /chat/:chatId/path`,
  `GET /chat/:chatId/branches/:messageId/siblings`.
- `chat.prepare.ts` resolves the caller's leaf so a new turn hangs off the
  active branch; the project-chat service mirrors the parent/leaf handling.
- Frontend: `useChatBranchActions.ts` (`editPrompt`, `regenerate` via
  `link_only_to_message_id`, `branchIntoNewThread` — re-points the leaf so the
  next prompt continues from the chosen message — `navigateSibling`,
  leaf-move reload); `UserMessage.tsx` edit control; `AssistantMessage.tsx`
  regenerate and "Branch into new thread"; `BranchNavigator.tsx`; `mikeApi.ts`
  `createBranch` / `setChatLeaf` / `fetchSiblings`.
- Tests on disk (source-implemented evidence only):
  `backend/src/__tests__/integration/chat.tree.test.ts`,
  `ChatView.branch.test.tsx`, `useChatBranchActions.test.tsx`,
  `AssistantMessage.branch.test.tsx`, `BranchNavigator.test.tsx`.

## Open acceptance outcomes

- The owner's missing-controls report on the actual app stands; no
  visible-surface acceptance has superseded it.
- Real-app runs (Mission 3 acceptance is Playwright on each flow): edit prompt
  creates the correct sibling branch; regenerate re-answers in place; sibling
  navigation persists the leaf; "branch into a new thread" is an independent
  case, not interchangeable with regenerate or sibling switching; reload
  renders the intended branch history; both chat surfaces and phone browser.

## Constraints retained

- Messages are immutable: an edit or regeneration inserts a sibling and moves
  the leaf; no destructive rewrite of prior prompts.
- The leaf is per reader: one user's navigation never moves another's view.
- Existing flat transcripts must backfill cleanly.
- Excluded: cross-conversation branch merging.

## Current mapping

Mission 3 (STATUS.md agenda item 3; acceptance: Playwright runs of each flow in
the real app). TRIAGE.md: "Source exists; user reported missing controls;
actual-surface acceptance remains open."
