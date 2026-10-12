-- Migration date: 2026-10-12
--
-- Web citations open a saved copy of the page in the document panel's
-- reader view instead of linking off to the live site. A web snapshot keeps
-- the page's main content as Markdown for that view; `content` stays the
-- plain text the cited quotes were checked against.

alter table public.citation_snapshots
  add column if not exists reader_markdown text;
