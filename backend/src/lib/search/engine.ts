import crypto from "node:crypto";
import type { FetchedPage, SearchOptions, SearchResult } from "./types";
import { getProviderAdapter } from "./providers";
import { assertSafeEgressUrl } from "./egress";

// In-memory snapshot cache for citation verification: url -> FetchedPage.
// Bounded: the oldest entries go first once it holds MAX_SNAPSHOTS.
const snapshotStore = new Map<string, FetchedPage>();
const MAX_SNAPSHOTS = 2_000;

function remember(key: string, snapshot: FetchedPage): void {
  snapshotStore.delete(key);
  snapshotStore.set(key, snapshot);
  while (snapshotStore.size > MAX_SNAPSHOTS) {
    const oldest = snapshotStore.keys().next().value;
    if (oldest === undefined) break;
    snapshotStore.delete(oldest);
  }
}

/** The URL forms a snapshot is found under: as given, and without query or trailing slash. */
function snapshotKeys(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    return [...new Set([url.toString(), url.origin + url.pathname, url.origin + url.pathname.replace(/\/+$/, "")])];
  } catch {
    return [rawUrl];
  }
}

/**
 * Searches the web using the configured modular search adapter (Keenable, Tavily, Exa, Parallel).
 * Each result's text (the provider's page content, else its snippet) is kept
 * as a snapshot so a web citation of it can be checked, unless the page
 * itself was fetched, which is the better source.
 */
export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const adapter = getProviderAdapter(options.provider);
  const results = await adapter.search(query, options);
  for (const result of results) {
    const content = (result.rawContent || result.snippet || "").trim();
    if (!result.url || !content) continue;
    const keys = snapshotKeys(result.url);
    if (keys.some((key) => snapshotStore.get(key)?.source === "fetch")) continue;
    const snapshot: FetchedPage = {
      url: result.url,
      title: result.title,
      content,
      contentSha256: crypto.createHash("sha256").update(content).digest("hex"),
      fetchedAt: new Date().toISOString(),
      source: "search",
    };
    for (const key of keys) remember(key, snapshot);
  }
  return results;
}

/**
 * Fetches an external web page, enforces SSRF/private-mode guards, extracts text,
 * hashes the content, and stores the snapshot for reproducible citation verification.
 */
export async function fetchPage(
  rawUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<FetchedPage> {
  const safeUrl = await assertSafeEgressUrl(rawUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);

  try {
    const res = await fetch(safeUrl.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent": "MikeLegalAssistant/1.0 (+https://open-legal-products.org/mike)",
        Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch web page (${res.status}): ${res.statusText}`);
    }

    const htmlOrText = await res.text();
    const cleanContent = stripHtmlToText(htmlOrText);
    const contentSha256 = crypto
      .createHash("sha256")
      .update(cleanContent)
      .digest("hex");

    const snapshot: FetchedPage = {
      url: safeUrl.toString(),
      content: cleanContent,
      contentSha256,
      fetchedAt: new Date().toISOString(),
      source: "fetch",
    };

    for (const key of snapshotKeys(safeUrl.toString())) remember(key, snapshot);

    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retrieves a retained web snapshot for citation verification.
 */
export function getWebSnapshot(url: string): FetchedPage | undefined {
  for (const key of snapshotKeys(url)) {
    const snapshot = snapshotStore.get(key);
    if (snapshot) return snapshot;
  }
  return undefined;
}

/**
 * Manually stores a web snapshot (used in test fixtures or mock streams).
 */
export function storeWebSnapshot(snapshot: FetchedPage): void {
  remember(snapshot.url, snapshot);
}

/**
 * Clears retained web snapshots at the end of a session/turn.
 */
export function clearWebSnapshots(): void {
  snapshotStore.clear();
}

/**
 * Lightweight deterministic HTML-to-text converter that strips scripts/styles
 * and preserves readable prose and structural linebreaks.
 */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}
