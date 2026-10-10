# Upstream picks for approval, 2026-10-10

Changes taken from upstream `open-legal-products/mike` into this fork today.
All are on `main` and deployed to staging. None is approved yet, so each one is
listed with what it changes, the risk, and how to undo it. Four Haiku
subagents reviewed upstream's recent commits. I chose and applied the picks
below, then ran the backend and frontend test suites before each push.

**Stopped at the owner's request:** no further upstream changes are applied
until these are approved. On 2026-10-10 the owner asked for two more, the
migration ledger and the contract templates (#11 and #12).

## Applied

| # | Our commit | Upstream | What it does | Size | Risk | Undo |
|---|---|---|---|---|---|---|
| 1 | `37c2b953` | `d146998d`, ported by hand | **Access gaps.** Details below the table | 27 files, +1034/−59 | Medium. Touches the access checks on six write paths; covered by upstream's tests plus ours (4461 backend tests passed) | `git revert 37c2b953`; the migration needs a new migration to undo (below) |
| 2 | `a35a1c5b` | `1da19c20`, MCP subset only | **SSRF hardening.** A hostname with a trailing dot (`LOCALHOST..`) slipped past the blocked-host check for MCP servers. Hostnames are now canonicalised first, and blocked destinations raise a typed error | 4 files, +163/−16 | Low. The resolved-IP check already stopped the request; this closes the name check too | `git revert a35a1c5b` |
| 3 | `693255ee` | `871f7b04`, applied cleanly | **Uploads.** The project explorer and the new-review picker could drop files silently. Each file now reports added, rejected or failed | 6 files, +422/−29 | Low | `git revert 693255ee` |
| 4 | `a88df2ae` | `4591b661`, conflicts resolved by hand | **Waiting replies.** A reply paused on a question (ask_inputs) or a connector approval showed as done, with a copy button. It now shows "waiting" | 10 files, +309/−34 | Low to medium. Conflicts with our branch navigation and author labels were merged by hand in ChatView and the project chat page | `git revert a88df2ae` |
| 5 | `f93ae418` | `76b09848`, applied cleanly | **Downloads.** Download links were signed with the internal storage address, so on Docker Compose the browser was sent to `http://storage:9000` and failed. They now use the public endpoint, falling back to the internal one | 2 files, +16/−2 | Low | `git revert f93ae418` |
| 6 | `71a96138` | `90206f5a`, applied cleanly | **Memory autosave.** An edit could be lost when the editor closed while a save was in flight; it is now flushed | 2 files, +41/−1 | Low | `git revert 71a96138` |
| 7 | `b573daaf` | `399270fe`, applied cleanly | **Small UI.** The chat search field is flush with its container, and the title's focus ring shows only for keyboard focus | 5 files, +32/−1 | Low, but visual: worth a look | `git revert b573daaf` |
| 8 | `fbaf92b8` | `725f5a21`, applied cleanly | **New feature.** The new-review access step lists the project members who inherit access | 4 files, +142/−10 | Low, but a feature you did not ask for | `git revert fbaf92b8` |
| 9 | `534553e8` | `9d327292`, applied cleanly | **Comment only.** Fixes a code comment's file path | 1 file | None | `git revert 534553e8` |
| 10 | `0cfeeacb` | `c94052d7`, policy part only, adapted | **Passwords.** Details below the table | 8 files, +109/−10 | Low. Existing users are unaffected at sign-in | `git revert 0cfeeacb` |
| 11 | `124d832b`, `43220382`, `d617576e`, `0501ee14` | `a86784aa`, `e66ecd34`, applied cleanly, then adapted | **Contract templates.** Library → Templates → "Browse presets" offers 83 public templates (General Legal, Common Paper, Bonterms) to add as personal copies or download. Details below the table | ~95 files, about 13 MB of DOCX/PDF | Low. Bundled static files plus a picker; imports use the existing upload path | `git revert` the four commits |
| 12 | the `feat(db): record applied migrations` commit | `49efc046`, `a178e85a`, ported by hand | **Migration ledger.** Each database records the migrations it has applied in `public.schema_migrations`; `backend/scripts/migrate.sh` applies only the rest, each in a transaction, under an advisory lock. Compose's db-init (and so staging) runs it instead of re-applying a hard-coded list on every start | 14 files | Medium: changes how staging migrates. Tested on a fresh volume, on a volume made by the old db-init, and on the local e2e database | `git revert`; the `schema_migrations` table can stay, nothing else reads it |

### Details

**#1 Access gaps (`37c2b953`):**
- The assistant's `edit_document` now checks edit rights on the specific
  document. Before, a Viewer could get an assistant edit made current on a
  document they could only read, through a standalone chat or an attachment
  from another project.
- Copying a document into another project requires access to the source.
- Moving a review requires edit rights on both projects.
- An Editor cannot delete a folder holding documents they could not delete
  one by one.
- Review detail and review chat hide rows built from documents the caller
  cannot read.
- Deleting or replacing a document or version requires current edit rights.
- Sharing by email only matches a confirmed address.
- Migration `20261010_04` moves email-keyed shares when a user changes their
  email.

**#10 Passwords (`0cfeeacb`):** sign-up, reset and password change all require
10 characters and at most 72 bytes, the bcrypt limit. Before, the API accepted a
1-character password at sign-up and 8 at change while the form asked for 10.
GoTrue also gave an opaque error for passwords over 72 bytes. Sign-in still
accepts any existing password. Upstream's toast refactor that came with this
change was not taken.

**#11 Contract templates:** I read the licence notice inside every file and
checked the publishers' pages. General Legal is CC0 (its page says so; the files
carry no notice). Common Paper is CC BY 4.0, but its Amendment and Statement of
Work carry no notice and are not clearly covered, so I removed them. Bonterms is
licensed per file: 20 CC BY 4.0, 14 CC0 (example cover pages, order form, SOW,
policies), and 3 CC BY-ND 4.0 (End User Agreement, Reseller Agreement for
Marketplaces, Online Cloud Terms), which forbid sharing edited copies. The
picker now shows each file's own licence, with a "share unmodified only" note
on the BY-ND ones. Upstream's later rework of the picker into a full page
(`16c908dc`) was not taken: it rewrites the document table and toolbars across
the app. Taking the picker also exposed a phone bug in every table toolbar: the
actions menu stayed open over the dialog an action opened. Fixed in `0501ee14`.

**#12 Migration ledger:** the ledger migration is
`20261010_06_schema_migrations.sql` (upstream's `20261009_03`, renamed to our
date sequence). `schema.sql` creates the table and lists all 115 files, so a
fresh install has nothing pending. On staging's first deploy, db-init finds
no ledger and runs `docker/db-init/adopt-ledger.sh`: one last replay of the old
list under the old rules (the same two old files fail and are ignored, as on
every start today), then records everything up to `20261010_05`. Adding a
migration no longer needs compose mount and psql lines; AGENTS.md says so. The
local schema-drift reproduction gave identical fingerprints (7842 lines each).

### Notes on #1

- **Confirmed emails.** Shares, invitations and organization grants keyed by
  email now match only an address the account has confirmed. Staging
  auto-confirms sign-ups, so it changes nothing there. On a deployment that
  requires confirmation, an unconfirmed account sees nothing shared to its
  address until it confirms.
- **Not taken:** upstream also defaulted `GOTRUE_MAILER_AUTOCONFIRM` to off in
  Compose and `.env.example`. Local e2e and staging rely on auto-confirm.
- **Migration `20261010_04`** replaces `handle_user_email_updated()` so that an
  email change moves the account's project, chat, review and workflow shares to
  the new address, keeping the stronger role on a conflict. It is applied on
  staging. To undo it, add a new migration restoring the old function body,
  which updated only `user_profiles.email`.

## Reviewed and not applied

| Upstream | What | Why not |
|---|---|---|
| `31ff48e3` | Stream idle timeout ignores keep-alive pings | Barely applies here. Our periodic keep-alive writes to the HTTP response, not into the turn run, so it cannot hold a stuck turn open. Porting it would also cut off Word's legitimate `tool-wait` pauses and the citation tool's progress pings unless both were rewired |
| `54b6b3a1`, `55ec6955`, `f4cf97c7`, `89f61ccd` (+ dependabot `e72b3bf4`, `1609d4f8`) | Sentry SDK v11 with explicit privacy controls | A dependency upgrade across three apps. We are on v10 with `sendDefaultPii: false`, which is already privacy-safe |
| `017b6741` | Shared toast and notice store, turn-scoped Retry | UI framework change; Retry would need rebuilding on our turn claims and branches |
| `e44fbf30` | Caps on ask-input choice length | Small hardening; needs hand-porting |
| `6829c525` | Batched asset lookup in workflow add-ons | Performance; conflicts |
| `f3fa62e6` | PDF text-layer review fixes | Conflicts with our PDF code |
| `2f30082a` (+ tests) | Model catalog refresh and direct Mistral API | Built for upstream's AI SDK; ours runs on Pi |
| `9c5ffa31`, `25779536`, `81429370` | Bring-your-own-key for Bedrock, Azure, Vertex, xAI, custom endpoints | Built for upstream's AI SDK; large |
| `663d3b16`, `8cc1ffcc`, `c65c84c6` | Response language, style, custom instructions | Features this fork does not have |
| `9ed181a1` | One shared dropdown implementation (80 files) | UI rewrite, no bug fix |
| `89dc8323` | Mac app local workspace | Different product |
| `6baa2512` | Cap local Vitest workers | Test tooling; conflicts |
| `e436b039`, `553b7550`, `b04777a2`, `281aa06e`, `57009979` | Test stub, reasoning replay, CI and dev-dependency fixes | Not needed: we have our own stub, or the fix is already in our lockfiles |
