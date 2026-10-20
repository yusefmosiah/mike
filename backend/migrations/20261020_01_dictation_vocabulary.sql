-- Migration date: 2026-10-20
-- Description: Let a user keep a dictation vocabulary.
--
-- An ordered JSON array of strings (names and terms dictation should spell
-- exactly), kept on the profile so it follows the person across the phone, the
-- browser and the Mac app. The service validates length and count. Idempotent.
alter table if exists public.user_profiles
  add column if not exists dictation_vocabulary jsonb not null default '[]'::jsonb;
