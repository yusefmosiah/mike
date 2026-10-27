# Documents, files and the library

Documents are versioned files with a type, an owner and an access rule. The
same model covers project documents, standalone library files, templates and
the rendered outputs the assistant generates.

## What the surface does

- **Documents:** list, read, rename and delete; read a version's display
  metadata, raw file, plain text and download URL; download several as a zip.
- **Versions:** list versions, create one from another document, rename or
  delete a version, and read or act on tracked changes (`accept`/`reject`).
  A document's active version is what viewers and publications serve.
- **Library:** `GET /library/:kind` lists standalone files or templates with
  their folder tree. `:kind` is `files` or `templates`; folders can be
  created, renamed, moved and deleted, documents can be bulk-deleted or moved,
  and folder paths can be resolved in one request.
- **Uploads:** `POST /upload-sessions` authorizes a destination, returns
  signed object-storage URLs, then seals the session once the bytes are in
  storage. A worker processes the sealed session even if the client closes
  the app; file bytes never pass through Express.
- **Assistant tools:** `read_document`, `find_in_document`,
  `find_in_documents`, `fetch_documents` and `list_documents` read the chat's
  document index; `replicate_document` copies a document or template;
  `generate_docx`, `generate_excel` and `generate_ppt` create new files;
  `save_to_mike` turns a workstation file into a new document or version.
  `generate_html` is described in [Publishing](publishing.md).
- **Editing:** `edit_document` and `get_diff` propose and inspect tracked
  changes; the editor itself is in [DOCX editor](docx-preview-engines.md).

Project-scoped document routes live under `/projects` (see
[Projects](projects.md)); `/documents` is the CourtListener source-document
lookup described in [CourtListener](courtlistener.md).

State as of 2026-10-27; re-read `backend/src/modules/documents/`,
`backend/src/modules/library/`, `backend/src/modules/uploads/` and the tool
schemas before relying on route, tool or format lists.
