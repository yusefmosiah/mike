# Organizations

An organization (a firm or team) owns projects and other content and has a
roster with two roles.

## Roles and membership

- **admin** — organization settings, invitations, member roles and removal.
- **member** — reads the organization and its roster; no organization
  mutations.

Both roles receive Editor on organization content unless an item-specific
override gives Owner, Viewer or Deny. There is no owner tier; the database
keeps at least one admin.

Membership is never granted directly. An admin creates an invitation, and the
`org_members` row appears only when the invited account accepts it. This is
deliberate: joining an organization exposes its confidential content, so the
recipient must consent.

## Surface

- `GET/POST /orgs` lists the caller's organizations and creates one.
- `GET/PATCH/DELETE /orgs/:orgId` reads, updates and deletes an organization;
  `GET /orgs/:orgId/resources` lists what it owns.
- Members: list, change role, remove.
- Invitations: create, list, cancel and resend under `/orgs/:orgId/invitations`.
  Accept and decline are under `/user/invitations` (see
  [Account](account.md)).
- Invitations expire after 14 days.

State as of 2026-10-27; re-read `backend/src/modules/orgs/` and
`backend/src/lib/orgs.ts` before relying on the route or role list.
