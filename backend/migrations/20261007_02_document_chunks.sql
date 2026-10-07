-- Migration date: 2026-10-07
-- Description: document_chunks — the retrieval service's text chunks — plus
-- the two search functions the ranker calls (trigram similarity + literal
-- ILIKE).
--
-- Retrieval here is keyword-only on purpose: this deployment has no pgvector
-- and no embedding pipeline, so the hybrid ranker fuses exact substring
-- matches (ILIKE, GIN trigram index) with word-level trigram similarity
-- (word_similarity) in application code. Chunks carry page provenance
-- (page_no + page_source) so citation checking can tell extracted text from
-- OCR output downstream.
--
-- Service-role only: the backend reads and writes chunks, browser roles get
-- no grant, and RLS is enabled with no policies as defense in depth
-- (service_role bypasses it for the backend path). Every statement is
-- idempotent so the Compose replay can re-run it.

create extension if not exists pg_trgm;

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  page_no integer,
  page_source text not null default 'text'
    constraint document_chunks_page_source_check
    check (page_source in ('text', 'ocr')),
  created_at timestamptz not null default now()
);

-- Re-indexing a version is delete-then-insert (see retrieval.search.ts). The
-- unique key makes a re-run that races another indexer fail loudly instead of
-- silently doubling a version's chunks; it also serves the per-version
-- delete. The wider key is the requested document/version/chunk lookup path.
create unique index if not exists document_chunks_version_chunk_idx
  on public.document_chunks(version_id, chunk_index);

create index if not exists document_chunks_document_version_idx
  on public.document_chunks(document_id, version_id, chunk_index);

create index if not exists document_chunks_content_trgm_idx
  on public.document_chunks using gin (content gin_trgm_ops);

alter table public.document_chunks enable row level security;

revoke all on public.document_chunks from public, anon, authenticated;
grant select, insert, update, delete on public.document_chunks to service_role;

-- Trigram arm. word_similarity ranks the caller's query (needle) against the
-- most similar window of each chunk (haystack); the <% operator is the
-- index-backed filter under a lowered word_similarity threshold — the 0.6
-- default is tuned for "did the user misspell this word", which is far too
-- strict for retrieval recall. The literal ILIKE arm does the precision work
-- in the ranker, so this arm only has to surface genuinely similar wording.
--
-- The search path names both schemas pg_trgm can live in: this repo installs
-- it into public (self-hosted schema.sql / migrations), while hosted Supabase
-- pre-installs it in `extensions`. Listing both resolves word_similarity and
-- the <% operator in either deployment.
create or replace function public.search_document_chunks_trgm(
  p_query text,
  p_document_ids uuid[] default null,
  p_limit integer default 10
)
returns table (
  id uuid,
  document_id uuid,
  version_id uuid,
  chunk_index integer,
  content text,
  page_no integer,
  page_source text,
  score real
)
language plpgsql
volatile
set search_path = public, extensions
as $$
begin
  perform set_config('pg_trgm.word_similarity_threshold', '0.15', true);
  return query
  select
    ranked.id,
    ranked.document_id,
    ranked.version_id,
    ranked.chunk_index,
    ranked.content,
    ranked.page_no,
    ranked.page_source,
    ranked.score
  from (
    select
      c.id,
      c.document_id,
      c.version_id,
      c.chunk_index,
      c.content,
      c.page_no,
      c.page_source,
      word_similarity(p_query, c.content)::real as score
    from public.document_chunks c
    join public.document_versions v
      on v.id = c.version_id and v.deleted_at is null
    where (p_document_ids is null or c.document_id = any (p_document_ids))
      and p_query <% c.content
  ) ranked
  order by ranked.score desc, ranked.id
  limit least(greatest(coalesce(p_limit, 10), 0), 100);
end;
$$;

revoke all on function public.search_document_chunks_trgm(text, uuid[], integer)
  from public, anon, authenticated;
grant execute on function public.search_document_chunks_trgm(text, uuid[], integer)
  to service_role;

-- Literal arm: substring containment, case-insensitive. The pattern is built
-- from the caller's query with LIKE metacharacters escaped (\ first, then %
-- and _) so a query like "50%" or "section_2" stays literal instead of
-- quietly turning into wildcards. ILIKE with a literal pattern uses the same
-- GIN trigram index as the similarity arm.
create or replace function public.search_document_chunks_keyword(
  p_query text,
  p_document_ids uuid[] default null,
  p_limit integer default 10
)
returns table (
  id uuid,
  document_id uuid,
  version_id uuid,
  chunk_index integer,
  content text,
  page_no integer,
  page_source text,
  score real
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    c.version_id,
    c.chunk_index,
    c.content,
    c.page_no,
    c.page_source,
    1.0::real as score
  from public.document_chunks c
  join public.document_versions v
    on v.id = c.version_id and v.deleted_at is null
  where (p_document_ids is null or c.document_id = any (p_document_ids))
    and c.content ilike
      '%' || replace(replace(replace(p_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
  order by c.document_id, c.version_id, c.chunk_index
  limit least(greatest(coalesce(p_limit, 10), 0), 100);
$$;

revoke all on function public.search_document_chunks_keyword(text, uuid[], integer)
  from public, anon, authenticated;
grant execute on function public.search_document_chunks_keyword(text, uuid[], integer)
  to service_role;
