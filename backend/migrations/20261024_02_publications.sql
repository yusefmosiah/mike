-- Migration date: 2026-10-24
--
-- Published copies of documents (docs/publishing.md). A publication is a
-- frozen copy of one document version, served on the content origin to
-- anyone with its link, or with its link and a password. Its files are
-- copied under publications/{id}/ when it is made, so the content server
-- never reads the document store. The link's token is stored as a SHA-256
-- for lookup and sealed with the server key so its owner can copy it again.
create table if not exists public.publications (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete cascade,
  kind text not null,
  audience text not null,
  token_hash text not null,
  token_sealed text not null,
  password_hash text,
  password_version integer not null default 0,
  title text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint publications_kind_check check (kind in ('site', 'file')),
  constraint publications_audience_check check (audience in ('public', 'password')),
  constraint publications_password_check
    check ((audience = 'password') = (password_hash is not null)),
  constraint publications_token_hash_key unique (token_hash)
);
create index if not exists publications_document_idx
  on public.publications(document_id, created_at desc);
create index if not exists publications_created_by_idx
  on public.publications(created_by, created_at desc);

-- One row per file a publication serves, at its path on the content origin
-- ('index.html' for a page, its referenced files beside it).
create table if not exists public.publication_files (
  publication_id uuid not null references public.publications(id) on delete cascade,
  path text not null,
  storage_path text not null,
  content_type text not null,
  size_bytes bigint not null,
  primary key (publication_id, path)
);

alter table public.publications enable row level security;
alter table public.publication_files enable row level security;
revoke all on table public.publications from public, anon, authenticated;
revoke all on table public.publication_files from public, anon, authenticated;
grant select, insert, update, delete on public.publications to service_role;
grant select, insert, update, delete on public.publication_files to service_role;
