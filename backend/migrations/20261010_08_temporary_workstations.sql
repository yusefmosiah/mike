-- Migration date: 2026-10-10
--
-- Temporary workstation VMs for test accounts. A test account (its email
-- matches WORKSTATION_TEMPORARY_EMAILS) is given a pool VM marked temporary.
-- Once it has gone unused for a while the backend asks the host to wipe the
-- VM's disk and deletes the row, which returns the VM to the pool.
--
--   temporary     the VM is wiped and returned once idle
--   last_used_at  the account's latest turn on the VM
--   wiping        a wipe is in progress or failed; the VM is not handed out
--
-- Re-runnable: add column if not exists.

alter table public.workstation_assignments
  add column if not exists temporary boolean not null default false,
  add column if not exists last_used_at timestamptz not null default now(),
  add column if not exists wiping boolean not null default false;

create index if not exists workstation_assignments_temporary_idx
  on public.workstation_assignments (last_used_at)
  where temporary;
