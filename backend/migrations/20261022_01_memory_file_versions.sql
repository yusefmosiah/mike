-- Migration date: 2026-10-22
--
-- Memory files keep their history. Every write (the person's editor, a
-- restore, the curator) and every turn-off is recorded in
-- memory_file_versions, so earlier versions can be read, compared and
-- restored. Rapid editor saves by the same person are one version. Deleting
-- memory (Privacy & Data, or account deletion) deletes the history with it;
-- turning memory off keeps it.
--
-- write_memory_file gains p_change_summary and the 'restore' source;
-- wipe_memory_file gains p_delete_history. Re-runnable.

create table if not exists public.memory_file_versions (
  id uuid primary key default gen_random_uuid(),
  memory_file_id uuid not null references public.memory_files(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  -- The file revision this version became (a coalesced editor version
  -- advances with each save it absorbs).
  revision bigint not null check (revision >= 0),
  content text not null default '',
  content_sha256 text check (
    content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  size_bytes integer not null default 0
    check (size_bytes >= 0 and size_bytes <= 16384),
  source text not null
    check (source in ('manual', 'curator', 'restore', 'settings', 'wipe')),
  change_summary text check (change_summary is null or char_length(change_summary) <= 500),
  updated_by uuid references auth.users(id) on delete set null,
  source_chat_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_file_versions_number_unique unique (memory_file_id, version_number)
);
create index if not exists memory_file_versions_file_idx
  on public.memory_file_versions(memory_file_id, version_number desc);
alter table public.memory_file_versions enable row level security;
revoke all on public.memory_file_versions from public, anon, authenticated;
grant select, insert, update, delete on public.memory_file_versions to service_role;

-- Records a write as a version: the body as it became, who or what wrote it,
-- and why. The person's own editor saves within ten minutes of each other,
-- with nothing else written between them, are one version. The newest 200
-- versions of a file are kept. Callers hold the memory_files row lock, which
-- serializes version numbers.
create or replace function public.record_memory_file_version(
  p_memory_file_id uuid,
  p_revision bigint,
  p_content text,
  p_content_sha256 text,
  p_size_bytes integer,
  p_source text,
  p_change_summary text,
  p_updated_by uuid,
  p_source_chat_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  latest public.memory_file_versions%rowtype;
begin
  select * into latest from public.memory_file_versions
  where memory_file_id = p_memory_file_id
  order by version_number desc
  limit 1
  for update;

  if found
    and p_source = 'manual'
    and latest.source = 'manual'
    and latest.updated_by is not distinct from p_updated_by
    and latest.revision = p_revision - 1
    and latest.updated_at > now() - interval '10 minutes'
  then
    update public.memory_file_versions
    set revision = p_revision,
        content = p_content,
        content_sha256 = p_content_sha256,
        size_bytes = p_size_bytes,
        updated_at = now()
    where id = latest.id;
    return;
  end if;

  insert into public.memory_file_versions(
    memory_file_id, version_number, revision, content, content_sha256,
    size_bytes, source, change_summary, updated_by, source_chat_id
  ) values (
    p_memory_file_id, coalesce(latest.version_number, 0) + 1, p_revision,
    p_content, p_content_sha256, p_size_bytes, p_source,
    nullif(btrim(coalesce(p_change_summary, '')), ''), p_updated_by,
    p_source_chat_id
  );

  delete from public.memory_file_versions
  where memory_file_id = p_memory_file_id
    and version_number <= coalesce(latest.version_number, 0) + 1 - 200;
end;
$$;

drop function if exists public.write_memory_file(
  uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint
);
drop function if exists public.wipe_memory_file(uuid, boolean, uuid, text);

create or replace function public.write_memory_file(
  p_memory_file_id uuid,
  p_expected_revision bigint,
  p_expected_epoch bigint,
  p_content text,
  p_content_sha256 text,
  p_size_bytes integer,
  p_source text,
  p_updated_by uuid default null,
  p_source_surface text default null,
  p_source_chat_id uuid default null,
  p_source_job_id uuid default null,
  p_consolidation_state_id uuid default null,
  p_consolidation_generation bigint default null,
  p_conversation_generation bigint default null,
  p_source_epoch bigint default null,
  p_change_summary text default null
)
returns table(applied boolean, new_revision bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.memory_files%rowtype;
  consolidation public.memory_consolidation_states%rowtype;
  activity public.memory_conversation_activity%rowtype;
begin
  if p_source not in ('manual', 'curator', 'restore') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  if p_size_bytes < 0 or p_size_bytes > 16384 then
    raise exception using errcode = '22023', message = 'memory_content_too_large';
  end if;
  -- Match canonical DELETE's source -> scheduler-state lock order. Holding
  -- this key-share lock through the write makes deletion and learning
  -- serialize without a check/write gap.
  if p_source = 'curator' then
    if p_consolidation_state_id is null
      or p_consolidation_generation is null
      or p_conversation_generation is null
      or p_source_surface is null
      or p_source_chat_id is null
      or p_source_epoch is null
    then
      raise exception using errcode = '22023', message = 'memory_curator_fence_required';
    end if;
    perform locked.locked_project_id
    from public.lock_memory_conversation_source(
      p_source_surface, p_source_chat_id, p_updated_by
    ) locked;
    if not found then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
    select * into activity from public.memory_conversation_activity
    where surface = p_source_surface and conversation_id = p_source_chat_id
    for update;
    if not found
      or activity.deleted_at is not null
      or activity.source_epoch <> p_source_epoch
      or activity.generation <> p_conversation_generation
    then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
    if activity.quiet_until is null
      or activity.quiet_until > now()
      or exists (
        select 1 from public.memory_conversation_turn_leases lease
        where lease.surface = p_source_surface
          and lease.conversation_id = p_source_chat_id
          and lease.expires_at > now()
      )
    then
      raise exception using errcode = '55000', message = 'memory_conversation_not_quiet';
    end if;
    select * into consolidation from public.memory_consolidation_states
    where id = p_consolidation_state_id for update;
    if not found
      or consolidation.generation <> p_consolidation_generation
      or consolidation.conversation_generation <> p_conversation_generation
      or consolidation.surface <> p_source_surface
      or consolidation.conversation_id <> p_source_chat_id
      or consolidation.source_epoch <> p_source_epoch
      or consolidation.actor_user_id is distinct from p_updated_by
    then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
  end if;

  select * into target from public.memory_files
  where id = p_memory_file_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  -- A curator job that is retried after its transaction already committed
  -- must not apply the same replacement twice.
  if p_source_job_id is not null
    and target.last_source_job_id = p_source_job_id
  then
    return query select false, target.revision;
    return;
  end if;

  if p_source = 'curator' then
    if (target.scope = 'user' and target.user_id <> consolidation.actor_user_id)
      or (target.scope = 'project' and target.project_id is distinct from consolidation.project_id)
    then
      raise exception using errcode = 'P0001', message = 'memory_job_superseded';
    end if;
    if target.scope = 'user'
      and not public.memory_source_allows_app_memory(
        p_source_surface, p_source_chat_id, p_updated_by, activity.project_id
      )
    then
      raise exception using errcode = 'P0001', message = 'memory_scope_ineligible';
    end if;
  end if;

  if not target.enabled then
    raise exception using errcode = 'P0001', message = 'memory_disabled';
  end if;
  if target.epoch <> p_expected_epoch then
    raise exception using errcode = 'P0001', message = 'memory_epoch_conflict';
  end if;
  if target.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'memory_revision_conflict';
  end if;

  -- An unchanged body is not a write: it would burn a revision and, for the
  -- curator, look like new learning in the audit trail. The job receipt is
  -- still stamped so a retried job is recognised above and applied once.
  if target.content_sha256 is not distinct from p_content_sha256 then
    if p_source_job_id is not null then
      update public.memory_files
      set last_source_job_id = p_source_job_id
      where id = p_memory_file_id;
      insert into public.memory_consolidation_results(
        job_id, memory_file_id, scope, outcome, revision
      ) values (
        p_source_job_id, target.id, target.scope, 'no_change', target.revision
      ) on conflict (job_id, memory_file_id) do update
        set outcome = excluded.outcome,
            revision = excluded.revision,
            created_at = now();
    end if;
    return query select false, target.revision;
    return;
  end if;

  update public.memory_files
  set content = p_content,
      content_sha256 = p_content_sha256,
      size_bytes = p_size_bytes,
      revision = target.revision + 1,
      status = case
        when p_source in ('manual', 'restore') and target.status = 'failed' then 'idle'
        else target.status
      end,
      last_error_code = null,
      -- A restore is the person's own write of an earlier version.
      last_source = case when p_source = 'restore' then 'manual' else p_source end,
      last_source_job_id = p_source_job_id,
      updated_by = p_updated_by,
      updated_at = now()
  where id = p_memory_file_id;

  perform public.record_memory_file_version(
    target.id, target.revision + 1, p_content, p_content_sha256, p_size_bytes,
    p_source, p_change_summary, p_updated_by, p_source_chat_id
  );

  if p_source_job_id is not null then
    insert into public.memory_consolidation_results(
      job_id, memory_file_id, scope, outcome, revision
    ) values (
      p_source_job_id, target.id, target.scope, 'updated', target.revision + 1
    ) on conflict (job_id, memory_file_id) do update
      set outcome = excluded.outcome,
          revision = excluded.revision,
          created_at = now();
  end if;

  return query select true, target.revision + 1;
end;
$$;

create or replace function public.wipe_memory_file(
  p_memory_file_id uuid,
  p_enabled boolean,
  p_updated_by uuid default null,
  p_source text default 'wipe',
  p_delete_history boolean default false
)
returns table(
  new_epoch bigint,
  new_revision bigint,
  effective_enabled boolean,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.memory_files%rowtype;
  changed_at timestamptz := now();
begin
  if p_source not in ('wipe', 'settings') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  select * into target from public.memory_files
  where id = p_memory_file_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'memory_file_not_found';
  end if;

  -- The body lives on this row, so erasure is the same UPDATE that fences
  -- in-flight curator work: the epoch bump supersedes any job that read the
  -- old content, and the revision bump invalidates loaded editor drafts.
  update public.memory_files
  set enabled = coalesce(p_enabled, target.enabled),
      epoch = target.epoch + 1,
      revision = target.revision + 1,
      learning_cutoff_at = changed_at,
      content = '',
      content_sha256 = null,
      size_bytes = 0,
      status = 'idle',
      last_error_code = null,
      last_source = p_source,
      last_source_job_id = null,
      updated_by = p_updated_by,
      updated_at = changed_at
  where id = target.id;

  -- Turning memory off keeps what it held as a version, so it can be
  -- restored; deleting memory deletes its history with it.
  if p_delete_history then
    delete from public.memory_file_versions where memory_file_id = target.id;
  elsif target.content_sha256 is not null then
    perform public.record_memory_file_version(
      target.id, target.revision + 1, '', null, 0, p_source, null, p_updated_by, null
    );
  end if;

  return query select
    target.epoch + 1,
    target.revision + 1,
    coalesce(p_enabled, target.enabled),
    changed_at,
    p_updated_by;
end;
$$;

create or replace function public.delete_user_private_memories(
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  deleted_projects integer := 0;
begin
  -- Lock the caller's own private projects rather than the whole table.
  -- FOR UPDATE on a project row blocks both a move into an organization (an
  -- UPDATE of that row) and a new access grant (the grant's foreign key takes
  -- KEY SHARE on the project, which FOR UPDATE excludes), so eligibility
  -- cannot change between this check and the wipe. A table-level SHARE lock
  -- did the same job by stalling every project write in the system for as
  -- long as this user's files took to wipe.
  perform project.id from public.projects project
  where project.user_id = p_user_id and project.org_id is null
  order by project.id
  for update;

  insert into public.memory_files(scope, user_id, enabled)
  values ('user', p_user_id, true)
  on conflict (user_id) do nothing;

  for target in
    select eligible.id, eligible.scope
    from (
      select file.id, file.scope
      from public.memory_files file
      where file.scope = 'user' and file.user_id = p_user_id
      union all
      select file.id, file.scope
      from public.memory_files file
      join public.projects project on project.id = file.project_id
      where file.scope = 'project'
        and project.user_id = p_user_id
        and project.org_id is null
        and not exists (
          select 1 from public.project_access_grants grant_row
          where grant_row.project_id = project.id
        )
    ) eligible
    order by eligible.id
  loop
    perform public.wipe_memory_file(target.id, null, p_user_id, 'wipe', true);
    if target.scope = 'project' then
      deleted_projects := deleted_projects + 1;
    end if;
  end loop;

  return deleted_projects;
end;
$$;

revoke all on function public.record_memory_file_version(uuid, bigint, text, text, integer, text, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint, text)
  from public, anon, authenticated;
revoke all on function public.wipe_memory_file(uuid, boolean, uuid, text, boolean)
  from public, anon, authenticated;
grant execute
  on function public.record_memory_file_version(uuid, bigint, text, text, integer, text, text, uuid, uuid)
  to service_role;
grant execute
  on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint, text)
  to service_role;
grant execute
  on function public.wipe_memory_file(uuid, boolean, uuid, text, boolean)
  to service_role;

-- What each memory file holds now is its first version.
insert into public.memory_file_versions(
  memory_file_id, version_number, revision, content, content_sha256,
  size_bytes, source, updated_by, created_at, updated_at
)
select file.id, 1, file.revision, file.content, file.content_sha256,
  file.size_bytes,
  case when file.last_source = 'curator' then 'curator' else 'manual' end,
  file.updated_by, file.updated_at, file.updated_at
from public.memory_files file
where file.content_sha256 is not null
  and not exists (
    select 1 from public.memory_file_versions version
    where version.memory_file_id = file.id
  );
