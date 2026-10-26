-- Migration date: 2026-10-26
--
-- What each computer's helper reports in its heartbeat: its platform
-- (macos, windows, linux, sandbox) and what it can do there, so chat can
-- tell the model, for example, that a Wayland desktop takes clicks on
-- listed elements only.
alter table public.computer_devices add column if not exists platform text;
alter table public.computer_devices add column if not exists capabilities jsonb;

alter table public.computer_devices drop constraint if exists computer_devices_platform_check;
alter table public.computer_devices add constraint computer_devices_platform_check
  check (platform is null or platform in ('macos', 'windows', 'linux', 'sandbox'));
