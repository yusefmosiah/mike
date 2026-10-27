# Chat

A conversation is a tree of messages. A turn streams from the model over SSE,
and the server owns the run so a dropped connection or a restart does not lose
it.

## Surfaces

- **Chats:** list, create, read, rename and delete under `/chat`; project
  chats send at `POST /projects/:projectId/chat`.
- **Turn runs:** `POST /chat` (and the project route) stream a turn;
  `GET /chat/:chatId/turn/:turnId/stream` reattaches to a run after a
  reconnect, and `POST .../stop` stops it. Interrupted answers resume and a
  spoken-prefix record is stored with
  `PUT /chat/:chatId/messages/:messageId/spoken`.
- **Tree:** `POST /chat/:chatId/branches`, `/leaf` and `/fork` move or copy
  branches; `GET /chat/:chatId/path` reads the active path and the siblings
  endpoint exposes alternatives.
- **Sharing:** `people` and `access` list and manage who can read a thread;
  a note (`POST /chat/:chatId/notes`) is a message that does not ask for a
  reply. One answer generates at a time per thread.
- **Approvals:** code-mode write approvals and guest revocations are listed
  and decided under `/chat/:chatId/code-approvals`.
- **Attachments:** documents, images and saved web-page snapshots travel with
  the turn; `GET /chat/:chatId/web-pages/:snapshotId` serves a saved page.
  A document or link can be shown inline in an answer with `show_media`.
- **Questions:** `ask_inputs` pauses the turn on a card for choices, text or
  document uploads instead of guessing.

Subagents have their own page ([Subagents](subagents.md)). The turn machinery
— preparation, streaming, compaction and run resumption — is described in
[Backend architecture](backend-architecture.md).

State as of 2026-10-27; re-read `backend/src/modules/chat/` and
`backend/src/modules/project-chat/` before relying on the route list.
