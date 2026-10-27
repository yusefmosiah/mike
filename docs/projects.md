# Projects

A project groups documents, folders, chats and the people allowed to use
them. Organization membership can grant access to a project; direct grants
and per-item overrides refine it.

## What the surface does

- **Projects:** list with scope and paging, create, read, rename and delete;
  the overview endpoint returns counts, and the directory/search and
  filter-options endpoints back the picker.
- **Access:** list people, add or remove a direct grant, and list the access
  the caller holds. A project created in an organization inherits that
  organization's access; an item-specific override still wins.
- **Documents and folders:** list a project's documents, add or copy one,
  rename it, move it between folders, and create, rename, move or delete the
  folder tree. Folder paths can be resolved in one request.
- **Chats:** list the project's chats. Sending a turn is the project-chat
  surface described in [Chat](chat.md).
- **Export:** `GET /projects/:projectId/export` produces the signed project
  manifest described in [Tamper-evident exports](tamper-evident-exports.md).

Projects are the app's main scoping unit: a document, chat or workflow created
inside one carries its organization, while standalone documents live in the
[document library](documents.md).

State as of 2026-10-27; re-read `backend/src/modules/projects/` before relying
on the route list.
