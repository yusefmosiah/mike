-- Migration date: 2026-10-24
--
-- A publication can also require its visitor to be signed in to the app and
-- able to open the source document (docs/publishing.md). Independent of the
-- password: a link may need either, both or neither.
alter table if exists public.publications
  add column if not exists require_sign_in boolean not null default false;
