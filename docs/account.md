# Account and settings

The `/user` (and `/users` alias) surface holds the signed-in person's settings,
connections and data controls. Mutating routes use MFA step-up when the
account has MFA enrolled.

## Settings and connections

- **Profile and onboarding:** read, update and bootstrap the profile; finish
  onboarding; set the login security password.
- **Invitations:** list pending organization invitations and accept or decline
  one (see [Organizations](organizations.md)).
- **API keys:** list status and store or remove provider credentials.
- **MCP connectors:** list, create, read, configure, complete OAuth and delete
  MCP servers; the protocol and deployment setup are in
  [MCP connectors](connectors.md).
- **Google integrations:** connect, configure and disconnect Google Drive and
  Google Workspace under `/user/integrations/*`; user-facing behavior is in
  [Google Drive](google-drive.md) and [Gmail and Google Calendar](google-workspace.md).
- **Assistant preferences:** the Auto Mode decision is read and written under
  `/user/auto-mode-decision` (see [Decision models](decision-models.md));
  autocompact settings and the dictation vocabulary have their own endpoints.

## Data controls

- **Exports:** request whole-account, chat, tabular, document and memory
  exports; poll the export job and download the artifact. Audit history
  exports as CSV through the same job type (see [Audit log](audit-log.md)).
- **Deletion:** delete individual chats, project data, tabular reviews,
  memories or the whole account. What each deletion covers, and what blocks
  account deletion, is in [Deletion and retention policy](deletion-policy.md).

State as of 2026-10-27; re-read `backend/src/modules/user/` before relying on
the route list.
