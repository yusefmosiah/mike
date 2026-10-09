-- Runs once, when the Postgres volume is first initialized, as the superuser.
--
-- gotrue is the auth server's role: it owns the auth schema, where GoTrue
-- builds auth.users and its other tables on start. anon, authenticated and
-- service_role never log in and Mike never uses them; schema.sql grants to them
-- and fences them off with row-level security, so they must exist.
do $$
begin
  if not exists (select from pg_roles where rolname = 'gotrue') then
    create role gotrue with login noinherit createrole password 'postgres';
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

create schema if not exists auth authorization gotrue;
grant create on database postgres to gotrue;
alter role gotrue set search_path = auth;
