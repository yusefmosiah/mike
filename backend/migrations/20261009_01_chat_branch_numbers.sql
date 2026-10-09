-- Migration date: 2026-10-09
-- Description: Number the threads branched off a chat ("BRANCH Title",
-- "BRANCH 2 Title", ...).
--
-- A branched thread records the chat its family started from and its place
-- in that family. The root is a plain uuid, not a foreign key: deleting the
-- original chat must not renumber, or merge, the branches that outlive it.
-- Idempotent.
alter table if exists public.chats
  add column if not exists branch_root_chat_id uuid;

alter table if exists public.chats
  add column if not exists branch_number integer;

alter table public.chats
  drop constraint if exists chats_branch_number_positive;
alter table public.chats
  add constraint chats_branch_number_positive
  check (branch_number is null or branch_number >= 1);

create index if not exists chats_branch_root_idx
  on public.chats(branch_root_chat_id)
  where branch_root_chat_id is not null;
