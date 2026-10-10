-- Migration date: 2026-10-10
--
-- service_role's data privileges on chat_turn_claims. A fresh install gets
-- them from schema.sql's blanket `grant ... on all tables in schema public to
-- service_role`; 20261010_01 created the table without them, so upgraded
-- deployments differed from fresh ones (schema-drift check). Browser roles
-- still get nothing.
--
-- Re-runnable: grants are idempotent.

grant select, insert, update, delete
  on public.chat_turn_claims
  to service_role;
