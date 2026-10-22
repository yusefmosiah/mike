-- Migration date: 2026-10-22
-- The background memory curator no longer has a model of its own: it runs as
-- a turn on the conversation's own model, on a fork of the conversation so the
-- provider's prompt cache is reused. The per-user curation model preference
-- is therefore gone, and so is its column.

alter table public.user_profiles drop column if exists memory_curator_model;
