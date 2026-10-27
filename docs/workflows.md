# Workflows and quick actions

A workflow is a reusable prompt with optional assets and an optional SKILL.md.
"Skill" is the same object: the workflow tools read and write skills in the
standard `SKILL.md` format.

## Workflows

- **Catalogue:** list with scope, paging, sort and filters; read one workflow,
  its people, shares, asset documents and versions.
- **Authoring:** create, update (PUT or PATCH), delete, and restore a previous
  version. System workflows are read-only starting points and can be installed
  into a user's catalogue.
- **Sharing and visibility:** share with people, remove a share, hide a
  workflow from the caller's list, and list the full ID set for select-all.
- **Assets:** list, add or remove documents attached to a workflow.
- **Submissions:** `POST /workflows/:workflowId/open-source` submits a user
  workflow as a contribution when the deployment enables contributions.
- **Export:** `GET /workflows/:workflowId/export` downloads the workflow.
- **Addons:** `/workflow-addons` lists, reads and imports published workflow
  addons.
- **Assistant tools:** `list_workflows` lists the caller's skills and
  `read_workflow` reads a skill's `SKILL.md` (or another file inside it).

Authoring skills from a chat is described in [Skills](skills.md).

## Quick actions

A quick action is a named prompt bound to a workflow and a surface (`app` or
`word`). `/quick-actions` lists them (optionally by surface), creates one,
and updates or deletes one. The action controls what the button inserts; the
workflow still decides the access.

State as of 2026-10-27; re-read `backend/src/modules/workflows/`,
`backend/src/modules/quick-actions/` and
`backend/src/modules/chat/engine/tools/toolSchemas.ts` before relying on the
route or tool list.
