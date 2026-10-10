-- Migration date: 2026-10-10
--
-- Firm thread handoff (goals/mission-5-firm-thread-handoff.md).
--
-- 1. chat_turn_claims: one generating turn per thread, fenced in the
--    database so the rule holds across backend replicas, not only inside one
--    process (lib/assistantTurnRuns.ts). A claim names the turn, the person
--    whose send started it and the role they held, and carries a lease the
--    running process renews; a process that dies stops renewing, and the
--    claim lapses so the thread is not stuck. The same turn may re-claim (a
--    restart resuming it).
-- 2. document_versions.created_by: who produced each version, written by
--    create_document_version from the version's `created_by`.
--
-- Re-runnable: create if not exists, create or replace, add column if not
-- exists.

create table if not exists public.chat_turn_claims (
  surface text not null check (surface in ('chat', 'tabular', 'word')),
  chat_id uuid not null,
  turn_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (surface, chat_id)
);

create index if not exists chat_turn_claims_actor_idx
  on public.chat_turn_claims(actor_user_id)
  where actor_user_id is not null;

alter table public.chat_turn_claims enable row level security;
revoke all on table public.chat_turn_claims from public, anon, authenticated;

-- Grants the thread to p_turn_id unless another live turn holds it. Returns
-- one row: granted, plus the holder (the caller when granted).
create or replace function public.claim_chat_turn(
  p_surface text,
  p_chat_id uuid,
  p_turn_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_lease_seconds integer
)
returns table(
  granted boolean,
  holder_turn_id uuid,
  holder_actor_user_id uuid,
  holder_actor_role text,
  holder_claimed_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claim public.chat_turn_claims%rowtype;
begin
  if p_surface not in ('chat', 'tabular', 'word')
    or p_chat_id is null or p_turn_id is null
    or p_lease_seconds < 10 or p_lease_seconds > 3600
  then
    raise exception using errcode = '22023', message = 'invalid_turn_claim';
  end if;

  insert into public.chat_turn_claims as c (
    surface, chat_id, turn_id, actor_user_id, actor_role, claimed_at, expires_at
  ) values (
    p_surface, p_chat_id, p_turn_id, p_actor_user_id, p_actor_role, now(),
    now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (surface, chat_id) do update set
    turn_id = excluded.turn_id,
    actor_user_id = excluded.actor_user_id,
    actor_role = excluded.actor_role,
    claimed_at = case when c.turn_id = excluded.turn_id then c.claimed_at else now() end,
    expires_at = excluded.expires_at
  where c.expires_at <= now() or c.turn_id = excluded.turn_id
  returning c.* into claim;

  if found then
    return query select true, claim.turn_id, claim.actor_user_id, claim.actor_role, claim.claimed_at;
    return;
  end if;

  select * into claim from public.chat_turn_claims
  where surface = p_surface and chat_id = p_chat_id;
  return query select false, claim.turn_id, claim.actor_user_id, claim.actor_role, claim.claimed_at;
end;
$$;

-- Extends a held claim; false when the turn no longer holds it.
create or replace function public.renew_chat_turn(
  p_surface text,
  p_chat_id uuid,
  p_turn_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'invalid_turn_claim';
  end if;
  update public.chat_turn_claims
  set expires_at = now() + make_interval(secs => p_lease_seconds)
  where surface = p_surface and chat_id = p_chat_id and turn_id = p_turn_id;
  return found;
end;
$$;

-- Ends a claim; a no-op when another turn holds the thread by now.
create or replace function public.release_chat_turn(
  p_surface text,
  p_chat_id uuid,
  p_turn_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.chat_turn_claims
  where surface = p_surface and chat_id = p_chat_id and turn_id = p_turn_id;
$$;

revoke all on function public.claim_chat_turn(text, uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.renew_chat_turn(text, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_chat_turn(text, uuid, uuid)
  from public, anon, authenticated;

alter table public.document_versions
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- The one place versions are created (documents module); now records who.
create or replace function public.create_document_version(
  p_document_id uuid, p_version jsonb, p_activate boolean default true
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := coalesce((p_version->>'id')::uuid, gen_random_uuid());
  v_row public.document_versions%rowtype;
  v_number integer;
begin
  perform 1 from public.documents where id = p_document_id for update;
  if not found then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.document_versions where id = v_id;
  if found then
    if v_row.document_id <> p_document_id or v_row.deleted_at is not null then
      raise exception 'version_identity_conflict' using errcode = '23505';
    end if;
    -- An upload retry must not overwrite metadata or reactivate an older
    -- version after somebody has already created a newer one.
    return to_jsonb(v_row);
  end if;
  v_number := (p_version->>'version_number')::integer;
  if v_number is null then
    select coalesce(max(version_number), 1) + 1 into v_number
    from public.document_versions
    where document_id = p_document_id
      and source in ('upload', 'user_upload', 'assistant_edit');
  end if;
  insert into public.document_versions(
    id, document_id, storage_path, pdf_storage_path, source, version_number,
    filename, file_type, size_bytes, page_count, content_sha256, created_by
  ) values (
    v_id, p_document_id, p_version->>'storage_path', p_version->>'pdf_storage_path',
    coalesce(p_version->>'source', 'upload'), v_number,
    p_version->>'filename', p_version->>'file_type',
    (p_version->>'size_bytes')::integer, (p_version->>'page_count')::integer,
    p_version->>'content_sha256', (p_version->>'created_by')::uuid
  ) returning * into v_row;
  if p_activate then
    update public.documents set current_version_id = v_id, updated_at = now()
      where id = p_document_id;
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.create_document_version(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_document_version(uuid, jsonb, boolean) to service_role;
