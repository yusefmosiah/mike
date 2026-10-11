import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND, BRAND_FILE, parseBrand } from "../brand";

describe("brand", () => {
    it("reads packages/brand/brand.json", () => {
        expect(BRAND).toEqual(JSON.parse(readFileSync(BRAND_FILE, "utf8")));
        expect(BRAND_FILE.endsWith("packages/brand/brand.json")).toBe(true);
    });

    it("trims fields and refuses a brand missing one", () => {
        const full = { name: " Acme ", title: "Acme", description: "d", website: "https://acme.test", sourceUrl: "https://src.test" };
        expect(parseBrand(JSON.stringify(full)).name).toBe("Acme");
        expect(() => parseBrand(JSON.stringify({ ...full, sourceUrl: " " }))).toThrow('"sourceUrl"');
        expect(() => parseBrand(JSON.stringify({ ...full, name: 1 }))).toThrow('"name"');
        expect(() => parseBrand("null")).toThrow("must be an object");
    });
});
