-- Migration date: 2026-10-10
--
-- Skills in the standard format (goals/mission-17-skills.md). An assistant
-- workflow is a skill: SKILL.md (its title as the name, plus a description
-- and the body in prompt_md) and, optionally, other files (scripts/,
-- references/, assets/) kept as one zip in object storage at files_path,
-- listed in files as [{"path": ..., "size": ...}]. frontmatter keeps
-- SKILL.md fields other than name and description (license, metadata, ...).
--
-- workflow_versions keeps every saved state, so a skill changed from chat
-- or re-imported can be restored. The workflows row holds the current one.
--
-- Re-runnable: add column if not exists, create if not exists.

alter table public.workflows add column if not exists description text;
alter table public.workflows add column if not exists source_url text;
alter table public.workflows add column if not exists files jsonb;
alter table public.workflows add column if not exists files_path text;
alter table public.workflows add column if not exists frontmatter jsonb;

create table if not exists public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  title text not null,
  description text,
  prompt_md text,
  files jsonb,
  files_path text,
  frontmatter jsonb,
  source text not null
    check (source in ('original', 'edit', 'chat', 'import', 'restore')),
  source_url text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workflow_versions_number_unique unique (workflow_id, version_number)
);

create index if not exists workflow_versions_workflow_idx
  on public.workflow_versions (workflow_id, version_number desc);

alter table public.workflow_versions enable row level security;
revoke all on table public.workflow_versions from public, anon, authenticated;
grant select, insert, update, delete on public.workflow_versions to service_role;
