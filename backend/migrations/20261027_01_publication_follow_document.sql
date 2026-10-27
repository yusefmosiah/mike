-- Migration date: 2026-10-27
--
-- A publication can follow its document's current version instead of serving
-- the copy taken when it was made (docs/publishing.md). A followed
-- publication keeps no copied files: the content server resolves the live
-- bundle per request. Existing publications stay frozen at the version they
-- copied, so the default is false.
alter table if exists public.publications
  add column if not exists follow_document boolean not null default false;
