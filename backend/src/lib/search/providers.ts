import type { SearchOptions, SearchResult, SearchProvider } from "./types";

export interface ProviderAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

export class KeenableAdapter implements ProviderAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = options.apiKey || process.env.KEENABLE_API_KEY;
    if (!apiKey) {
      throw new Error("Keenable API key not configured (set KEENABLE_API_KEY).");
    }

    const maxResults = options.limit ?? 10;
    const res = await fetch("https://api.keenable.ai/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Keenable search failed (${res.status}): ${errText || res.statusText}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        description?: string;
        published_date?: string;
        score?: number;
      }>;
    };

    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.snippet ?? r.description ?? "",
      publishedDate: r.published_date,
      score: r.score,
    }));
  }
}

export class TavilyAdapter implements ProviderAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = options.apiKey || process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("Tavily API key not configured (set TAVILY_API_KEY).");
    }

    const maxResults = options.limit ?? 10;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_raw_content: options.includeRawContent ?? false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Tavily search failed (${res.status}): ${errText || res.statusText}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        published_date?: string;
        score?: number;
        raw_content?: string;
      }>;
    };

    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
      publishedDate: r.published_date,
      score: r.score,
      rawContent: r.raw_content,
    }));
  }
}

export class ExaAdapter implements ProviderAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = options.apiKey || process.env.EXA_API_KEY;
    if (!apiKey) {
      throw new Error("Exa API key not configured (set EXA_API_KEY).");
    }

    const numResults = options.limit ?? 10;
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        numResults,
        contents: { text: { maxCharacters: 1500 } },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Exa search failed (${res.status}): ${errText || res.statusText}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        publishedDate?: string;
        score?: number;
      }>;
    };

    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.text ?? "",
      publishedDate: r.publishedDate,
      score: r.score,
    }));
  }
}

export class ParallelAdapter implements ProviderAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = options.apiKey || process.env.PARALLEL_API_KEY;
    if (!apiKey) {
      throw new Error("Parallel API key not configured (set PARALLEL_API_KEY).");
    }

    const res = await fetch("https://api.parallel.ai/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        search_queries: [query],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Parallel search failed (${res.status}): ${errText || res.statusText}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        excerpts?: string[];
        publish_date?: string;
        relevance?: number;
      }>;
    };

    const limit = options.limit ?? 10;
    return (data.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: Array.isArray(r.excerpts) ? r.excerpts.join("\n") : "",
      publishedDate: r.publish_date,
      score: r.relevance,
    }));
  }
}

export function getProviderAdapter(providerName?: SearchProvider): ProviderAdapter {
  const chosen =
    providerName ||
    (process.env.SEARCH_PROVIDER as SearchProvider) ||
    "keenable";

  switch (chosen.toLowerCase()) {
    case "tavily":
      return new TavilyAdapter();
    case "exa":
      return new ExaAdapter();
    case "parallel":
      return new ParallelAdapter();
    case "keenable":
    default:
      return new KeenableAdapter();
  }
}
