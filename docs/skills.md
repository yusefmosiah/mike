# Skills

A skill is a workflow whose instructions follow the standard `SKILL.md`
format. Skills are listed in the assistant's turn context when they fit, and
any chat can read them; authoring one is saving a workflow.

## Assistant tools

- `save_skill` — save a skill (name, description, Markdown instructions and
  optional small text files), or change one by id. Saving an existing name
  creates a new version; a skill the caller cannot edit is saved as their own
  copy. `path` can instead point at a skill folder in the workstation.
- `install_skill` — install a published skill from a GitHub folder or
  `SKILL.md` link as the caller's own. Installing copies files and runs
  nothing; installing the same skill again saves a new version.
- `read_workflow` — read a skill's `SKILL.md`, or one of its other files, by
  workflow id. `list_workflows` lists the available skills.

The workflow catalogue, versions, sharing and the non-chat HTTP surface are in
[Workflows and quick actions](workflows.md). `SKILL.md` frontmatter and the
type-file format used by subagents are separate mechanisms.

State as of 2026-10-27; re-read
`backend/src/modules/chat/engine/tools/skillTools.ts` and the tool schemas
before relying on the tool list.
