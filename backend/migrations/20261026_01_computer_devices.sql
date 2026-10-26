-- Migration date: 2026-10-26
--
-- A person's own computers, driven from chat through a local helper app
-- (computer-helper/). Each device authenticates with a bearer token shown
-- once when it is added; only the token's SHA-256 is stored. A revoked
-- device keeps its row so its history stays readable.
create table if not exists public.computer_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint computer_devices_token_hash_key unique (token_hash)
);
create index if not exists computer_devices_user_idx
  on public.computer_devices(user_id, created_at desc);

alter table public.computer_devices enable row level security;
revoke all on table public.computer_devices from public, anon, authenticated;
grant select, insert, update, delete on public.computer_devices to service_role;
