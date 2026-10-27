# Audit log

The audit log records events about a person's activity. A turn produces a
`chat.message` row plus rows for the artifacts it made (generated, edited or
replicated documents; applied workflows). Publications, organization changes,
tabular reviews, uploads and data exports record their own events. It is
distinct from error tracking ([Error tracking with Sentry](observability.md)).

## Reading it

- `GET /audit` returns a paginated JSON page. Filters cover text, action,
  status, surface and a date range; sorting covers time, user, title and
  model.
- `GET /audit/export` returns one flat CSV page (at most 2,000 rows) and is
  MFA-gated when the account has MFA. The app uses the durable `audit-csv`
  export job instead; both paths render the same bytes through
  `lib/auditExport`.
- **Visibility:** a caller sees their own events plus events in projects they
  can access. The service, not the route, enforces that scope.

## Writing it

Application code records events through `lib/audit` (`recordAudit`,
`enqueueChatTurnAudit`) rather than inserting into the audit table directly.
A request failure does not fail the operation that was audited.

State as of 2026-10-27; re-read `backend/src/modules/audit/` and
`backend/src/lib/audit.ts` before relying on the event or filter list.
