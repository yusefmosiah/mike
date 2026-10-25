-- Migration date: 2026-10-25
-- Appearance can follow the device: dark_mode null means match the system's
-- light or dark setting, true and false are the person's explicit choice.
-- Existing accounts keep their choice; new accounts follow the system.
alter table public.user_profiles
  alter column dark_mode drop not null;
alter table public.user_profiles
  alter column dark_mode set default null;
