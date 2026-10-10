-- Migration date: 2026-10-10
--
-- Workstation VMs per user (goals/mission-13-workstation-vms.md): which pool
-- VM belongs to which account. An account is given a free VM from the
-- deployment's pool (WORKSTATION_POOL) the first time it needs one, and keeps
-- it. The row outlives the account on purpose: the VM's disk still holds that
-- account's files, so it goes back to the pool only after an operator wipes
-- it and deletes the row.
--
-- Re-runnable: create table / index if not exists.

create table if not exists public.workstation_assignments (
  vm text primary key check (vm ~ '^[a-z0-9-]{1,32}$'),
  user_id uuid not null unique,
  assigned_at timestamptz not null default now()
);

alter table public.workstation_assignments enable row level security;
revoke all on table public.workstation_assignments from public, anon, authenticated;
grant select, insert, update, delete on public.workstation_assignments to service_role;
