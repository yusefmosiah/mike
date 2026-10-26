/**
 * Which tests gate the staging deploy.
 *
 * The inherited features nobody is using yet (tabular reviews, Google
 * Workspace, the Word add-in's chat) are "dormant": their tests run nightly
 * (`npm run test:dormant`, .github/workflows/nightly.yml) instead of in CI,
 * so they cannot block a deploy of the features in use, and their sources
 * leave the gated coverage measurement with them. When work on one of them
 * resumes, delete its entries here and it gates again. See docs/ci.md.
 *
 * MIKE_TEST_GROUP selects: unset or "core" (the default, what CI runs),
 * "dormant", or "all".
 */
export const DORMANT_TESTS = [
  "src/modules/tabular/**/*.test.ts",
  "src/modules/word-chat/**/*.test.ts",
  "src/__tests__/integration/tabular*.test.ts",
  "src/__tests__/integration/wordChat.routes.test.ts",
  "src/__tests__/integration/google*.test.ts",
  "src/lib/integrations/__tests__/google*.test.ts",
  "src/modules/chat/engine/__tests__/googleWorkspaceDispatch.test.ts",
  "src/modules/chat/engine/__tests__/wordDocumentEdits.test.ts",
  "src/modules/chat/engine/tools/wordClientTools.test.ts",
];

export const DORMANT_SOURCES = [
  "src/modules/tabular/**",
  "src/modules/word-chat/**",
  "src/lib/integrations/google*",
  "src/modules/chat/engine/wordDocumentEdits.ts",
  "src/modules/chat/engine/wordPrompt.ts",
  "src/modules/chat/engine/tools/wordClientTools.ts",
];

export type TestGroup = "core" | "dormant" | "all";

export function testGroup(value = process.env.MIKE_TEST_GROUP): TestGroup {
  if (value === undefined || value === "" || value === "core") return "core";
  if (value === "dormant" || value === "all") return value;
  throw new Error(`MIKE_TEST_GROUP must be core, dormant or all, not ${value}`);
}
