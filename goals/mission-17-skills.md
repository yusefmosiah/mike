# Mission 17: Skills, in the standard format

Owner direction, 2026-10-10 and 2026-10-11: support the standard skills
format ("I have a bunch of skills but there are like millions of skills now");
make skills on demand, customize a skill and have that saved, and "make a
skill in one thread and then use it in another thread". It should all work
and be simple.

Depends on [Mission 16](mission-16-documents-in-workstation.md): skills reach
the workstation the same way documents do, and a skill's output comes back
through `save_to_mike`.

## What exists

Mike calls skills "workflows".

- An assistant workflow is a `SKILL.md` text in `workflows.prompt_md`, per
  user, shareable by email. Tabular workflows (column definitions for tabular
  review) are a second type.
- A read-only catalog (`mike_workflows`) syncs from a GitHub repository of
  `SKILL.md` folders (`backend/src/lib/workflowCatalogSource.ts`). Its parser
  extracts zips safely (size caps, path checks) but requires `license` and
  `mike-*` metadata, which most published skills lack.
- The model has `list_workflows` (ids and titles only) and `read_workflow`
  (the body, fenced as `<workflow-instructions>`). Assets are Mike documents
  only, so `scripts/` and `references/` have nowhere to live.
- The model cannot create or edit workflows; users do it in the UI.

## Shape

- **One concept.** A skill is a standard folder: `SKILL.md` with `name` and
  `description` in its frontmatter (the only required fields), plus any
  `scripts/`, `references/` and `assets/`. Assistant workflows become skills:
  an existing one is a folder holding only its `SKILL.md`. Tabular workflows
  stay as they are. Mike-specific fields live under the standard's
  `metadata:` map, so the catalog format becomes a superset, not a fork.
- **Stored in Mike, versioned.** The `workflows` table keeps one row per
  skill (owner, name, description, where it came from), extended with
  versions; each version's folder is a zip in object storage. Durable across
  a VM rebuild, listable in the UI, shareable with the existing mechanism.
- **Present in the workstation.** The user's current skills appear read-only
  at `~/skills/<name>/`, brought up to date by Mission 16's sync before
  command-running turns. Scripts run there with `run_command`, nowhere else.
- **Discovered from the prompt.** Every turn's system prompt lists the user's
  skills as `name: description`. The model reads
  `~/skills/<name>/SKILL.md` when one fits, and other files as the skill
  directs. Without a workstation, `read_workflow` returns the `SKILL.md` and
  says scripts are unavailable. Past a size budget the prompt lists names
  only and `list_workflows` gives the descriptions.
- **Import.** From the Skills page or from chat ("install
  github.com/owner/repo/tree/main/skills/x"): a zip upload or a GitHub folder
  resolved to a commit, through the existing safe extractor with the
  frontmatter check relaxed to the standard. Import never runs anything.
- **Create from chat.** The model calls `save_skill` with the instructions
  (and any small text files) directly, or writes a folder anywhere in the
  workstation and passes its path. The harness reads a folder back as it
  reads a `save_to_mike` file (regular files only, no symlinks, size caps),
  validates it and stores a version.
- **Customize.** Copy `~/skills/<name>/` to a draft, edit, `save_skill`.
  Saving over an imported skill makes a new version of the user's copy and
  keeps "imported from <url>@<commit>". Upstream updates are never applied
  automatically.
- **Across threads.** The skill list is built per turn and skills belong to
  the user, so a skill saved in one thread is in every other thread's next
  turn.
- **Visible, reversible.** Each save is a tool result in the chat. The Skills
  page shows versions; restoring or deleting one is a click. No approval
  dialog.

## Making skills

Owner direction, 2026-10-10: the focus is "making new skills, not just from
source material, but codifying workflows and prompts". Three ways in, all
ending in `save_skill`:

- **What we just did.** After a chat has worked out how to do something
  ("summarize this deposition by topic with page:line cites"), the user says
  "make that a skill". The model writes the steps that worked for a reader
  with none of the conversation: when to use it, what to ask for first, the
  steps and the tools or commands, the result's form, and how to check it.
- **A prompt the user keeps pasting.** "Save this as a skill called X": the
  prompt becomes the body, with a description that says when it applies.
- **Source material.** A document, a repository or a published skill becomes
  a skill, in the workstation when it needs scripts.

The system prompt tells every chat to do this when asked, and to change a
skill by saving it again; `save_skill`'s description carries the writing
guidance. Saving a name the user already has is a new version, so refining a
skill from chat ("also check the governing-law clause") is the same call.

## Built (2026-10-10)

- **Storage.** `workflows` gained `description`, `source_url`, `files`,
  `files_path` and `frontmatter`; `workflow_versions` keeps every state
  (migration `20261010_12_skill_versions.sql`). The other files are one zip
  per version in object storage. Edits on the Workflows page are versions
  too; a skill that predates versions records its existing state as
  version 1 ("original") the first time it changes.
- **Format.** `backend/src/lib/skillFormat.ts` parses and renders SKILL.md,
  checks a folder (no `..`, absolute paths or symlinks; 200 files, 5 MB a
  file, 20 MB in all, counted as bytes are inflated) and packs or unpacks the
  zip. Only `name` and `description` are read from the frontmatter; a missing
  description is taken from the body; other fields are kept.
- **Chat.** `save_skill` (inline instructions and small files, or a folder in
  the user's own workstation), `install_skill` (a GitHub folder, resolved to
  a commit), `read_workflow` with `file` for a skill's references. Every
  turn's system prompt lists the user's skills as `name (id): description`,
  names only past 8,000 characters. A save shows in the chat as "Saved skill
  X" with its version. Saved skills are readable in the same turn and listed
  in every chat's next turn.
- **Workstation.** `~/skills/<name>/` (SKILL.md plus the files), read-only,
  synced with `~/mike` once per turn before the first command.
- **Web.** Workflows has "Import skill" (GitHub link or zip); an assistant
  workflow has a Skill tab with its description, source, files, a download
  of the skill folder, and its versions with Restore.
- **Not yet.** K3, the transcriber.

## Staging receipts (2026-10-11), not accepted

Through `mike-staging api` on node-a, the owner's staging account,
`opencode-go/glm-5.3-flash` in code mode, three separate chats:

- **Codify a workflow (chat `12a7ab1f`).** The user described how they want a
  "deal memo" (five sections, under 300 words, never invent numbers) and
  asked to save it. One `save_skill` call: `workflow_applied` with action
  "saved", version 1, skill `deal-memo` (`0f8101d6-3de2-4327-8d22-b83c3bd31af1`).
  The saved text kept every rule the user gave.
- **Use it in a fresh chat (chat `48b6970a`).** "Deal memo please" plus a
  term sheet, with no mention of the skill. The model found `deal-memo` in
  the system prompt's skills list, called `read_workflow` with its id, and
  answered in the saved structure: bold bottom line, parties, a money table
  with Amount / When due / Conditions, three risks tied to the terms, open
  questions. Two malformed code cells came first (model noise).
- **Change it from chat (chat `1b4773b9`).** "Add a sixth section, Next steps
  ... raise the limit to 350 words. Keep everything else the same." Saved as
  version 2 (`GET /workflows/:id/versions` returned `[(2, 'chat'), (1,
  'chat')]`). Defect: the model never read version 1; it rewrote the skill
  from the one-line listing and dropped "never invent numbers", replaced the
  money table's columns and loosened the bottom line. Fix: `save_skill`
  that would replace an existing skill (by `skill_id` or by name) is refused
  unless that skill was read with `read_workflow` (or saved) in the same
  turn; the refusal tells the model to read it and resend the whole text with
  only the requested change. Folder saves are grounded in their files and
  are not checked. Tests: `unreadSkillEdit` cases in `skillTools.test.ts`,
  and `toolDispatcherSkillEdit.test.ts` (refused, read, saved).

- **Install from GitHub (chat `e1ce7b90`).** "Install this skill:
  https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring".
  `install_skill` resolved `main` to commit `dbd4588f` and saved
  `doc-coauthoring` (`33d7d75f`), action "installed", version 1, source
  `.../tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/doc-coauthoring`.
  Defect: `read_workflow` in the same turn returned an empty body (the
  install recorded no text for the turn), so the model fetched the raw file
  from GitHub instead. Fix: the import returns the skill's body and the chat
  keeps it for the rest of the turn.

- **The edit again, with the fix deployed (chat `a894a4c6`).** Version 1
  restored through `POST /workflows/:id/versions/:versionId/restore` (it
  became version 5), then the same request as chat `1b4773b9`. The model
  first called `read_workflow`, then saved version 6: version 1 word for
  word, with "under 350 words" in both places and a sixth section "Next
  steps — at most three concrete actions for our side". The refusal path
  did not fire live (the model read first on its own, following the new
  tool description); `toolDispatcherSkillEdit.test.ts` covers it. An
  earlier attempt (chat `41e45d9f`) ran on the previous image during the
  rollout and saved without reading.

- **Install and read in one turn, fix deployed (chat `97b56653`).**
  `install_skill` saved `doc-coauthoring` as version 3 (same commit
  `dbd4588f`); `read_workflow` right after returned the full SKILL.md
  ("# Doc Co-Authoring Workflow ..."), and the answer quoted its stages
  "Context Gathering", "Refinement & Structure" and "Reader Testing" from
  it.

Not yet run live: the transcriber skill (K3).

## The boundaries we keep

1. Skill scripts run only in the user's VM, which holds no credentials.
2. Import and save never execute skill code on the backend; extraction stays
   safe (no `..`, no absolute paths, no symlinks, size caps).
3. A skill shared with someone else is a prompt that runs in their threads,
   so sharing stays an explicit act, never a default.

## What we will not build

- Signing, curation, a license requirement or a review queue for imported
  skills. The model can already run the same code with `run_command`, so a
  gate on skills adds nothing.
- A sandbox per skill, or an approval prompt per script run.
- Automatic upstream updates, or a marketplace.

## Phases

- **K0, the format.** Versioned skill folders in storage; zip and GitHub
  import with the standard frontmatter; export; existing assistant workflows
  shown as skills; the Skills page lists name, description, source, versions.
- **K1, discovery and running.** The prompt section; `~/skills/` in the
  workstation through Mission 16's sync; `read_workflow` fallback.
- **K2, authoring.** `save_skill` from chat; customize as a new version;
  restore and delete.
- **K3, the transcriber.**
  - First, check whether YouTube answers node-a's datacenter address at all:
    the caption API and yt-dlp, from the workstation through the proxy. Data
    centres are often asked to "confirm you're not a bot"; personal mode on a
    laptop has a home address.
  - Add `yt-dlp`, `ffmpeg` and `youtube-transcript-api` to the guest image.
  - Port `~/media/transcripts/transcribe.py` into a skill: captions first,
    yt-dlp audio as the fallback, output saved with `save_to_mike`. Drop the
    Apple-only parts (MLX engines, the iCloud mirror) and the public
    docs-md publish.
  - CPU speech recognition comes after a benchmark on the workstation's
    vCPUs (faster-whisper int8 against Parakeet TDT through sherpa-onnx).
    Captions cover most YouTube videos without it.

## Acceptance

1. A published skill imported from a GitHub folder URL, with no `license` or
   `mike-*` fields, appears on the Skills page and in the next turn's prompt.
2. In a chat, "make what we just did a skill called X" produces a folder and a
   saved skill; a different chat uses X without being told where it is.
3. Editing an imported skill from chat saves a new version of the user's
   copy; the Skills page shows both versions and the source.
4. A skill's script runs in the workstation and its output reaches Mike as a
   document through `save_to_mike`.
5. A zip with `../` paths or a symlink is refused on import and on save.
6. The transcriber skill turns a YouTube link into a transcript document, or
   the receipt records why YouTube refused node-a and what personal mode
   showed.
