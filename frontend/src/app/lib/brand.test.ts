import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { brand, parseBrand } from "./brand";

describe("brand", () => {
    it("is packages/brand/brand.json", () => {
        const file = resolve(__dirname, "../../../../packages/brand/brand.json");
        expect(brand).toEqual(JSON.parse(readFileSync(file, "utf8")));
    });

    it("says where the brand comes from when the build did not inline it", () => {
        expect(() => parseBrand(undefined)).toThrow("packages/brand/brand.json");
    });
});
