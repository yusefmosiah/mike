-- Migration date: 2026-10-22
--
-- The assistant can edit memory from a conversation. Its writes are a new
-- source, 'assistant': a version of their own (never merged into the
-- person's editor version), recorded with the conversation they came from.
-- write_memory_file accepts the source only with that conversation, and
-- only for app memory from the person's own private conversation or for the
-- memory of the conversation's project. Re-runnable.

alter table public.memory_file_versions
  drop constraint if exists memory_file_versions_source_check;
alter table public.memory_file_versions
  add constraint memory_file_versions_source_check
  check (source in ('manual', 'curator', 'restore', 'assistant', 'settings', 'wipe'));

alter table public.memory_files
  drop constraint if exists memory_files_last_source_check;
alter table public.memory_files
  add constraint memory_files_last_source_check
  check (last_source is null or last_source in ('manual', 'curator', 'assistant', 'wipe', 'settings'));

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
  assistant_project_id uuid;
begin
  if p_source not in ('manual', 'curator', 'restore', 'assistant') then
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

  -- The assistant edits memory from inside one conversation, on behalf of
  -- the person in it. Lock that conversation the way the curator does, so
  -- its project and sharing cannot change under the write.
  if p_source = 'assistant' then
    if p_source_surface is null
      or p_source_chat_id is null
      or p_updated_by is null
    then
      raise exception using errcode = '22023', message = 'memory_assistant_source_required';
    end if;
    select locked.locked_project_id into assistant_project_id
    from public.lock_memory_conversation_source(
      p_source_surface, p_source_chat_id, p_updated_by
    ) locked;
    if not found then
      raise exception using errcode = 'P0001', message = 'memory_assistant_scope_ineligible';
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

  -- App memory only from the person's own private conversation; project
  -- memory only from a conversation in that project. Whether the person may
  -- edit the project's content is checked before the call.
  if p_source = 'assistant' then
    if (target.scope = 'user' and (
          target.user_id <> p_updated_by
          or not public.memory_source_allows_app_memory(
            p_source_surface, p_source_chat_id, p_updated_by, assistant_project_id
          )
        ))
      or (target.scope = 'project'
        and target.project_id is distinct from assistant_project_id)
    then
      raise exception using errcode = 'P0001', message = 'memory_assistant_scope_ineligible';
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

revoke all on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.write_memory_file(uuid, bigint, bigint, text, text, integer, text, uuid, text, uuid, uuid, uuid, bigint, bigint, bigint, text)
  to service_role;
