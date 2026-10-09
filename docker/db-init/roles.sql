-- Runs once, when the Postgres volume is first initialized, as the superuser.
--
-- supabase_auth_admin is GoTrue's conventional role: it owns the auth schema,
-- where GoTrue builds auth.users and its other tables on start. anon,
-- authenticated and service_role never log in and Mike never uses them; they
-- exist so schema.sql's grants and row-level security (which deny them, for a
-- deployment that keeps its database on a hosted Supabase) apply unchanged.
do $$
begin
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin with login noinherit createrole password 'postgres';
  end if;
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
