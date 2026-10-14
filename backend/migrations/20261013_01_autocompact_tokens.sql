-- Migration date: 2026-10-13
-- Description: Let a user set, per model, where a long chat auto-compacts.
--
-- A map from a model id to a token threshold, set with `/autocompact <n>k` in
-- the chat composer. A model missing from the map uses the runtime's default
-- for its context window. Idempotent.
alter table if exists public.user_profiles
  add column if not exists autocompact_tokens jsonb not null default '{}'::jsonb;
