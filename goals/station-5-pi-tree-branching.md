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

## Real-app runs (2026-10-09, agent; not acceptance)

`e2e/branching.spec.ts` drives each open outcome above in Chromium against
the real web app, backend, Postgres and Pi runtime of the local e2e stack.
Answers come from `e2e/stubModel.mjs`, a scripted OpenAI-compatible server
behind the stack's "E2E placeholder" model: `Stub answer N to: <prompt>`,
numbered, so a regenerated answer differs from the first. No model is called,
so the spec also runs in CI (`.github/workflows/e2e.yml` now starts the stub).

| Test | What it checks |
|---|---|
| regenerate | a second answer becomes a sibling ("Response branches" 2/2), still one prompt and one answer on screen; Previous shows answer 1 (1/2); a reload keeps answer 1 |
| edit prompt | Save replaces the prompt with the edited version and its own answer ("Message branches" 2/2); Previous brings back the original prompt and answer (1/2); a reload keeps it; Next returns to the edit |
| branch into new thread | opens a different chat URL holding the prompt and answer; a follow-up sent there does not appear in the original chat |
| project chat | the edit flow in a project's assistant chat, with a reload and Previous |
| phone (390×844, touch) | edit, regenerate and both steppers in view at phone width; no sideways scroll |

Run, from the repository root, with the development stack holding 3000/3001:

```
E2E_API_PORT=3201 E2E_WEB_PORT=3100 npx playwright test e2e/branching.spec.ts --project=chromium --reporter=line
  6 passed (2.0m)
```

The six include Playwright's sign-in setup. The first two runs failed for
harness reasons, not app ones: a stale backend from earlier in the session
answered on 3201, and the stub quoted Mike's `[Sent: ...]` timestamp prefix.
Both were fixed in the harness before the passing run. The controls the owner
reported missing were present and working in these runs; whether that matches
what the owner saw needs the owner's look.

Whole local suite with the same port override:
`66 passed, 4 skipped, 1 failed (16.0m)`. The 4 skipped are the LLM specs (no
`ANTHROPIC_API_KEY`). The failure is tabular reviews "adds a document",
reproduced alone: the upload is refused because local storage's CORS allows
only `http://localhost:3000` and the override put the web app on 3100. It is a
harness limit, documented in `docs/e2e-ci.md`, not a branching or app change.
