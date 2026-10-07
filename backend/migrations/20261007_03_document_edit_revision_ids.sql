-- Migration date: 2026-10-07
-- Description: document_edits.w_ids — every tracked-change id (w:id) an
-- assistant edit created. One edit can now produce several revisions (a
-- deletion that spans a link, deleted paragraph marks, deleted table rows),
-- and accepting or rejecting the edit must resolve all of them. del_w_id and
-- ins_w_id stay as the first deletion and insertion, which the viewer
-- highlights. Idempotent.

alter table public.document_edits
  add column if not exists w_ids text[] not null default '{}';
