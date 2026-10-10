-- Migration date: 2026-10-10
--
-- Guests running code in a shared thread. A thread's code runs in the
-- workstation of the person who started it (the host). When someone else's
-- message makes the assistant run a command there, the turn waits for the
-- host to decide:
--
--   pending  waiting for the host
--   once     allowed for that message's turn
--   thread   allowed for the guest's turns in this thread from now on
--   denied   refused
--   expired  the host did not answer in time
--   revoked  a thread approval the host later withdrew
--
-- Approvals never reach another thread: every row names its chat.
--
-- Re-runnable: create if not exists.

create table if not exists public.chat_code_approvals (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  guest_user_id uuid not null references auth.users(id) on delete cascade,
  summary text not null default '' check (char_length(summary) <= 2000),
  status text not null default 'pending'
    check (status in ('pending', 'once', 'thread', 'denied', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists chat_code_approvals_chat_idx
  on public.chat_code_approvals (chat_id, status);

alter table public.chat_code_approvals enable row level security;
revoke all on table public.chat_code_approvals from public, anon, authenticated;
grant select, insert, update, delete on public.chat_code_approvals to service_role;
