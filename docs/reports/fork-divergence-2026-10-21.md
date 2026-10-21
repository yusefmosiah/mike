# How this fork differs from upstream, 2026-10-21

This report triages every change on our `main` since we forked from
[open-legal-products/mike](https://github.com/open-legal-products/mike). It
also reviews what upstream did in the same period, and from both it lists
what we could contribute back once our code is stable.

- **Fork point:** `9a0a0a5b` (upstream PR #594, 2026-10-07).
- **Our side:** `main` at `17696ea6`, with 304 non-merge commits (297 by the
  owner). They change 1,571 files, +193k / −16k lines.
- **Upstream:** `upstream/main` at `795f9608` (2026-10-21), with 232
  non-merge commits. They change 1,452 files, +171k / −30k lines.
- **Overlap:** 489 files were changed on both sides. A trial merge
  (`git merge-tree`) gives 243 conflicted paths: 205 content conflicts, 25
  add/add and 13 modify/delete.

Method: five Sonnet subagents each triaged one area of our commits, and a
sixth reviewed upstream. I cross-checked their reports and merged them here.
The areas were: the engine and model layer; documents and files; product
scope and web UI; voice and the native apps; and platform and quality.
Nothing in the tree was changed to make this report.

## 1. Summary

- **Most of what we did is additive as a feature, but not as code.** About
  two thirds of our change clusters are new capability with no upstream
  equivalent: Word documents edited as real tracked changes, one document
  model for every format, image and text uploads, and citation checking. It
  also covers attested model lanes, the Python code mode, per-user
  workstation VMs, the secrets vault, conversation branching, shared-thread
  handoff, speech, and the iPhone and Android apps. But much of that is
  *implemented* on our replacements, Pi most of all. Branching, durable
  turns, handoff, code mode, subagents, image delivery and voice turns all
  rely on Pi. Section 3.1 lists what each feature is built on, and what it
  would cost to rebuild on upstream's loop.
- **Much less was removed than it seems.** The "legal focus" we took out is
  framing only. The prompts, start screen and tab title no longer assume a
  lawyer, and the signup questionnaire is gone. The legal workflows,
  practice options, CourtListener tools and contract templates are all still
  here. Everything else we removed is local policy: most per-IP rate limits,
  scheduled CI runs, model calls in CI, and the Mac app's "Start on this Mac"
  mode (it runs the whole stack inside the app; see the Mac app row below).
- **The large replacements are what make merging hard.** Three changes swap
  out an upstream mechanism:
  - Pi Durable replaced the Vercel AI SDK loop.
  - A direct Postgres client replaced supabase-js and PostgREST (about 540
    backend files).
  - A package-preserving OpenXML model replaced the substring-based Word
    edit engine.

  Upstream kept all three of its versions and built a lot on them.
- **Upstream went another way.** It is building a multi-tenant team product:
  - organizations and workspaces (about 100 commits);
  - Playbooks (about 35k lines);
  - subagents and web search;
  - more bring-your-own-key cloud providers;
  - crash and turn recovery.

  None of its work moves toward our differentiators. Two of its features,
  subagents and web search, duplicate ours.
- **Do not merge upstream.** A few small pieces are worth taking, personalisation above all (section 7).
- **Contribute back in small pieces, branched from `upstream/main`.** About
  ten small PRs are possible once the code is accepted. The three big
  replacements are not PRs. Upstream runs its loop in production, so they
  are at most a conversation with the maintainer (section 8).

## 2. Buckets

| Bucket | Meaning |
|---|---|
| **ADDITIVE** | New capability; upstream has nothing equivalent. |
| **SUBTRACTIVE** | Removes or narrows something upstream has. |
| **MIXED** | Replaces an upstream mechanism with ours: removes theirs and adds ours. |
| **FIX** | A bug fix or hardening, including fixes ported from upstream. |

Each cluster also has a **readiness** for upstream:

| Readiness | Meaning |
|---|---|
| **READY** | Could be a small PR once accepted. |
| **NEEDS-WORK** | Worth offering, but needs a rebase, a split, a flag or a decoupling first. |
| **RFC** | Needs a design issue (upstream calls it a PRD) before any code. |
| **FORK-ONLY** | Our product choice or our infrastructure. |

Its **maturity** is one of:

| Maturity | Meaning |
|---|---|
| shipped+tested | On staging with tests. |
| experimental | Built and tested, not field-proven. |
| incomplete | Still in progress. |

Note: `goals/STATUS.md` says nothing from 2026-10-10 onward has been accepted
by the owner yet. So "shipped" means deployed to our staging, not signed off.

## 3. Every change, by bucket

Some features cross areas. They are listed once, with the area reports that
cover them in brackets: E = engine, D = documents, U = product and UI, V =
voice and apps, P = platform. The full per-cluster detail (commits, paths,
dependencies) is in the area reports in
[`fork-divergence-2026-10-21/`](fork-divergence-2026-10-21/).

### 3.1 What the additive work is built on

A feature can be new to upstream while our code for it still stands on one
of our replacements. Porting cost depends on which one:

- **Pi.** Expensive. Upstream's loop keeps earlier turns as text only. It
  does not keep their tool calls and results, which is why its prompt tells
  the model to re-read every document each turn. Features that need the
  conversation's real history (branching, resume, compaction, handoff) have
  nothing to attach to there.
- **Db.** Cheap. Our client keeps supabase-js's call shape (`.from()`,
  filters, `.rpc()`), so most of a port is a type rename and a re-cut
  migration.
- **VM.** Not portable. Upstream has no execution host.

| Feature | Built on | Port to upstream means |
|---|---|---|
| Conversation branching (edit, regenerate, fork) | Pi (each branch is a Pi conversation), Db | Upstream's loop has no transcript to fork. A text-only tree could exist there, but it would be a new design. |
| Durable turns, resume, compaction | Pi | Rebuilding their loop |
| Shared-thread handoff, turn claims | Pi turn lifecycle, Db | The claim table ports. Re-attaching and stopping a turn need their loop's equivalent. |
| Code mode | Pi dispatcher, VM | Not portable without both |
| Subagents | Pi | Upstream has its own |
| Images in | Pi (image parts), model catalog | The cleaning and sizing port. Delivery must be rewritten for the AI SDK. |
| Voice turns, spoken answers | Pi (`runtime.mts`, `chat.spoken.ts`) | The client ports. The server edge must be rewritten. |
| Attested lanes | `pi/providers.mts` | The verifier ports. The hook must be rewritten. |
| Citation checking | Db, job queue (upstream has `lib/dbq` too), our search, DOCX anchors | Moderate. A new module, plus a port from `Db` to supabase-js. |
| Skills, text uploads, dictation vocabulary | Db, migrations | Cheap |
| Dictation and read-aloud (server lane) | `lib/egress`, `lib/privateMode` | Cheap once the privacy hooks are stubbed |
| DOCX library, fixtures, OCR, injection flags, brand package, Mac title bar and fuses | Nothing of ours | Cheapest. These are the real PR candidates. |
| Workstation sync, vault | VM | Not portable |

### Subtractive

| Change | What it does | Readiness | Conflict |
|---|---|---|---|
| General-purpose framing [U-A, E13] | The prompts open as "an open-source AI agent for knowledge work", not a legal assistant. Contract-drafting rules apply only when drafting a contract. The start screen's legal-advice line and the "Legal AI Platform" tab title are gone. The reason: models were refusing ordinary questions. | FORK-ONLY | med |
| No onboarding questionnaire [U-C] | Removed the profile and practice onboarding pages. Every sign-up path lands in the assistant, and old URLs redirect. | FORK-ONLY | high (upstream built org onboarding on these pages) |
| Rate limits [P4] | Removed the per-IP limits except on authentication and upload sessions. The reason: scripted replays from one office IP hit 429 errors. | FORK-ONLY | med |
| CI scope [P3] | CI never calls a model, and there are no scheduled runs (nightly e2e, CodeQL, Scorecard, mutation). | FORK-ONLY | high |
| Mac app without "Start on this Mac" [V9] | `desktop/` is upstream's Electron app (#612), pointed at our server. We removed its self-contained mode, in which the app runs the whole stack on the Mac with no Docker. That stack is Postgres 17, GoTrue, PostgREST, the backend, the Next server, a gateway, filesystem storage and the workflow catalog, under a supervisor, with a local guest account. The removed parts are `desktop/src/local/` (15 files), 7 build scripts, the first-run and local-boot pages and the preload channels. Owner direction on 2026-10-10 was "the wrapper first, local mode later". | FORK-ONLY | high (add/add on every file) |

The following were **not** removed: workflows, practice lists, CourtListener,
the legal contract templates, and the Personalisation practice options (now
in Settings).

### Mixed (replaces an upstream mechanism)

| Change | What it replaces | Readiness | Maturity | Conflict |
|---|---|---|---|---|
| Pi Durable runtime [E1] | The Vercel AI SDK tool loop and provider glue, which are deleted. Chat turns are stored in Postgres and need `DATABASE_URL`. | RFC | shipped+tested | high |
| Durable turns, resume and compaction [E2] | The request-scoped turns. Now a turn survives a restart, re-attaches open clients, compacts its context, and continues an interrupted answer. | RFC (with Pi) | shipped+tested | high |
| Direct-Postgres `Db` client [P1] | supabase-js and PostgREST. A chainable builder over `pg` matches PostgREST's results, and a conformance suite was recorded against PostgREST v14.12. | RFC (opt-in) | shipped+tested | high |
| GoTrue-only auth [P2] | `@supabase/ssr` and supabase-js. We use `@supabase/auth-js`, and the backend writes the session cookies in the same format. | NEEDS-WORK (after P1) | shipped+tested | high |
| Compose and CI on Postgres and GoTrue [P3] | The PostgREST, gateway and Supabase CLI services in Compose, CI and e2e. | FORK-ONLY | shipped | high |
| DOCX model and tracked-change editing [D-A] | `applyTrackedEdits` and `resolveTrackedChange`, plus the `edit_document`, `read_document` and `find_in_document` tool schemas. | NEEDS-WORK (library first) | shipped+tested | high |
| Durable Word and review-chat turns [D-H] | The generation loops inside the Word and tabular routes. They now use Pi, a turn claim and one reconnect policy. | FORK-ONLY | shipped+tested | high |
| Word add-in changes [D-M] | Refusal messages, model grouping, the brand name and reconnects. | FORK-ONLY | shipped+tested | high |
| Model catalog and routes [E3] | Upstream's model list. Adds OpenCode Go as a first-class lane, River models declared by config, models grouped by provider, and flash models as defaults for volume work. | NEEDS-WORK | shipped+tested | high |
| Subagents on Pi [E8] | A `delegate` tool. Upstream shipped its own under the same name (#669, #686). | FORK-ONLY (duplicate) | shipped+tested | high |
| Web search engine [E9] | Upstream's #661. Ours is Keenable, Tavily, Exa and Parallel, with an SSRF-safe fetcher and page snapshots. | FORK-ONLY (duplicate) | shipped+tested | high |
| One shared `ChatThread` [U-F] | Separate assistant and project chat views. Project chat shrank by about 435 lines. | NEEDS-WORK / RFC | shipped+tested | high |
| Streaming scroll and composer keys [U-H] | Scroll following and Enter to send. Now Enter adds a newline and Cmd/Ctrl+Enter sends. | NEEDS-WORK (the key change needs a setting) | shipped+tested | high |

### Additive

**Engine and models**

| Change | Readiness | Maturity | Conflict |
|---|---|---|---|
| Strict private mode, attested lanes, receipts (Phala ACI, pinned measurement, receipts in `audit_events`) [E4] | NEEDS-WORK | shipped+tested | low |
| Python code mode: one `run_python` tool, every other tool reached from a persistent kernel [E5] | NEEDS-WORK (flag; non-VM path) | experimental | med |
| Workstation VMs per account (Cloud Hypervisor, snapshot per turn, logging egress proxy) [E6, P9] | FORK-ONLY | experimental | low |
| Auto Mode gate, guardrails library, eval corpus, prompt-injection flags [E7] | NEEDS-WORK (injection flags and corpus separable) | mixed: the per-call gate was retired as the safety mechanism | med |
| Skills in the standard `SKILL.md` format: import, versions, Skill tab, save from chat [E10, U-E] | NEEDS-WORK | experimental | low-med |
| Images in, for models that can see (sanitised with `sharp`, sized per model, "Sees images", refusal) [E11, D-D] | NEEDS-WORK | shipped+tested | med |
| Shared-thread handoff: database turn claim, presence, sender-only stop, `/nr` notes [E12, U-I] | NEEDS-WORK | shipped+tested | med |
| Vault tools and inline citations at the claim [E15] | NEEDS-WORK | shipped+tested | med |
| Conversation branching UI: edit in composer, regenerate, branch navigator, fork to a new chat [U-G] | RFC | shipped+tested | high |

**Documents**

| Change | Readiness | Maturity | Conflict |
|---|---|---|---|
| Word-authored DOCX fixture corpus and accept/reject oracle (5.5 MB, licences recorded) [D-B] | **READY** | shipped+tested | low |
| One block model for Word, PDF, Markdown, text, spreadsheets and slides; read from Python as `docs` [D-C] | NEEDS-WORK | shipped+tested | med |
| Plain-text uploads (.txt, .md, .csv) and `TextView` [D-E] | NEEDS-WORK | shipped+tested | med |
| Document citation checking: durable job, snapshots, quote match, judge model, six verdicts [D-F] | NEEDS-WORK | shipped+tested | med |
| Web-citation reader: saved page in the panel, quote highlighted [D-G, U-K] | NEEDS-WORK | shipped+tested | high (upstream's web search differs) |
| Local OCR for scanned PDFs; hybrid retrieval (dormant, no routes) [D-I] | NEEDS-WORK (OCR only) | experimental | med |
| User documents synced read-only into the workstation; `save_to_mike` [D-J] | FORK-ONLY | shipped+tested | low |
| Secrets vault: browser-sealed, leases, host allowlists, echo scrubbing [D-K, P9] | FORK-ONLY | shipped+tested | low |
| Diligence job and `execute_code` sandbox [D-L] | FORK-ONLY (unmounted, superseded by code mode) | incomplete | low |

**Product and web UI**

| Change | Readiness | Maturity | Conflict |
|---|---|---|---|
| Brand package: the product name from one file, enforced by a test [U-B] | RFC (white-labelling) | shipped+tested | high (about 90 strings) |
| Phone web layout: chat-first project workspace, slide-over panes, 16 px focus-zoom floor, swipe sidebar [U-J] | NEEDS-WORK (browser-only parts) | shipped+tested | med |
| Image, text/Markdown and web-page viewers [U-K] | NEEDS-WORK | shipped+tested | low-med |
| Timeline blocks for code cells, approvals, subagents and citation checks [U-L] | FORK-ONLY until the backends are decided | shipped+tested | high |
| Model picker grouping and the vision indicator [U-M] | NEEDS-WORK | shipped+tested | med |

**Voice and native apps**

| Change | Readiness | Maturity | Conflict |
|---|---|---|---|
| Backend `audio` module: dictation and read-aloud through an OpenAI-compatible speech operator, plus an OpenRouter lane [V1] | NEEDS-WORK (strip private-mode coupling) | shipped+tested | low |
| Web dictation and read-aloud: mic in the composer, seekable read-aloud player [V2] | NEEDS-WORK | shipped+tested | high |
| In-browser speech models, Settings → Voice, test bench [V3] | NEEDS-WORK (heavy new dependencies) | experimental | med |
| Dictation vocabulary [V4] | NEEDS-WORK | shipped+tested | med |
| iPhone app shell (Capacitor) [V5] | FORK-ONLY as is | experimental (simulator, unsigned) | med |
| On-device speech plugin (Fluid Speech Mini, Phonon; iOS and Android) [V6] | NEEDS-WORK (better as its own package) | experimental | low |
| Hands-free voice mode (iPhone engine and web conversation) [V7] | not PR-ready | **incomplete** (untuned, not device-verified) | high |
| Android app [V8] | FORK-ONLY | experimental | low |

**Platform and quality**

| Change | Readiness | Maturity | Conflict |
|---|---|---|---|
| Scripted OpenAI-compatible model server and new e2e specs (branching, chat scroll, handoff, mobile, web reader); Mac-app e2e [P5] | NEEDS-WORK | shipped | med |
| Replay simulator, stack tests, Vitest under the React Compiler [P6] | NEEDS-WORK | shipped / experimental | low-med |
| 21 fork migrations, each owned by a feature [P7] | FORK-ONLY until the feature is contributed | shipped | high (filename clashes) |
| Staging on node-a, deploy by SHA with rollback [P8] | FORK-ONLY | shipped | low |
| Goals, reports, docs, AGENTS.md rewrite [P11] | FORK-ONLY | shipped | low-med |

### Fixes

| Change | Status upstream | Readiness |
|---|---|---|
| Tool-round limit as a runaway backstop; read-only lookups in a round run in parallel, writes in order [E14] | Not upstream | READY to rebase |
| Early tool-call detection flushes the text tail; long-thread repairs [E14] | Not upstream, but Pi-specific | FORK-ONLY |
| Preset-template licence cleanup: two Common Paper files with no licence notice dropped, per-file Bonterms licences recorded [U-D] | **Upstream still ships the two files** | READY for the files and docs; the picker code must be redone on upstream's new page |
| Mac title-bar drag strip; Electron fuses locked in the release build [V10] | Not upstream | READY |
| Google OAuth authorize URL uses the public auth address [P2] | Verify first | READY if upstream has the bug |
| Dev-only trust for private-network origins [P4] | Not upstream | NEEDS-WORK (security review) |
| Steps stay in one card across blank text; a reasoning block stays open after streaming [U-N] | Check against upstream | READY after checking |
| Ported from upstream: access and confirmed-email hardening, MCP SSRF, password policy, migration ledger, upload outcomes, waiting replies, signed download URLs, memory autosave flush, small UI [P10, U-N] | **Already upstream** (see `upstream-picks-2026-10-10.md`) | Not PRs |
| Lockfile audit bumps [P10] | Upstream has equal or newer versions | Not PRs |

## 4. Upstream since the fork

### Who and how fast

- Upstream has one main maintainer. Will Chen wrote 153 of the 232 commits,
  and his Claude agent wrote another 32.
- `mlx` contributed about ten very large PRs: the Mac app, auth policy,
  workspace crash recovery, Word and tabular recovery, the storage adapter,
  Google scopes, Playbooks parity, and `migrate.sh`.
- Outside contributors added:
  - subagents and web search (Charles Becker);
  - Playbooks (duncanmcqueen, 20k lines);
  - the PDF no-text-layer flag and add-in asset batching (trinitrion);
  - signed URLs (terpstra-209);
  - reasoning replay (James Gauci).
- The pace is about 15 commits a day, with peaks of 34.

### Themes, heaviest first

| Theme | What it is | Take into the fork? |
|---|---|---|
| Organizations and workspaces (#630, #649, #631, about 100 commits, 20 migrations) | Personal org per account, workspace switcher, owner role, org keys and model lists, private-by-default work, member handover, audit log, photos | Last, and only if we want multi-tenant |
| Playbooks (#427, #658, #683, #673; about 35k lines, 14 migrations) | Clause-review workspaces, reviews in the pane and detached, History, Word support | Yes, adapted. This is the biggest feature we lack. |
| Agentic chat | Subagents (#669, #686), web search (#661), text cards (#656), quote and annotate, side-by-side chats (#623, #624) | Skip subagents and search (we have both). Adapt the chat UI features. |
| Bring-your-own-key providers (#608, #601, #534) | Bedrock, Azure OpenAI and Foundry, Vertex, xAI, Mistral, custom endpoints, reasoning replay | Adapt the settings UI and key tables; rebuild the providers on `pi/providers.mts` |
| Reliability (#531, #530, #532, #615–#617) | Crash screens, Word and tabular turn recovery, input caps, provider deadlines | Take the Word recovery and the crash boundary. Skip the turn recovery (we have turn claims and resume). |
| Storage adapter (#403, #607) | `StorageAdapter` with S3 and filesystem backends | Yes. It is isolated. |
| Personalisation (#576) | Custom instructions, response style and language | Yes, adapted |
| Distribution (#612, #653, #671, #682) | Mac app, minimal Google scopes, Sentry moved to the org | Skip the Mac app (we have it). Take the Google scopes only if we keep the connectors. |
| Hygiene (#606, #626, #602, #396) | Dead code, `noUnusedLocals`, merged review tables, design tokens | Skip, except the tokens (#396) |
| Small fixes (#537, #535, #610, #651) | PDF no-text-layer flag, add-in asset batching, Vitest worker cap, `scripts/stack.sh` | Yes, first |
| Dependabot (19 commits), Sentry v11 | Version bumps | Regenerate locally instead |

### Both sides built the same thing

| Feature | Upstream | Ours | Verdict |
|---|---|---|---|
| Subagents | #669, #686, `chat_subagent_runs` | `chat/engine/subagents/` on Pi | Duplicate. Keep ours; borrow their UI pills. |
| Web search | #661, `lib/webSearch` | `lib/search` with 4 providers and snapshots | Duplicate. Our extra adapters could go in behind their interface. |
| Migration ledger | #609, #614 | Ported by hand, with different filenames | Done |
| Mac app | #612 | Copied, without local mode | Done |
| Turn recovery | #530, #532, #615 | Turn claims and resume after a restart | Overlap. Do not stack theirs on ours. |
| Word editing | `documentOps.ts` edits | OpenXML block model | Different designs, and the tool schemas are incompatible |

Upstream has nothing like our voice work, vault, code mode, workstations,
skills, phone apps, attestation, Auto Mode gate or branching.

## 5. Where the two sides collide

Ranked by the smaller side's churn in lines since the fork (upstream / ours):

| File or area | Up / ours | Why |
|---|---|---|
| `backend/schema.sql` | 4091 / 808 | Upstream added orgs, Playbooks, subagents and web search. We added branching, workstations, citation checks and the ledger. Regenerate it rather than merge it. |
| `frontend/.../assistant/ChatView.tsx` | 907 / 768 | Upstream added side chats, quote and text cards. We added branching, voice, resume and mobile. |
| `frontend/src/app/lib/mikeApi.ts` | 1556 / 887 | Both sides added in the middle of a long file |
| Project chat page and its test | 1230 / 654 | Same split as `ChatView` |
| `chat/engine/` (`streaming.ts`, `toolDispatcher.ts`, `documentOps.ts`, `contextBuilders.ts`) | high / high | Different architectures (AI SDK and delegate, against Pi, OpenXML and parallel rounds). Never merge these as text. |
| `lib/llm/*` | ~700 / ~1050 | We deleted `aiSdk.ts` and `providers.ts`; upstream extended them |
| `chat.routes.ts`, `chat.prepare.ts` | 166 / 943 | We rewrote turn handling |
| `desktop/` | ~3000 / ~3000 | The same app on both sides, 12 add/add conflicts |
| Migrations | 57 upstream / 21 ours | Clashing filenames: `20261007_01`, `20261009_01`, `20261009_02`, `20261012_01`, `20261020_01`. Renumber on every import. |
| Lockfiles (4 packages) | 2k–8k | Take one side and regenerate |

Two semantic breaks are not visible to `merge-tree`. Upstream code imports
`lib/supabase.ts` (in 164 files), which we deleted. Upstream also calls the
AI SDK loop, which we removed. So every upstream backend change needs porting
to `Db` and Pi, not just conflict resolution.

## 6. What the "subtractive" changes cost us

The subtractive changes are cheap to keep: they are local choices on small
surfaces. What costs us is the three MIXED replacements (Pi, direct
Postgres, the OpenXML engine). They are why most upstream work arrives as a
port rather than a cherry-pick, and why most of our work can only go upstream
as a library or behind a flag.

## 7. Taking from upstream

The owner is not planning to take upstream's large features. The organization
model, Playbooks, bring-your-own-key providers and chat UI features are
listed in section 4 for reference only. What follows is the short list worth
a look, checked against our tree on 2026-10-21. Nothing is being merged now.
[Watching upstream](../upstream-watch.md) tracks every upstream addition from
here on. Do not run
`git merge upstream/main`. Give every imported migration a new number in our
sequence.

| Upstream | What it is | Applies to us? | Verdict |
|---|---|---|---|
| #576 Personalisation | Settings → Personalisation gains three things. **Custom instructions** is free text added to every prompt. **Response style** sets length (concise, balanced, detailed), structure (fewer or more headers and lists) and tone (formal, balanced, plain). **Response language** is a fixed language or "auto". The settings are stored sparsely in one JSON column, so a new option needs no migration. About 700 backend and 760 UI lines, with tests and 2 migrations. | We have none of it. We only have a rule that answers follow the person's language. | **Interested in the idea**, built our own way (owner, 2026-10-21). Their language setting would override our rule. |
| #610 Vitest worker cap | Caps parallel test workers, so running both suites cannot exhaust a laptop (38 lines) | Neither of our configs caps workers | **Take.** It is cheap, and this machine has already hit swap. |
| #396 Design tokens | One token file shared by the web app and the add-in, with a test against drift | Our add-in's `tokens.css` is still a 159-line hand copy | **Take**, if the add-in stays |
| #651 `scripts/stack.sh` | Starts and stops Compose stacks and garbage-collects old ones from this repo (worktrees, review stacks) | Our compose file has the same "MikeOSS" marker the script keys on | Optional; useful if leftover stacks pile up locally |
| #655 Weekly bug review | Access lookups in tabular reviews, projects and chat report a failure instead of carrying on; bounded lookups; saved review cells kept | The same code paths exist here, but have diverged | Read it and port the fixes that still apply. Medium effort. |
| #537 PDF no-text-layer flag | Flags textless PDFs in the list and tells the model | Our local OCR already reads scanned PDFs | Low value. At most the list flag, for pages OCR could not read. |
| #535 Add-on asset batching | Splits a query whose PostgREST URL grew past nginx's limit | We have no PostgREST or gateway | **Does not apply** |
| #612 Mac app local mode | See the Mac app row in section 3 | We removed it | **Worth a look** if a no-server Mac app is wanted. Our stack is easier to bundle than theirs: Postgres, GoTrue, backend and Next, with no PostgREST and no gateway. |

**Bookkeeping.** After the picks, `git merge -s ours upstream/main` would move
the merge base, so later reviews show only new upstream work. The cost is
that it hides anything not yet ported, so keep this report's skip list as the
record.

## 8. Contributing back

### Upstream's rules (from its `CONTRIBUTING.md`, PR template and `SECURITY.md`)

- **Issue first.** Open a plain issue for a small fix. Open a PRD issue
  (`docs/templates/PRD.md`, 1–2 pages) for anything that touches several
  subsystems, the data model, or public behaviour.
- **PR shape.** Small and focused. The body has Summary, Why, Changes,
  Tradeoffs and risks, How verified, and a checklist.
- **Tests.** Required at the lowest useful layer. `npm test` must pass with
  no keys.
- **Compatibility.** Must keep working with Compose, Supabase, S3 storage and
  Ollama.
- **Licence and process.** No CLA, DCO or CODEOWNERS. AGPL-3.0. Security
  reports go through private advisories.
- **Branches.** Descriptive prefixes, never `claude/`.

What this means for us:

- Branch every PR from `upstream/main`, not from our `main`.
- Write against `lib/supabase.ts` and the AI SDK.
- Use their literal product name (they have no brand package).
- Renumber migrations after their latest.
- Before any Word or org work, check `upstream/olp-pr/word-org-workspaces`
  (in flight: Word chats and memory for org workspaces).

### Before any PR: when is "stable"?

1. The owner accepts the feature, so `goals/STATUS.md` moves it past
   "shipped, not accepted".
2. It has run on staging with real use for a while, with no follow-up fixes.
3. We can name its smallest slice that does not need Pi, the workstation or
   the brand package (a `Db` dependency is a cheap port; see section 3.1).
   If no such slice exists, it is not a PR.

### Shortlist

**Small PRs** (an issue each, then a PR):

| # | PR | From | Size | Notes |
|---|---|---|---|---|
| 1 | Drop two bundled templates with no licence notice; record each template's own licence | `d617576e` | files, docs, generator | A real licensing finding for upstream. Raise the issue now, whatever our stability. The picker part must be redone on their `PresetTemplatesPage`. |
| 2 | Add a Word-authored DOCX fixture corpus and an accept/reject oracle | D-B | test assets only (5.5 MB) | Zero runtime risk. It unblocks the DOCX work. |
| 3 | Lock down Electron fuses in the signed Mac build | `363f99a4` | 7 lines | Their `electron-builder.release.json` has no fuses |
| 4 | Keep a draggable title-bar strip under the Mac traffic lights | `91c369a3` | about 50 lines and a test | `AppSidebar.tsx` is busy upstream, so expect a mechanical rebase |
| 5 | Flag prompt-injection attempts in tool results (warning only, off by default) | `36604642` | small | Model-agnostic, needs no Pi |
| 6 | Run a round's read-only tool calls in parallel and its writes in order; make the round limit a runaway backstop | `6f44db13`, `80c6e3f7` | medium | Rebase onto their dispatcher |
| 7 | Google sign-in uses the public auth address | P2 | small | Only if their Compose has the bug |
| 8 | Keep a run of steps in one card; keep a finished reasoning block open | `84551885`, `5cb5b7c1` | small | Check against their current files |

**Features** (a PRD issue each, then a PR, roughly in this order):

| # | Feature | Slice to offer |
|---|---|---|
| 9 | Package-preserving DOCX reader and block model | `lib/docx` and `documentModel/fromDocx`, wired to read and find. The tracked-change edit engine follows behind a flag. |
| 10 | File intake | Image uploads for models that can see, plain-text uploads, their viewers, one re-cut migration. Delivery ported to their provider layer. |
| 11 | Citation checking in documents | After #9, so quotes anchor to block ids |
| 12 | Local OCR for scanned PDFs | On top of their text-layer detection; not the retrieval module |
| 13 | Chat-first phone layout | The browser-only parts: pane drawers, focus-zoom floor, closing the sidebar after navigation |
| 14 | Skills in the standard `SKILL.md` format | Import, versions and the Skill tab, without the workstation sync. Must explain how skills relate to Playbooks. |
| 15 | Dictation and read-aloud through a server speech operator | Only after the voice work settles. The `audio` module without OpenRouter or private mode, the mic, and read-aloud. The vocabulary is a follow-up. |
| 16 | Attested gateway verification and receipts | Behind a provider-wrapper hook that works with either loop |
| 17 | Keyless e2e chat via a scripted OpenAI-compatible model server | Offered as a protocol-neutral alternative to their Anthropic fixture |
| 18 | Auto Mode eval corpus and decision-model harness | Evidence and tooling only |

**Not PRs: a conversation with the maintainer, if he wants it.** Upstream
runs its loop in production, so we do not propose replacing it. The useful
evidence is what our loop does differently. At the fork, and still on
`upstream/main` (`contextBuilders.ts`), earlier turns go back to the model as
text only. Their tool calls and results are dropped, and a one-line
`[Tool activity in your previous turn]` note is added to the last answer. The
prompt says "You do NOT retain document content between conversation turns.
You MUST call read_document … at the start of every response", so a document
is re-read every turn. Upstream has since added stored-reasoning replay
(#534) for some models, but not tool results. Pi keeps the whole transcript
and compacts it when needed. Topics, if he is interested:

- Pi Durable, or just the idea of replaying tool results with compaction.
- The direct Postgres client and its PostgREST conformance suite.
- Conversation branching and shared-thread handoff, which rest on the above.
- The Python kernel for code mode.
- White-labelling through a brand package.

**Not offered:**

- Product choices: the general-purpose framing, the onboarding removal, the
  rate-limit removal, and our CI scope.
- Copies of upstream's own work: our `desktop/` tree.
- Our infrastructure: workstation VMs, the vault, node-a, home egress and
  backups.
- Still unfinished: hands-free voice mode, the iPhone and Android shells as
  they are, diligence and retrieval.
- Duplicates of upstream features: subagents and web search.
- Tied to Pi: durable Word and review turns, and our Word add-in changes.

## 9. Sources

- Area reports, with commits, paths and dependencies for every cluster:
  [engine](fork-divergence-2026-10-21/engine.md),
  [documents](fork-divergence-2026-10-21/documents.md),
  [product and UI](fork-divergence-2026-10-21/product-ui.md),
  [voice and apps](fork-divergence-2026-10-21/voice-apps.md),
  [platform](fork-divergence-2026-10-21/platform.md), and the
  [upstream review](fork-divergence-2026-10-21/upstream.md). Where they
  disagree with this summary, this summary wins: it was cross-checked
  against all six.
- Upstream picks already taken: `docs/reports/upstream-picks-2026-10-10.md`.
- Status and acceptance: `goals/STATUS.md`, `goals/TRIAGE.md`.
- The merge estimate: `git merge-tree --write-tree main upstream/main`, run on
  2026-10-21 against `795f9608`.
