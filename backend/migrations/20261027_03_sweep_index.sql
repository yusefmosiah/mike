-- Migration date: 2026-10-27
--
-- The confidential migration shipped a partial index on
-- (user_id, confidential) WHERE confidential — that only serves queries for
-- confidential = true, and the stated consumer asks for the opposite set.
-- Replace it with the shape the context-builder sweep actually runs:
--   user_id = me, project_id is null, workflow_id is null,
--   confidential = false, status = 'ready', ordered by updated_at desc.
drop index if exists public.idx_documents_user_confidential;

create index if not exists idx_documents_user_doc_sweep
  on public.documents(user_id, updated_at desc)
  where confidential = false
    and project_id is null
    and workflow_id is null
    and status = 'ready';
