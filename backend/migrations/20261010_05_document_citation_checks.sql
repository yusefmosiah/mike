-- Migration date: 2026-10-10
--
-- Citation checks target documents, not assistant messages
-- (goals/mission-6-citation-verification-subagents.md).
--
-- The check protects a document before it goes out: a memo the assistant
-- drafted, or an uploaded brief it then edited, may cite authorities that do
-- not exist, misquote them, or use them for a proposition they do not
-- support. A task now names a document version; each check row names where
-- in that document the citation sits, what the document says the authority
-- stands for, and the checker's judgement of whether the source supports it.
--
-- 1. verification_tasks: kind 'document_citation_check'; chat_id, message_id
--    and producer_invocation_id become optional; document_id and
--    document_version_id name the target; invoked_by is the turn that asked
--    (when the assistant asked), and model is the checker's model.
-- 2. citation_snapshots: 'case' sources (court opinions) are stored too.
-- 3. citation_checks: chat and message optional; the document target, the
--    citing block, the citation text, the proposition, the support judgement
--    and its reason; quote optional (many citations quote nothing); verdicts
--    'unsupported' and 'contradicted'.
--
-- Re-runnable: add column if not exists, drop not null (idempotent), and
-- constraints dropped before they are added.

alter table public.verification_tasks alter column chat_id drop not null;
alter table public.verification_tasks alter column message_id drop not null;
alter table public.verification_tasks alter column producer_invocation_id drop not null;
alter table public.verification_tasks
  add column if not exists document_id uuid references public.documents(id) on delete cascade;
alter table public.verification_tasks
  add column if not exists document_version_id uuid references public.document_versions(id) on delete cascade;
alter table public.verification_tasks add column if not exists invoked_by uuid;
alter table public.verification_tasks add column if not exists model text;
alter table public.verification_tasks drop constraint if exists verification_tasks_kind_check;
alter table public.verification_tasks
  add constraint verification_tasks_kind_check
  check (kind in ('citation_check', 'document_citation_check'));
alter table public.verification_tasks drop constraint if exists verification_tasks_target_check;
alter table public.verification_tasks
  add constraint verification_tasks_target_check check (
    (kind = 'citation_check' and message_id is not null and producer_invocation_id is not null)
    or (kind = 'document_citation_check' and document_id is not null and document_version_id is not null)
  );

create index if not exists verification_tasks_document_idx
  on public.verification_tasks(document_id, created_at desc);

alter table public.citation_snapshots drop constraint if exists citation_snapshots_source_kind_check;
alter table public.citation_snapshots
  add constraint citation_snapshots_source_kind_check
  check (source_kind in ('document', 'web', 'case', 'connector'));

alter table public.citation_checks alter column chat_id drop not null;
alter table public.citation_checks alter column message_id drop not null;
alter table public.citation_checks alter column quote drop not null;
alter table public.citation_checks
  add column if not exists document_id uuid references public.documents(id) on delete cascade;
alter table public.citation_checks
  add column if not exists document_version_id uuid references public.document_versions(id) on delete cascade;
-- Where the citation sits in the checked document (a stable block id).
alter table public.citation_checks add column if not exists cited_block_id text;
alter table public.citation_checks add column if not exists citation_text text;
-- What the checked document says the authority stands for.
alter table public.citation_checks add column if not exists proposition text;
alter table public.citation_checks add column if not exists support text;
alter table public.citation_checks drop constraint if exists citation_checks_support_check;
alter table public.citation_checks
  add constraint citation_checks_support_check
  check (support is null or support in ('supports', 'partial', 'does-not-support', 'contradicts', 'unclear'));
alter table public.citation_checks add column if not exists support_reason text;
-- Whether the source contains the words the document quotes (null: no quote).
alter table public.citation_checks add column if not exists quote_found boolean;
alter table public.citation_checks drop constraint if exists citation_checks_verdict_check;
alter table public.citation_checks
  add constraint citation_checks_verdict_check
  check (verdict in (
    'exists-and-matches', 'not-found', 'quote-mismatch', 'unverifiable',
    'unsupported', 'contradicted'
  ));

create index if not exists citation_checks_document_idx
  on public.citation_checks(document_id, checked_at desc);
