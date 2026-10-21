# Area report: product scope and web app UI

Fork point 9a0a0a5b; ours = 304 commits, upstream since = 232.

## 1. Summary

The fork's "subtractive" scope change is much smaller than the brief suggests. Nothing legal was deleted. The built-in workflow catalog (`backend/src/lib/workflowCatalog.ts`, only an import line changed), the practice lists, CourtListener, and the bundled legal template library are all still there. What was narrowed or removed is framing: the system prompts no longer say "legal assistant" (they open as "an open-source AI agent for knowledge work"), the start screen's legal-advice line is gone, the tab title no longer says "Legal AI Platform", and the signup onboarding gate (profile and practice pages) was removed. The product name became a per-install setting (`packages/brand`). The preset templates are not ours: they were authored upstream (willchen96), cherry-picked into our tree, and upstream has since reworked the UI (a `PresetTemplatesPage`). Our only delta there is a license cleanup. On the UI side, the bulk of our work is additive: one shared `ChatThread` for assistant and project chat, a branching and edit-prompt model, shared-thread handoff UI, phone layouts, and viewers for new document and citation types. Upstream spent the same period on organizations/workspaces, side chats, subagents, web search and a design-token refactor, so 131 frontend files were touched by both sides (about 40% of ours). The shared chat files (`ChatInput`, `ChatView`, `UserMessage`) have diverged heavily.

There is no status/goals/throughline UI in the web app. Those are docs only (`docs/goals`, `docs/reports`, status files), which are outside this area. `docs/design-system.md` is unchanged. We added about 146 lines to `globals.css` (mobile font-size floor, composer-edge tokens, phone document-scroll rules).

## 2. Cluster table

| Cluster | Bucket | Readiness | Maturity | Upstream conflict |
|---|---|---|---|---|
| A. Product scope reframing (prompts and copy, start screen) | SUBTRACTIVE | FORK-ONLY | shipped+tested | med |
| B. Brand package (per-install name) | ADDITIVE | NEEDS-WORK | shipped+tested | high |
| C. Onboarding removal | SUBTRACTIVE | FORK-ONLY | shipped+tested | high |
| D. Preset-template license cleanup | FIX | NEEDS-WORK | shipped+tested | med |
| E. Skills as workflows (UI and routes) | ADDITIVE | NEEDS-WORK | shipped+tested | low-med |
| F. Shared ChatThread + project-chat parity | MIXED | NEEDS-WORK | shipped+tested | high |
| G. Conversation branching and edit-in-composer | ADDITIVE (touches chat core) | NEEDS-WORK | shipped+tested | high |
| H. Streaming scroll, composer keyboard, send shortcut | MIXED | NEEDS-WORK | shipped+tested | high |
| I. Shared-thread handoff and group-thread UI | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| J. Mobile and phone web layout | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| K. New viewers: images, text/Markdown, web citation reader | ADDITIVE | NEEDS-WORK | shipped+tested | low-med |
| L. Assistant timeline blocks: code cells, approvals, subagents, citation checks | ADDITIVE | FORK-ONLY (for now) | shipped+tested | high |
| M. Model picker grouping and vision indicator | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| N. Small web fixes ported or independent | FIX | READY | shipped+tested | low |

## 3. Clusters

### A. Product scope reframing (SUBTRACTIVE)
- What: Every prompt surface (assistant, Word, tabular, project) was changed from "AI legal assistant for lawyers" to a general knowledge-work agent that states it is open source under the AGPL. Contract-only drafting rules apply only when drafting a contract, and CourtListener moved to a trailing tool section. The start-screen note now says only that AI can make mistakes. Reason in the commits: models were declining ordinary questions (the "baseball scores" case).
- Commits: 1505b508 present Mike as a general knowledge-work assistant; a54ec976 introduce Mike as an open-source agent, not a legal assistant; 5e6c2e53 drop the legal-advice line from the start screen.
- Paths: `backend/src/modules/chat/engine/prompts.ts`, `wordPrompt.ts`, `backend/src/lib/agentIdentity.ts`, `backend/src/lib/__tests__/chatPrompts.test.ts`, `frontend/src/app/components/assistant/InitialView.tsx`.
- Readiness: FORK-ONLY. Upstream's product is legal-first, so the reframing is a positioning choice. A small, optional piece could go upstream: "legal is a strength, not the limit" wording and the web-search-for-current-facts instruction.
- Dependencies: none (the a54ec976 "no tool-round budget" part depends on code mode and the Pi loop, which belong to other areas).
- Conflict: upstream edited the prompts for web search and subagents (#661, #669), so `prompts.ts` will conflict textually.
- Not removed: workflows, practices, legal templates, CourtListener, the Personalisation practice options (these moved to `components/settings/personalisationOptions.ts`). Legal-string mentions in `frontend/src` went up from 67 to 182, mostly from the template catalog.

### B. Brand package (ADDITIVE)
- What: `packages/brand/brand.json` (name, title, description, website, sourceUrl) is read by the web app (`next.config.ts` inlines it into `lib/brand.ts`), the add-in (`@brand` webpack alias) and the API (`backend/src/lib/brand.ts`). Text that doesn't need the name was reworded. `frontend/src/__tests__/brandName.test.ts` parses sources and fails on a literal name in user-visible strings. All Dockerfiles copy the package. Not yet covered: native app names, add-in manifest, sign-in email sender, logo mark.
- Commits: a366d6ce read the product's name from one per-install file; 05a403b2 give the browser tab its own title.
- Readiness: NEEDS-WORK. Its value to upstream is white-labelling, which upstream's own AGENTS.md rule would need to adopt. The change touches about 90 strings across three apps, so it must land as one PR and will clash with every in-flight UI PR. The brand test is a strict gate.
- Dependencies: none; the other clusters' copy follows its rule.
- Conflict: high. A mass string edit over files upstream changed heavily (sidebar, site-logo, org settings). Upstream has no equivalent package.
- Maturity: shipped+tested.

### C. Onboarding removal (SUBTRACTIVE)
- What: Removed `OnboardingGate` and the `/onboarding/profile` and `/onboarding/practice` pages. Every signup, login, SSO and Google path goes to `/assistant`. Old `/onboarding/*` URLs redirect through `next.config`. The backend endpoint `POST /user/onboarding` stays, unused.
- Commit: 77698fce feat(auth): drop the onboarding steps; new accounts land in the assistant.
- Readiness: FORK-ONLY. Upstream went the other way: it added organization onboarding (411fe801, 6cc0ee0d) on those same pages.
- Conflict: high.

### D. Preset-template license cleanup (FIX)
- What: Preset templates are upstream's (commit 124d832b, authored willchen96, plus the permission fix 43220382). Both trees have them, so there was no removal. Our change (d617576e): re-checked each file's license, dropped the two Common Paper files with no notice (`Amendment.docx`, `Statement of Work.docx`, 83 files remain), made the generator record per-file Bonterms licenses (three CC BY-ND files), and made the picker show each file's license plus a "share unmodified only" note. A `frontend/public/preset-templates/README.md` was added.
- Readiness: NEEDS-WORK. Upstream's tree still ships those two files, so removing them is a real finding for them. But upstream replaced `PresetTemplatesModal` with `PresetTemplatesPage` and reshaped `presetTemplates.json`, so the code part must be redone on their UI. The doc and the file removals port easily.
- Conflict: med (JSON and modal moved on upstream).

### E. Skills as workflows (ADDITIVE)
- What: A workflow is a skill in the standard format (SKILL.md plus scripts/references/assets stored as a zip, versions in `workflow_versions`, migration `20261010_12`). UI: "Import skill" modal (GitHub folder pinned to a commit, or zip), a Skill tab with description, source, files, folder download, version list with Restore, and chat tools to save and install skills. `workflows.skills.ts` and `workflows.skillImport.ts` in the workflows module. `youtube-transcript` is the first skill kept in the repo.
- Commits: 492e2cf5 skills in the standard format, made and changed from chat; 8b661dce an installed skill can be read in the same turn.
- Key paths: `backend/src/modules/workflows/workflows.skills*.ts`, `backend/src/lib/skillFormat.ts`, `frontend/src/app/components/workflows/{ImportSkillModal,WorkflowSkillPanel}.tsx`.
- Readiness: NEEDS-WORK. It carries workstation sync (`~/skills`, from another area's cluster) and Python-kernel dependencies, so the chat-tool side needs the workstation. The import, versions and Skill tab are self-contained.
- Conflict: low-med. Upstream changed workflow access and visibility for organizations (0e2b3c94, hand-over to a successor) and "Playbooks lifecycle parity" (#683), so `workflows.service/routes` touch the same lines.

### F. Shared ChatThread and project-chat parity (MIXED)
- What: One `ChatThread` (818 lines) now renders the message list, follow-the-stream scrolling, scroll-to-bottom button, reveal gate and composer dock for both the assistant and the project chat. The project chat page shrank by about 435 lines and gained the new composer, Share, workflow chips, message errors and saved-version attachments. Earlier project turns also survive restarts (backend, other area). The old `useAssistantMessageLayout` hook was removed.
- Commits: 81697bae share one ChatThread between the assistant and project chat; 41d9c43f repair long threads: model limits, compaction, prompt cache, asks and language.
- Readiness: NEEDS-WORK. Valuable cleanup, but it is a rewrite of the chat view that upstream has also rewritten differently: upstream's `ChatInput` and `ChatView` were reworked for side chats (27b9ed90, 1d6f1c21) and subagents. It would need a rebase onto their structure and likely an RFC.
- Dependencies: G, H, I all build on `ChatThread`.
- Conflict: high. `ChatView` is 1392 lines upstream, 1345 ours, 1487 at the fork point. `ChatInput` and `UserMessage` differ from upstream by about 1000 lines each.

### G. Conversation branching and edit-in-composer (ADDITIVE, reaches the chat core)
- What: A pi-style message tree (`parent_message_id`, per-user leaf, migration `20261007_01`). UI: `BranchNavigator` (sibling arrows), regenerate, "branch into new thread" (`POST /chat/:id/fork`), numbered branched threads. Editing a prompt loads its text and files back into the composer (as ChatGPT does) and saves a sibling branch; the draft in progress is restored on cancel. On touch the pencil becomes a press-and-hold Edit/Copy menu (`useLongPress`, `useIsTouchPrimary`). Dropped screenshots with no extension get a name from their type. Prompts over twelve lines fold behind "Show more".
- Commits: a756ea20 pi-style conversation tree; e201ed7f working branch actions and fork into a new chat; 863cd4e5 branch controls in a live session; 5d5cd48d edit prompts in the composer.
- Readiness: NEEDS-WORK. Upstream has nothing equivalent (no tree, no branch UI; the only upstream "Retry" work is turn-scoped, #615). A strong feature, but it migrates the chat message schema and rewrites `UserMessage`, so it needs a design discussion. E2E specs `e2e/branching.spec.ts` cover it end to end.
- Dependencies: the Pi runtime for model-transcript forking (`runtime.mts`); F for the shared thread.
- Conflict: high on `UserMessage.tsx` and `ChatView.tsx`, `chat.routes.ts`.

### H. Streaming scroll, composer and keyboard behaviour (MIXED)
- What: While an answer streams the thread follows until the reader scrolls up; a new prompt stays in view; a growing composer pushes the thread up; Enter makes a newline and Cmd/Ctrl+Enter sends; the collapsed thought process follows its own newest lines; disclosures (thinking, code cells) remember how the reader left them. `/nr` adds a note to the thread without asking for a reply. Same changes land in the Word add-in's shared blocks.
- Commits: eac254f8 follow streaming answers, and send with Cmd/Ctrl+Enter; b3b86dc0 keep a new prompt in view, fold long prompts, remember disclosures; 273b2b4e a growing composer pushes the thread up; 4fda5fb7 /nr.
- Readiness: NEEDS-WORK. Enter-to-newline is a behaviour change many users will see as a regression, so it should go behind a setting. The scroll and disclosure fixes can be split out.
- Maturity: shipped+tested (`e2e/chat-scroll.spec.ts`, `ChatThread.test.tsx`).

### I. Shared-thread handoff and group-thread UI (ADDITIVE)
- What: A colleague can continue someone's thread. A database turn claim (`chat_turn_claims`, migration `20261010_01`; backend, other area) makes two simultaneous sends produce one run. UI: each prompt shows its sender once others have written, "X is generating a response", the page polls and shows the colleague's turn without reload, the Stop control is dimmed during a colleague's turn (403 `turn_not_yours`), tabular review chats show who holds the turn, and the model is told who wrote each message. `e2e/firm-handoff.spec.ts` runs three browsers.
- Commits: 63c363c6 firm thread handoff with a database turn claim; 5d8746db only the sender stops a turn; presence in review chats; 9e729c23 dim the Stop control; 543a40dd run a shared thread's code in its starter's workstation.
- Readiness: NEEDS-WORK. Designed for the same organization/firm sharing concept upstream built differently (organizations with Private/Public access). The claim and presence parts are mostly backend; UI must be reconciled with upstream's workspace model.
- Conflict: med.

### J. Mobile and phone web layout (ADDITIVE)
- What: 3-pane project workspace becomes chat-first below `md`, with explorer and document panes as slide-over drawers (`useIsDesktop`); chat threads scroll the page on phones; edge-to-edge composer (`displayEdge.ts`, CSS variables); swipe to reveal sidebar; keyboard handling (`nativeKeyboard.ts`, `useBlurOnOutsideTap`); a 16 px font floor on coarse pointers to stop iOS focus zoom; long words wrap. Parts of this exist for the native iPhone and Mac shells (those belong to the mobile areas).
- Commits: d08d3483 mobile 3-pane workspace; 410b5266 chat threads scroll the page on a phone; d2deeace swipe to reveal the sidebar; 071b1803 stop focus zoom; 713a9da3 slide the sidebar away after choosing a page.
- Readiness: NEEDS-WORK. The browser-only parts (pane drawers, focus-zoom rule, sidebar close) are good upstream material. The edge-to-edge and keyboard parts assume our iPhone app's web view.
- Conflict: med (upstream moved the sidebar and workspace switcher, `AppSidebar.tsx`; project panes less).

### K. New viewers: images, plain text and Markdown, web citations (ADDITIVE)
- What: `ImageView` (with vision-safe image upload), `TextView` rendering Markdown with source edit/save and a conflict check, `WebPageView` reader for saved web citations (page snapshot shown in the panel with the cited quote highlighted; `citation_snapshots` migration `20261012_01`), `SourceTypeIcon`, clickable web citations. Plain text, Markdown and CSV documents are accepted (migration `20261010_11`).
- Commits: ec855a58 plain-text documents; b49a080f Markdown rendered and edited as source; a9953af3 web citations in a reader view; 096578b3 images in.
- Readiness: NEEDS-WORK. Each is self-contained but pulls a migration and backend work (Readability, sharp). Upstream added its own web search (#661) with `WebActivityBlock`, so web-citation UI overlaps.
- Conflict: low-med.

### L. Assistant timeline blocks (ADDITIVE)
- What: Plain labels for scripts, workstation commands and web tools; code cells shown as computing steps (`CodeCellBlock`); code-approval banner and requests (`CodeApprovalBlock`, `useCodeApprovals`); subagent block; citation-check status (`CitationCheckStatus`, `useDocumentCitationChecks`); secret request field (vault). Fully tied to our backend features.
- Readiness: FORK-ONLY until the matching backend pieces (code mode, subagents, vault) are decided. Upstream shipped its own `SubagentGroup` and `WebActivityBlock` in the same period.
- Conflict: high on `EventBlocks.tsx` and `eventUtils.ts`.

### M. Model picker grouping and vision indicator (ADDITIVE)
- What: Models are grouped by the provider serving them (declared models take a `group`), with "Sees images" per model and a send-time check. Default for volume work set to flash models.
- Commits: 588516fe, 096578b3, 8c3f0b4a.
- Readiness: NEEDS-WORK (the grouping is small, but upstream added `modelCatalog.ts` and org-level model lists).
- Conflict: med.

### N. Small web fixes (FIX)
- Several are ports of upstream code or small independent fixes: 0cfeeacb password policy 10 chars / 72 bytes (adapted from upstream c94052d7, so already upstream); 9cd96a5c show whole emails in access lists (matches the AGENTS.md rule); 693255ee per-file upload outcome; 71a96138 flush autosave on unmount while a save is in flight; fbaf92b8 project members on inherited access (cherry-picked); b573daaf flush chat search field and keyboard-only title focus ring (also upstream 399270fe); 84551885 keep a run of steps in one card across blank text; 5cb5b7c1 keep a reasoning block open after it finishes streaming; 2c1d5c92 read-aloud no longer resets on every streamed chunk.
- Readiness: READY for the uncorrelated ones (autosave flush, steps card, reasoning block, read-aloud reset), after checking each against upstream's file state. Skip the ports.

## 4. PR candidates

1. ~~**fix(memory): flush autosave on unmount while a save is in flight**~~ (71a96138). Withdrawn when this report was merged: 71a96138 is a port of upstream's own `90206f5a` (pick #6 in `upstream-picks-2026-10-10.md`), so upstream already has it.
2. **fix(templates): record each bundled template's own license and drop two unlicensed files** (d617576e). Files, `docs/preset-templates.md` and the generator script only; the picker code needs a port to their `PresetTemplatesPage`. Raises a real licensing question about upstream's bundled `Amendment.docx` and `Statement of Work.docx`.
3. **feat(chat): conversation branching: edit a prompt, regenerate, branch into a new thread**. Schema, API, `BranchNavigator`, composer edit. Scope as an RFC first because it moves chat state to a message tree and edits the shared files in cluster F.
4. **feat(projects): chat-first mobile workspace** (d08d3483 plus the 16 px focus-zoom rule and the sidebar close on navigation). Browser-only, with tests; leaves desktop untouched.
5. **feat(workflows): skills in the standard format with import, versions and Skill tab** (492e2cf5, minus the workstation sync). Self-contained UI and routes with tests and a migration.

## 5. README digest

- The web app is a general knowledge-work assistant: its prompts and start screen no longer assume a lawyer, but legal workflows, templates, CourtListener and practice options are still included.
- The product name comes from one file, `packages/brand/brand.json`, read by the web app, the Word add-in and the API; replace it before building to rebrand an install. A test fails if the name is hardcoded in user-visible text.
- New accounts land in the assistant straight away; there is no signup questionnaire. Profile details are in Settings > Personalisation.
- Conversations are trees. You can edit a prompt, regenerate an answer, move between versions, or branch into a new thread; on touch, press and hold a prompt for Edit and Copy.
- Assistant chats and project chats share one thread component, so both get the same composer, scrolling, sharing and error handling. In a shared thread, others' prompts show who wrote them, and you can see when a colleague's answer is generating.
- On phones, project chats show only the chat, with the file list and document in slide-over panels; chat threads scroll the page and the composer sits at the bottom edge.
- Documents can be images, plain text, Markdown or CSV, shown in their own viewers; saved web pages cited by answers open in a reader view in the document panel.
- Workflows can be skills (SKILL.md plus files); you can import them from GitHub or a zip, ask the assistant to save one from a chat, and restore earlier versions.
