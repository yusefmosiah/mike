// The product's name and the facts said alongside it, from
// packages/brand/brand.json: the one file an install replaces to rebrand
// (packages/brand/README.md). The web app and Word add-in bundle the same file.
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Brand {
  name: string;
  description: string;
  website: string;
  sourceUrl: string;
}

// Three directories up is the repository root both from src/lib (tests) and
// from dist/lib (the image, where backend/ is /app and the Dockerfile copies
// packages/brand to /packages/brand).
export const BRAND_FILE = path.resolve(__dirname, "../../../packages/brand/brand.json");

export function parseBrand(text: string): Brand {
  const value: unknown = JSON.parse(text);
  const fields = ["name", "description", "website", "sourceUrl"] as const;
  if (typeof value !== "object" || value === null) throw new Error("brand.json must be an object");
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const entry = record[field];
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`brand.json needs a non-empty "${field}"`);
  }
  return {
    name: (record.name as string).trim(),
    description: (record.description as string).trim(),
    website: (record.website as string).trim(),
    sourceUrl: (record.sourceUrl as string).trim(),
  };
}

export const BRAND: Brand = parseBrand(readFileSync(BRAND_FILE, "utf8"));
