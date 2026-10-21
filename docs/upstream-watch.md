# Watching upstream

We forked [open-legal-products/mike](https://github.com/open-legal-products/mike)
at `9a0a0a5b` (2026-10-07). This file records what upstream adds and what we
think of each addition. It does not mean we will take any of it. Nothing
here gets merged without a decision. For the full comparison, see
[How this fork differs from upstream](reports/fork-divergence-2026-10-21.md).

**Last reviewed:** `795f9608` (2026-10-21).

To review again:

```bash
git fetch upstream main
git log --first-parent --format='%h %ad %s' --date=short 795f9608..upstream/main
```

Then add the new PRs below and move the "Last reviewed" line.

## Status key

| Status | Meaning |
|---|---|
| **Taken** | Already ported into our `main` (see [upstream picks](reports/upstream-picks-2026-10-10.md)). |
| **Interested** | Worth taking or copying the idea; not scheduled. |
| **Noted** | No plan. Look again if our direction changes. |
| **Duplicate** | We built our own. |
| **N/A** | Does not apply to our stack. |

## Upstream additions since the fork

### Chat and assistant

| PR | What | Status |
|---|---|---|
| #576 | Personalisation: custom instructions, response style (length, structure, tone), response language | **Interested**, as an idea; we would build our own. Upstream rebuilds the system prompt on every request (base prompt, then the personalisation text, then the time note and the document list) and sends earlier turns as text. Its personalisation sits in the system prompt, not in each user message. Ours would go in the system prompt too, which stays the same for the whole chat; per-turn context goes in a separate section. Also folds in several fixes we took (autosave flush, waiting replies, small UI, inherited-access members). |
| #669, #686 | Subagents (`delegate`), subagent pills, optional response details | Duplicate |
| #661 | Web search in chats | Duplicate |
| #656 | Inline copyable text cards | Noted |
| #623 | Quote and annotate responses, shared chat UI for web and Word | Noted |
| #624 | Side-by-side chats | Noted |
| #534 | Replay stored reasoning to opted-in models | N/A: Pi keeps the whole transcript |
| #615, #616, #617 | Turn-scoped Retry, provider and stream deadlines, input caps | Noted: we have turn claims and resume |

### Documents, reviews and Word

| PR | What | Status |
|---|---|---|
| #427, #658, #683, #673 | Playbooks: clause-review workspaces, reviews in the pane and detached, History, durable jobs, Word support | Noted |
| #645 | Document text search, workspace-scoped History, sharing controls | Noted |
| #530 | Tabular chat turn recovery and failure notices | Noted |
| #532 | Word add-in session recovery, replayed edits | Noted |
| #537 | Flag PDFs without a text layer | Noted: our OCR reads them |
| #535 | Batch add-on asset lookups | N/A: fixes a PostgREST URL limit |
| #561 | Preset contract templates | Taken (we dropped two unlicensed files) |
| #381 | Per-file upload outcomes | Taken |

### Organizations and accounts

| PR | What | Status |
|---|---|---|
| #630, #631 | Personal organizations, workspace switcher, owner role, org keys and models | Noted |
| #649 | Workspace boundaries in the assistant and Word | Noted |
| #635 and about 14 direct commits (2026-10-14) | Profile photos, org logos, org audit log, recoverable deletion | Noted |
| #529 | Password policy and sign-in recovery | Taken (policy part) |
| #603 | Access-control hardening | Taken |

### Models and providers

| PR | What | Status |
|---|---|---|
| #608, #601, #613, #643 | Bedrock, Azure OpenAI and Foundry, Vertex, Mistral, xAI, custom endpoints | Noted: providers would go into `pi/providers.mts` |
| #613 (MCP part) | SSRF hostname canonicalisation | Taken |

### Platform, apps and tooling

| PR | What | Status |
|---|---|---|
| #612 | Mac app, including a self-contained "Start on this Mac" mode | Taken without that mode. The mode is **Interested** if we want a Mac app that needs no server. |
| #403, #607 | Storage behind a swappable `StorageAdapter`; browser signing client | Noted |
| #609, #614 | Migration ledger and `migrate.sh` | Taken |
| #584 | Signed downloads use the public endpoint | Taken |
| #610 | Cap Vitest workers | **Interested** |
| #396 | One design-token file for the web app and the add-in | **Interested** |
| #651 | `scripts/stack.sh`: clean up leftover Docker stacks | **Interested** |
| #655 | Weekly bug-review fixes (access lookups, tabular, projects) | **Interested**: port what still applies |
| #581 | e2e chat flows against a local Anthropic-protocol fixture | N/A: we use a scripted OpenAI-compatible server |
| #653, #671 | Minimal Google scopes, operator switch for Gmail | Noted |
| #682 | Default Sentry moved to their organization | Noted. Check where our default telemetry goes. |
| #606, #626, #602, #670 | Dead-code cleanup, weekly cleanup, UI fixes, unused dependency | Noted |
| #650, #687 | Docs: support and maintainership, combined Google guides | Noted |
| Dependabot (about 19 commits) | Version bumps | Noted: we regenerate our own lockfiles |

## Giving back

The candidate list and upstream's contribution rules are in section 8 of the
[divergence report](reports/fork-divergence-2026-10-21.md#8-contributing-back).
Our likeliest large contribution is speech: dictation and read-aloud first,
voice mode later. Upstream has nothing like it. We are not ready to open PRs
yet. What has to happen first:

1. **Settle it here.** Finish device QA and tuning of voice mode. Lift the
   "not approved for building" note in `docs/voice-chat.md`. Let dictation
   and read-aloud run in daily use for a while with no follow-up fixes.
2. **Ask first.** Gauge the maintainer's interest before writing anything for
   upstream. Then open a PRD issue (`docs/templates/PRD.md` upstream) for
   "dictation and read-aloud".
3. **Make the slice portable** in our own tree, which also improves our code:
   - **`audio` module:** reach `lib/privateMode` and `lib/egress` through a
     small hook, not direct imports.
   - **Composer and messages:** move the mic, live dictation and read-aloud
     behind narrow components. Then the PR adds files rather than editing
     upstream's busy `ChatInput` and `AssistantMessage`.
   - **OpenRouter lane and test bench:** split them off as optional.
4. **Licences and model sources.** List the licence of every model and
   package the speech path uses, and say where each model is downloaded from.
   The packages are `phonon-tts`, `kokoro-js`, `@huggingface/transformers`
   and `double-metaphone`. Models now come from mirrors on a personal Hugging
   Face account; upstream will want official or project-owned sources.
5. **Dry run.** Port the server lane onto a branch from `upstream/main`,
   against supabase-js and the AI SDK, to measure the real effort before we
   promise anything.

Suggested order of PRs:

1. Server dictation and read-aloud.
2. Settings → Voice with in-browser engines.
3. The dictation vocabulary.
4. Voice mode in the browser, if it gets built.

The voice mode server edge (spoken answers) is a small port. Their loop
replays text, and we record exactly the text the person heard. The iPhone
engine stays here: upstream has no phone app.
