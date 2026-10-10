-- Migration date: 2026-10-10
--
-- Citation verification (goals/mission-6-citation-verification-subagents.md).
--
-- 1. projects.egress_policy: whether work in a project may contact the
--    public web. 'deny' means the citation verifier performs no outbound
--    fetch for that project and reports web citations as unverifiable.
-- 2. verification_tasks: a checker run as a Postgres row, separate from the
--    turn that produced the citations. It names the producing invocation (the
--    assistant message) so a run can refuse to grade its own output, carries
--    the actor whose authority every read is re-checked against, a step limit,
--    a checkpoint (the next citation to check) so a restarted worker resumes,
--    and a cancellation flag checked between steps.
-- 3. citation_snapshots: the source text a verdict was graded against,
--    stored durably with its SHA-256, so a third person can re-check it later
--    without the source being reachable. Document snapshots carry the version
--    and the block offsets that anchor quotes to stable block ids.
-- 4. citation_checks: one row per quoted passage: the verdict, the evidence
--    (snapshot, block id, offsets, excerpt) and the reason.
--
-- Re-runnable: add column / create table / create index if not exists, and
-- constraints dropped before they are added.

alter table public.projects
  add column if not exists egress_policy text not null default 'allow';
alter table public.projects drop constraint if exists projects_egress_policy_check;
alter table public.projects
  add constraint projects_egress_policy_check check (egress_policy in ('allow', 'deny'));

create table if not exists public.verification_tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'citation_check' check (kind in ('citation_check')),
  chat_id uuid not null references public.chats(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  producer_invocation_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  step_limit integer not null default 100 check (step_limit between 1 and 500),
  steps_used integer not null default 0 check (steps_used >= 0),
  checkpoint jsonb not null default '{}'::jsonb,
  cancel_requested boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- The checker is never the producer.
  constraint verification_tasks_not_self_graded check (id <> producer_invocation_id)
);

create index if not exists verification_tasks_message_idx
  on public.verification_tasks(message_id, created_at desc);

create table if not exists public.citation_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('document', 'web', 'connector')),
  document_id uuid references public.documents(id) on delete set null,
  document_version_id uuid references public.document_versions(id) on delete set null,
  url text,
  connector_id text,
  record_id text,
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Document snapshots: [{ "id": block id, "start": n, "end": n }] into content.
  block_offsets jsonb,
  retrieved_at timestamptz not null default now()
);

create index if not exists citation_snapshots_sha_idx
  on public.citation_snapshots(content_sha256);

create table if not exists public.citation_checks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.verification_tasks(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  citation_ref integer not null,
  quote_index integer not null,
  source_kind text not null check (source_kind in ('document', 'web', 'case', 'connector')),
  quote text not null,
  verdict text not null
    check (verdict in ('exists-and-matches', 'not-found', 'quote-mismatch', 'unverifiable')),
  reason text,
  snapshot_id uuid references public.citation_snapshots(id) on delete restrict,
  block_id text,
  start_char integer,
  end_char integer,
  excerpt text,
  checked_at timestamptz not null default now(),
  unique (task_id, citation_ref, quote_index)
);

create index if not exists citation_checks_message_idx
  on public.citation_checks(message_id, checked_at desc);

alter table public.verification_tasks enable row level security;
alter table public.citation_snapshots enable row level security;
alter table public.citation_checks enable row level security;
revoke all on table public.verification_tasks from public, anon, authenticated;
revoke all on table public.citation_snapshots from public, anon, authenticated;
revoke all on table public.citation_checks from public, anon, authenticated;
grant select, insert, update, delete on public.verification_tasks to service_role;
grant select, insert, update, delete on public.citation_snapshots to service_role;
grant select, insert, update, delete on public.citation_checks to service_role;
