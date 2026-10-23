-- Migration date: 2026-10-22
-- Description: Background subagents and their messages to the chat.
--
-- `user_profiles.background_agents` is the person's setting for background
-- subagents: off by default while the feature is tested. With it on, the
-- assistant may start subagents that keep working after its answer and
-- report into the chat when they finish.
--
-- `chat_messages.origin` says where a message came from when no person wrote
-- it: reports and messages from the chat's background subagents, delivered
-- while the chat was idle (the MessageOrigin contract). Null for anything a
-- person wrote. Idempotent.
alter table if exists public.user_profiles
  add column if not exists background_agents boolean not null default false;
alter table if exists public.chat_messages
  add column if not exists origin jsonb;
