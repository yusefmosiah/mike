export type SearchProvider = "keenable" | "tavily" | "exa" | "parallel";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  score?: number;
  rawContent?: string;
}

export interface SearchOptions {
  limit?: number;
  provider?: SearchProvider;
  apiKey?: string;
  includeRawContent?: boolean;
}

export interface FetchedPage {
  url: string;
  title?: string;
  content: string;
  contentSha256: string;
  fetchedAt: string;
}
