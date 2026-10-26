/**
 * Which tests gate the staging deploy.
 *
 * The inherited features nobody is using yet (tabular reviews, the Word
 * add-in) are "dormant": their tests run nightly (`npm run test:dormant`,
 * .github/workflows/nightly.yml) instead of in CI, so they cannot block a
 * deploy of the features in use, and their sources leave the gated coverage
 * measurement with them. When work on one of them resumes, delete its entries
 * here and it gates again. See docs/ci.md. The backend keeps the same list in
 * backend/vitest.groups.mts.
 *
 * MIKE_TEST_GROUP selects: unset or "core" (the default, what CI runs),
 * "dormant", or "all".
 */
export const DORMANT_TESTS = [
    "src/app/components/tabular/**/*.test.{ts,tsx}",
    "src/app/(pages)/tabular-reviews/**/*.test.{ts,tsx}",
    "src/app/hooks/usePaginatedTabularReviews.test.ts",
    "src/app/lib/deleteTabularReviewsWithConcurrency.test.ts",
    "src/app/lib/tabularChatHistory.test.ts",
    "src/app/lib/tabularChatSettingsEvents.test.ts",
    "src/wordAddin/**/*.test.{ts,tsx}",
];

export const DORMANT_SOURCES = [
    "src/app/lib/deleteTabularReviewsWithConcurrency.ts",
    "src/app/lib/tabularChatHistory.ts",
    "src/app/lib/tabularChatSettingsEvents.ts",
];

export type TestGroup = "core" | "dormant" | "all";

export function testGroup(value = process.env.MIKE_TEST_GROUP): TestGroup {
    if (value === undefined || value === "" || value === "core") return "core";
    if (value === "dormant" || value === "all") return value;
    throw new Error(
        `MIKE_TEST_GROUP must be core, dormant or all, not ${value}`,
    );
}
