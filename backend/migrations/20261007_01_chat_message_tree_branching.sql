-- Migration date: 2026-10-07
-- Description: Chat message tree (parent_message_id) + per-user leaf state
-- (chat_leaf_state) for branching conversations.
--
-- Messages are immutable once persisted: an edit or regeneration INSERTs a
-- sibling and moves the caller's leaf pointer instead of updating existing
-- content. Every statement is idempotent so the Compose replay can re-run it.
alter table if exists public.chat_messages
  add column if not exists parent_message_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chat_messages_parent_message_id_fkey'
      and conrelid = 'public.chat_messages'::regclass
  ) then
    alter table public.chat_messages
      add constraint chat_messages_parent_message_id_fkey
      foreign key (parent_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end
$$;

create index if not exists chat_messages_chat_parent_idx
  on public.chat_messages(chat_id, parent_message_id);

create table if not exists public.chat_leaf_state (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  leaf_message_id uuid not null references public.chat_messages(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create index if not exists chat_leaf_state_leaf_idx
  on public.chat_leaf_state(leaf_message_id);

alter table public.chat_leaf_state enable row level security;

drop policy if exists "Users can manage their own chat leaf state" on public.chat_leaf_state;
create policy "Users can manage their own chat leaf state"
  on public.chat_leaf_state
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.chat_leaf_state to authenticated;
grant all on public.chat_leaf_state to service_role;

-- Backfill parent links chronologically for transcripts written before the
-- tree existed: within each chat, an assistant links to the most recent user
-- message before it and a user links to the most recent assistant before it
-- (in alternating transcripts that is simply the preceding message). The
-- first message of a chat keeps a null parent. Already-linked rows are left
-- alone so a replay cannot rewrite a tree that live code has since built.
with ordered as (
  select
    id,
    chat_id,
    role,
    row_number() over (partition by chat_id order by created_at, id) as rn
  from public.chat_messages
  where role in ('user', 'assistant')
),
linked as (
  select
    id,
    chat_id,
    case
      when role = 'assistant' then max(case when role = 'user' then rn end)
        over (
          partition by chat_id
          order by rn
          rows between unbounded preceding and 1 preceding
        )
      else max(case when role = 'assistant' then rn end)
        over (
          partition by chat_id
          order by rn
          rows between unbounded preceding and 1 preceding
        )
    end as parent_rn
  from ordered
)
update public.chat_messages as message
set parent_message_id = parent.id
from linked
join ordered as parent
  on parent.chat_id = linked.chat_id
 and parent.rn = linked.parent_rn
where message.id = linked.id
  and message.parent_message_id is null
  and linked.parent_rn is not null;
