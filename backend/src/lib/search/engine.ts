import crypto from "node:crypto";
import type { FetchedPage, SearchOptions, SearchResult } from "./types";
import { getProviderAdapter } from "./providers";
import { assertSafeEgressUrl } from "./egress";

// In-memory turn snapshot cache: url -> FetchedPage
const snapshotStore = new Map<string, FetchedPage>();

/**
 * Searches the web using the configured modular search adapter (Keenable, Tavily, Exa, Parallel).
 */
export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const adapter = getProviderAdapter(options.provider);
  return adapter.search(query, options);
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
    };

    snapshotStore.set(safeUrl.toString(), snapshot);
    // Also index by normalized URL without trailing slash or query
    snapshotStore.set(safeUrl.origin + safeUrl.pathname, snapshot);

    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retrieves a retained web snapshot for citation verification.
 */
export function getWebSnapshot(url: string): FetchedPage | undefined {
  return snapshotStore.get(url);
}

/**
 * Manually stores a web snapshot (used in test fixtures or mock streams).
 */
export function storeWebSnapshot(snapshot: FetchedPage): void {
  snapshotStore.set(snapshot.url, snapshot);
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
function stripHtmlToText(html: string): string {
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
