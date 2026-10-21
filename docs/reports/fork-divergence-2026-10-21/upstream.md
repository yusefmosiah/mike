# Upstream review: open-legal-products/mike since the fork point

Range: `9a0a0a5b` (upstream PR #594, 2026-10-07) to `upstream/main` = `795f9608` (2026-10-21). Read-only review, nothing in the tree was touched. Upstream: 232 non-merge commits, 22 first-parent merge commits, 1452 files, +171k/-30k lines. Fork: 304 commits (297 by Yusef), 1571 files, +193k/-16k. 489 files were changed on both sides.

## 1. Direction summary

Upstream is driven by one maintainer (Will Chen, as `willchen96` and `Will Chen`: 153 of 232 commits, plus 32 commits authored by his Claude agent). `mlx`/`mlx51` have 17 commits but about ten very large PRs (Mac app #612, auth policy #529, web workspace/crash recovery #531, Word recovery #532, tabular recovery #530, StorageAdapter #403, Google scopes #653, Playbooks parity #683, migrate.sh #609/#614). External contributors: Charles Becker (subagents #669, web search #661), duncanmcqueen (Playbooks #427, 20k lines), trinitrion (PDF no-text-layer, addon batching), terpstra-209 (signed URLs), James Gauci (reasoning replay #534). Dependabot adds 19 commits plus 3 merged PRs. Pace is about 15 commits a day, with peaks of 34 (Oct 12) and 31 (Oct 11).

Themes, in order of weight:

1. **Multi-tenant organizations.** Every account gets a personal organization, there is a workspace switcher, an owner role, org-level provider keys and model lists, private-by-default org work, member handover, departure retention, an audit log, profile photos and org logos. About 100 commits, with #630 alone at 68 commits and 329 files.
2. **Playbooks.** A clause-review product: autosaved workspaces, document reviews in the pane, detached runs, History tracking, durable jobs. About 35k lines across four PRs.
3. **Agentic chat.** Subagents, provider-native web search, inline copyable text cards, quote/annotate, side-by-side chats.
4. **Provider breadth (BYOK).** Bedrock, Azure OpenAI, Vertex, Azure Foundry, xAI, Mistral and custom endpoints, still on the Vercel AI SDK.
5. **Reliability and recovery.** Crash screens, Word and tabular turn recovery, a migration ledger, access-control hardening, a weekly bug-review sweep.
6. **Distribution.** A Mac app, a swappable storage adapter, minimal Google scopes for OAuth verification, Sentry moved to the org.
7. **Hygiene.** Dead-code removal, `noUnusedLocals`, UI primitive consolidation, shared design tokens.

Upstream is not moving toward any of the fork's differentiators (Pi runtime, direct Postgres, OpenXML document model, vault, code mode, voice, iPhone app, attestation). It is moving toward a team/enterprise legal workspace product on Supabase plus the Vercel AI SDK.

## 2. Theme table

Conflict ratings are for merging that theme's files into the fork as they stand. "Adapt" means the idea or UI is wanted but the code must be rewritten for the fork's `createDb`/`Db` (no PostgREST) and Pi runtime.

| Theme | PRs (#) | What it does | Pull into fork? | Conflict (fork paths) |
|---|---|---|---|---|
| Organizations / workspaces (~100 commits) | #630 (68 commits), #649, #645 (part), #631 | Personal org per account, workspace switcher, owner role, org keys and model lists, private/public sharing, member handover and 30-day archive, Privacy & Data, org settings pages. 20 migrations `20261011_01` to `20261014_08`. | Adapt, as a staged port if multi-tenant is wanted. Not wanted for a single-user product. | High. `schema.sql`, `modules/orgs`, `modules/projects`, `modules/workflows`, `modules/chat`, `frontend/.../AppSidebar.tsx`, `mikeApi.ts`, `contracts/index.d.ts`. Fork touched orgs only lightly (2 files). |
| Audit log + profile photos | #635 (5 commits) plus about 14 direct commits (`06c05192`, `a0598375`, ...) | Org audit log with filterable actors, audited private-content access, recoverable deletion, avatars and logo cropper. | Adapt. Audit is useful and the fork already has `lib/audit.ts` and tamper-evident exports. Photos are low value. | Med. `backend/src/lib/audit.ts`, `modules/audit` (4 fork files vs 6 upstream), `settings` pages. |
| Playbooks | #427, #658, #683, #673 | Clause playbooks: autosave workspace, document reviews, reviews run in the pane and detached, History, Word add-in support. 135 files mention playbooks. Migrations `20261016_02` to `20261021_04`. Docs: `docs/playbooks.md`. | Adapt. This is the one big feature the fork lacks. Port after the DB-layer rename. | Low on files (fork has no `modules/playbooks`). Med on integration: `chat/engine/tools`, `schema.sql`, `word-addin`, `mikeApi.ts`. |
| Subagents | #669, #686 | `delegate` tool, up to 8 per answer, scoped documents, approvals, pills in the UI. `docs/subagents.md`, migrations `20261021_01/02`. | Already have equivalent. The fork has `chat/engine/subagents/` and Pi `subagents.test.mts`. Mine the UI pills and `docs/subagents.md` only. | Med. `chat/engine/streaming.ts`, `tools/toolDispatcher.ts`, `AssistantMessage`/`EventBlocks`. |
| Web search | #661 | Provider-native search plus API-key search, per-user toggle, `docs/web-search.md`. | Already have equivalent (modular engine: Keenable, Tavily, Exa, Parallel, plus a reader, with citation verification). Skip. | Med. `lib/search*`, `settings`. |
| Text cards, quote/annotate, side chats | #656, #623, #624 (15 commits) | Inline copyable text cards. Quote and annotate responses (web and Word). Two chats side by side, side-chat panel. | Adapt the UI. Fork has `AssistantSidePanel`, but not this behaviour. | High. `ChatView.tsx` (768 fork lines vs 907 upstream), `ChatInput.tsx`, `AssistantMessage.tsx`, `chat/[chatId]/page.tsx`. |
| BYOK providers | #608, `25779536`, #601, `553b7550` (#534), `80534b7d` | Bedrock, Azure OpenAI/Foundry, Vertex, xAI, Mistral, custom endpoints. Reasoning replay. Settings UI rework. 112 files in one commit. | Adapt. Take settings UI, key tables and migrations. Redo the backend on `pi/providers.mts`; upstream's `providers.ts`/`aiSdk.ts` do not exist in the fork. | High. Modify/delete conflicts on `lib/llm/providers.ts`, `aiSdk.ts` and 4 test files. Fork has 0 Bedrock/Vertex/Azure hits. |
| Reliability and recovery | #531, #530, #532, #615 to #617, #613 | Crash screens, tabular and Word turn recovery, input caps, historical version panels, provider and stream deadlines, replayed Word edits. | Adapt selectively: Word recovery (#532) and crash boundary (#531). Fork has its own claim/resume system (`chat_turn_claims`, resume after restart). Skip the tabular recovery. | High in chat, med in Word. `chat/engine`, `word-addin/src/taskpane/hooks/useWordAssistantChat.ts`, `useWordDoc.ts`, `api/stream.ts`. |
| Storage seam | #403, #607, #584 | `StorageAdapter` with S3 and filesystem backends, replaces the 635-line `storage.ts`. | Yes. Isolated and useful. | Low. The fork touched `lib/storage.ts` by 3 lines; #584 is already taken. |
| Auth policy | #529 | Password policy, sign-in recovery, confirmation. | Partly done (fork commit `0cfeeacb`, "policy part only"). Take the sign-in recovery if wanted. | Med. `passwordPolicy.test.ts` add/add, `authEmailConfirmation.test.ts` add/add. |
| Mac app | #612 | Self-contained Electron wrapper with local workspace. | Already have equivalent (fork `8cb586f2`, "upstream's wrapper without local mode"). Skip. | High, spurious. `desktop/` has 12 add/add conflicts. |
| Google scopes + Sentry org | #653, #671, #682 | `gmail.compose` and `drive.file` with a file picker, operator switch for Gmail, Sentry DSN to the org. | Adapt #653/#671 only if the fork keeps Google connectors. Skip #682. | Med. `lib/integrations/googleDrive*`, `docs/google-*.md` (2 modify conflicts). |
| Migration ledger and infra | #609, #614, #651, #581, #610 | `schema_migrations` ledger and `migrate.sh`, `scripts/stack.sh`, PR e2e against a local Anthropic fixture, capped Vitest workers. | Already have equivalent for the ledger (hand-ported 2026-10-10). Take #610 and #651; skip the rest. | Med. `migrate.sh`, `migrationLedger.test.ts`, `adopt-ledger.sh` all add/add. |
| Personalisation | #576 (25 commits), `663d3b16`, `d19fdc6d` | Custom instructions, response style, response language, `user_response_details`. | Adapt. Small, self-contained. Check against the fork's own prompt assembly. | Med. `modules/user`, `settings` page, `contextBuilders.ts`. |
| Contract-quality fixes | #537, #535, #603, #381, #561 | PDF no-text-layer flag, addon asset batching, access hardening, upload outcomes, preset templates. | Already taken, ported by hand (picks #1, #3, #11). #537 and #535 are not yet taken (take them). | Low. |
| Cleanup and UI consolidation | #606 (11 commits), #626, #602, `54bc5ba1`, `ecd3ebf9`, #396 | Removes dead routes and aliases, `noUnusedLocals`, merges the review tables, unifies dropdowns, shared design tokens. | Skip or defer. These are mostly mechanical and touch files the fork rewrote. Take #396 (tokens) if the add-in is kept. | High. Touches 100+ files, many fork-modified. |
| Document search + History | #645 (160 files) | Document text search (`document_text_search`), workspace-scoped History, sharing controls, tabular history/status columns. | Adapt the search. The fork has its own document model and retrieval. | High. `schema.sql`, `DocTable.tsx`, `mikeApi.ts`. |
| Weekly bug sweep | #655 | 44 files, remaining review findings. | Adapt by reading the list; apply the fixes that are relevant. | Med. |
| Docs | #650, #687, `docs/*` | Support/maintainership wording, combined Google guides, new `direct-provider-models.md`, `organization-offboarding.md`, `playbooks.md`, `subagents.md`, `web-search.md`. | Skip, except `playbooks.md` if playbooks land. | Low. `docs/google-*.md` conflict. |
| Dependabot | 19 commits (#636, #639, #640 to #643, #674 to #681, ...), Sentry v11 | npm and Actions bumps. The Sentry v11 migration (`54b6b3a1`) needs code changes. | Skip as bulk. Rerun `npm audit`/`npm update` in the fork. Take Sentry v11 if wanted. | High on lockfiles (4 package-lock conflicts). |

## 3. Collisions (both sides changed heavily)

Overlap ranked by the smaller of the two sides' churn (lines changed since 9a0a0a5b). Columns: upstream / fork.

| File or area | Up / fork | What each side did |
|---|---|---|
| `frontend/src/app/components/assistant/ChatView.tsx` | 907 / 768 | Up: side-by-side chats, quote/annotate, text cards, subagent pills, response details. Fork: branches/edit-prompt tree, voice, resume, mobile. |
| `frontend/src/app/lib/mikeApi.ts` | 1556 / 887 | Up: org and workspace parameters, playbooks, profile photos, audit. Fork: branches, skills, vault, voice, citations. Both append, so the conflicts are in the middle of long files. |
| `backend/schema.sql` | 4091 / 808 | Up: orgs, playbooks, subagents, web search. Fork: branching, workstations, citation checks, ledger. |
| `frontend/.../projects/[id]/assistant/chat/[chatId]/page.tsx` (+ test) | 1230 / 654 | Same split as `ChatView`. |
| `backend/src/modules/chat/engine/*` (`streaming.ts` 463/1464, `contextBuilders.ts` 530/404, `tools/toolDispatcher.ts` 385/702, `tools/documentOps.ts` 308/908) | high / high | Up: AI SDK loop plus delegate, web search, text cards, workspace boundaries. Fork: Pi runtime, in-memory OpenXML AST with atomic block tools, parallel lookups, auto-mode gate. These are different architectures; do not merge them textually. |
| `backend/src/lib/llm/*` (`providers.ts`, `aiSdk.ts` deleted in the fork; `models.ts` 326/254; `types.ts`) | 381+312 / 446+605 | Up: more AI SDK providers. Fork: Pi runtime, attestation, endpoints, compaction. |
| `chat.routes.ts`, `chat.prepare.ts` | 166 / 943, 161 / 242 | Fork rewrote the turn handling (claims, resume, handoff). |
| `desktop/` (`main.js` 844/743, `e2e/flows.e2e.mjs` 706/713, `app.e2e.mjs`) | ~3000 / ~3000 | Same upstream Mac app (#612) hand-ported by the fork, then edited; now 12 add/add conflicts. |
| `backend/scripts/migrate.sh`, `migrationLedger.test.ts`, `docker/db-init/adopt-ledger.sh` | 358 / 358 | Both implemented the same ledger from the same origin; the fork's version has its own adoption path. |
| `presetTemplates.json`, `.ts`, `.test.ts`, `scripts/build-preset-templates.mjs` | 1094 / 1161 | Fork took upstream's commit, then removed unlicensed items and added per-file licences. add/add. |
| `ChatInput.tsx`, `AssistantMessage.tsx`, `EventBlocks.tsx`, `assistantTurnStream.ts` | 238 to 300 each | UI of the same chat surface. |
| `word-addin/src/taskpane/*` | 923 / 213 | Up: session recovery, replayed edits, shared chat UI. Fork: refusal messages, model catalog, streaming. 5 files conflict. |
| Test files (`chat.routes.test.ts`, `tabular.routes.test.ts`, `user.routes.test.ts`, `projects.routes.test.ts`) | 420 to 480 | Each side added tests for its own behaviour in the same files. |
| Lockfiles | 2k to 8k | Always take one side and regenerate. |

## 4. Upstream did it too

| Area | Upstream | Fork | Verdict |
|---|---|---|---|
| Subagents | #669/#686, `docs/subagents.md`, `chat_subagent_runs` table, up to 8 per answer, document scoping | `chat/engine/subagents/subagentHost.ts`, Pi `subagents.test.mts`, `general`/`citation_check` types | Redundant. A PR would need to reconcile data models. |
| Web search | #661, provider-native search + API keys | `lib/search/*` engine with 4 providers, citations, reader view | Redundant. |
| Migration ledger | #609/#614 | `20261010_06_schema_migrations.sql` plus `adopt-ledger.sh` | Done. Numbers and file names differ (`20261009_03` vs `20261010_06`). |
| Mac app | #612 | `desktop/` ported | Done. |
| Preset templates | #561 | Ported with licence changes | Done. |
| Password policy, access gaps, signed URLs, uploads outcomes, autosave flush | #529, #603, #584, #381, `90206f5a` | Picks #1, #3, #5, #6, #10 | Done. |
| Resume/recover turns | #530, #532, #615 to #617 | `chat_turn_claims`, re-attach after restart, `docs/resume-interrupted-answers.md` | Overlap. The fork's claim system is its own; do not stack theirs on top. |
| Organization workspaces | #630 and the rest | Nothing equivalent; fork has the older org module only. | Not redundant. A fork PR that touches orgs will collide with upstream's model, and `upstream/olp-pr/word-org-workspaces` (34 files, adds Word chats and memory to org workspaces, 9 commits ahead of upstream/main) is already in flight. |
| Word add-in | #532, #623, #683, `word-org-workspaces` | Refusal messages, model catalog, edit cards, e2e fixtures | Both are active. Check `word-org-workspaces` before any Word PR. |
| Docx editing | `documentOps.ts` edits, concurrent edits, Word client tools | In-memory OpenXML AST, block IDs, revisions, linter | Different design. Upstream's tool schemas are not compatible. |
| Voice, vault, code mode, skills, mobile app, attestation, auto-mode gate, branching | none | fork-only | Fork-only; no upstream equivalent. |

## 5. Recommended sync plan

**Merge estimate.** `git merge-tree --write-tree main upstream/main` exits with conflicts: **243 conflicted paths** (205 content, 25 add/add, 13 modify/delete). By area: `frontend/src/app` 75, `backend/src/modules` 64, `backend/src/lib` 28, `backend/src/__tests__` 12, `desktop` 17, `word-addin` 9, workflows and docs about 12. The count understates the work, because merge-tree does not see semantic breaks. Upstream code imports `lib/supabase.ts` (164 files); the fork removed PostgREST and uses `createDb`/`Db` (`c8d747ec`, `37a95354`). Upstream also keeps the AI SDK loop that the fork deleted (`aiSdk.ts` modify/delete). **Do not run a full merge.** Cherry-pick by theme and port the DB-layer calls.

Order:

1. **Free wins (low risk).** `#537` PDF no-text-layer flag, `#535` addon asset batching, `#396` design tokens (check against `frontend/src/shared`), `#610` test worker cap, `#651` `scripts/stack.sh`, Sentry v11 if wanted. Run `npm test` in each of the three packages after each pick.
2. **StorageAdapter (#403).** Self-contained, only `lib/storage.ts` conflicts.
3. **Hardening review.** Read `#655` (weekly bug review) and `d146998d` follow-ups and apply only the fixes that still apply.
4. **Personalisation (#576, response style/language).** Needs a new migration number in the fork's sequence (the fork's latest is `20261020_02`; upstream's are `20261002_06` to `20261021_04`; renumber, never reuse a filename).
5. **UI features:** side-by-side chats, quote/annotate, text cards. Port by reading the diff, not by cherry-pick, because `ChatView.tsx`, `ChatInput.tsx` and `AssistantMessage.tsx` diverged.
6. **Playbooks (#427, #658, #683).** The biggest prize and the largest port: about 35k lines, 14 migrations, Word add-in changes. Do the DB-layer rename first (`createServerSupabase` to `createDb`), then land backend module, tools, migrations, then UI, then Word.
7. **BYOK providers.** Frontend settings and key tables first; then add the providers to `pi/providers.mts`. Check pi-ai coverage before copying their code.
8. **Org workspaces.** Last, and only if multi-tenant is a goal. It is 20 migrations and touches nearly every list endpoint. If not, skip it entirely.

Skip: Dependabot bulk (regenerate locally), dead-code cleanup, `desktop/`, web search, subagents, docs-only PRs, `#682`.

Risky parts: `schema.sql` (up 4091 lines vs fork 808; regenerate rather than merge, then run `.github/workflows/schema-drift.yml`'s fresh-vs-upgraded check); `chat.routes.ts`, `streaming.ts`, `toolDispatcher.ts`; migration number clashes (fork and upstream both use `20261007_01`, `20261009_01`, `20261009_02` and `20261012_01` with different content; renumber the upstream ones on import); `package-lock.json` in four packages; add-in `tsconfig`/webpack.

Bookkeeping option: after the picks, record the sync with `git merge -s ours upstream/main` so the merge base moves and later `git log main..upstream/main` and `merge-tree` only show new work. This hides anything not yet ported, so write the skip list down first (this file).

## 6. Upstream contribution norms

From `upstream/main:CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `AGENTS.md`, `SECURITY.md`:

- **Issue first, depending on size.** A change that touches multiple subsystems, the data model, or public API/behaviour needs a PRD issue first (template "New PRD", `docs/templates/PRD.md`, 1 to 2 pages). Small well-understood fixes need only a plain issue. The Organizations, Playbooks and provider PRs are the kind that need a PRD.
- **Size.** "Small, focused, easy to review". One bug, feature or cleanup per PR. Prefer targeted edits over broad refactors. In practice the maintainer's own PRs are huge, but outside PRs are expected to follow this.
- **PR body.** Sections: Summary, Why/Motivation, Changes, Tradeoffs and risks, How verified (exact commands), and a checklist (ran build/tests, reviewed `git diff`, updated docs/env examples, no secrets). Markdown.
- **Tests.** Required at the lowest useful layer: unit, then route integration, then Playwright only if a browser is needed. CI runs build, unit and integration tests on every PR, and Playwright in a full local stack. `npm test` must be green with no keys.
- **Compatibility.** Must stay compatible with Docker Compose, Supabase, S3-compatible storage and Ollama. Explain new infrastructure or migrations in the same PR.
- **Migrations.** `YYYYMMDD_NN_<name>.sql`, `-- Migration date:` header, re-runnable, update `backend/schema.sql` and the `schema_migrations` list, no `begin`/`commit`.
- **Layering and UI rules.** `backend/src/__tests__/architecture.test.ts` enforces module layering; UI must use existing primitives, design tokens and the accessibility baseline; errors go through `describeError`/`notifyError`, and any client-handled error `code` must be listed in `CODE_KINDS`.
- **No CLA or DCO** file exists in the repo, and no CODEOWNERS. The licence is AGPL-3.0. Security issues go through GitHub private advisories, never public issues.
- **Branch names.** Descriptive prefix (`feat/`, `fix/`, `docs/`...). Do not use `claude/` (the maintainer's own agent branches do, so this is for contributors).
- **Practical consequence for fork PRs.** Branch from `upstream/main`, not from the fork. The fork's code assumes `createDb`, Pi and the brand module, none of which exist upstream, and upstream's `AGENTS.md` still describes `lib/supabase.ts` and the AI SDK. Open a plain issue for any small fix and a PRD issue for anything larger. The fork's hardening fixes, documents work (OpenXML block tools), citation checks, and Word refusal handling are the likeliest candidates, since upstream has no equivalent for them. Check `upstream/olp-pr/word-org-workspaces` and the open Playbooks work before touching Word or org code.
