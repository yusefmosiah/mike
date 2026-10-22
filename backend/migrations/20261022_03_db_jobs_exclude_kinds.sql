-- Migration date: 2026-10-22
--
-- A job runner can claim every kind but some. Memory reviews run on a fork of
-- the chat's durable conversation, whose store has one owner process (the
-- API), so the background worker claims everything except them and the API
-- runs its own runner for them alone (p_kind).
--
-- The 3-argument signature is dropped rather than overloaded, for the same
-- reason the 2-argument one was: claim_db_jobs(5, 600) must resolve to one
-- function. Re-runnable.

drop function if exists public.claim_db_jobs(integer, integer);
drop function if exists public.claim_db_jobs(integer, integer, text);
create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600,
  p_kind text default null,
  p_exclude_kinds text[] default null
)
returns setof public.db_jobs
language sql set search_path = ''
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind not in ('storage.cleanup', 'document.cleanup')
       and (p_kind is null or kind = p_kind)
       and (p_exclude_kinds is null or kind <> all(p_exclude_kinds))
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (p_kind is null or kind = p_kind)
       and (p_exclude_kinds is null or kind <> all(p_exclude_kinds))
       and ((status = 'pending' and run_at <= now())
        -- Cleanup intents are retried forever, but politely: a revived
        -- `failed` row waits for its own run_at like everything else.
        or (status = 'failed'
            and kind in ('storage.cleanup', 'document.cleanup')
            and run_at <= now())
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind in ('storage.cleanup', 'document.cleanup')
            )))
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then 2147483647
           else j.max_attempts
         end,
         -- Back the revived row off before running it, so a claimant that
         -- fails the row back to `failed` (an old runner rejecting an unknown
         -- kind) cannot re-enter this branch on the next tick.
         run_at = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then now() + least(
               interval '10 minutes',
               make_interval(secs => 30 * least(j.attempts::bigint + 1, 20))
             )
           else j.run_at
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then null
           else j.dedupe_key
         end
    from candidates c
   where j.id = c.id
  returning j.*;
$$;
revoke all on function public.claim_db_jobs(integer, integer, text, text[])
  from public, anon, authenticated;
grant execute on function public.claim_db_jobs(integer, integer, text, text[])
  to service_role;
