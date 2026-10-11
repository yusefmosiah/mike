/**
 * The product's name and the facts said alongside it, from
 * packages/brand/brand.json: the one file an install replaces to rebrand
 * (packages/brand/README.md). next.config.ts inlines it at build time.
 */
export interface Brand {
    name: string;
    title: string;
    description: string;
    website: string;
    sourceUrl: string;
}

export function parseBrand(json: string | undefined): Brand {
    if (!json) throw new Error("NEXT_PUBLIC_BRAND is not set; next.config.ts sets it from packages/brand/brand.json");
    return JSON.parse(json) as Brand;
}

export const brand: Brand = parseBrand(process.env.NEXT_PUBLIC_BRAND);
