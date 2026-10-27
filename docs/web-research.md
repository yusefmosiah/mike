# Web research

The assistant can search the web and read a page as clean text. Both tools
respect the deployment's egress rules.

## Tools

- `web_search` returns ranked `{title, url, snippet}` results. The deployment
  can configure Tavily (`TAVILY_API_KEY`), Exa (`EXA_API_KEY`) or Parallel
  (`PARALLEL_API_KEY`); a call may name one of those providers, and the
  built-in provider needs no key.
- `fetch_web_page` returns one window of a page's text (`offset` and
  `max_chars`, at most 40,000 characters). The snapshot is stored with its
  `sha256`, so a citation can be checked against exactly what the model read.
  Long pages are paged with `next_offset`.

Fetched pages and search results are untrusted content: the model is told to
treat instructions inside them as data, not commands. Web pages cited in an
answer open as the saved reader copy.

State as of 2026-10-27; re-read `backend/src/lib/search/` and
`backend/src/modules/chat/engine/tools/toolSchemas.ts` before relying on
provider or parameter lists.
