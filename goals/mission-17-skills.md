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
- **Create from chat.** The model writes a folder anywhere in the workstation
  (by convention `~/skills-drafts/<name>/`) and calls `save_skill` with its
  path. The harness reads it back as it reads `~/mike/out/` (regular files
  only, size caps), validates it and stores a version.
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
    yt-dlp audio as the fallback, output saved with `mike-save`. Drop the
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
