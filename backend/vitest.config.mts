import { defineConfig } from "vitest/config";
import { DORMANT_SOURCES, DORMANT_TESTS, testGroup } from "./vitest.groups.mjs";

const group = testGroup();
const ALL_TESTS = ["src/**/*.test.ts", "src/**/*.test.mts", "scripts/replay/**/*.test.mts"];

export default defineConfig({
  test: {
    environment: "node",
    // scripts/replay is the thread replay simulator (a CLI, not part of the
    // server build); its pure parts are unit-tested with the server's suite.
    // Dormant features' tests run nightly, not in CI: vitest.groups.mts.
    include: group === "dormant" ? DORMANT_TESTS : ALL_TESTS,
    exclude: ["dist/**", "node_modules/**", ...(group === "core" ? DORMANT_TESTS : [])],
    // Generous timeouts so cold-start module transform/import latency
    // can't cause spurious timeout failures on a cold CI runner. Warm
    // tests finish in ~1s; this only guards the pathological cold case —
    // it does not mask hangs.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // The whole server, not just src/lib/** + src/modules/**. The
      // previous scope still left workers/, middleware/, jobs/ and
      // app.ts out of the report entirely, so the ratchet could not see
      // a regression there — and the headline percentage described a
      // part of the codebase rather than the codebase.
      include: ["src/**"],
      // Test files and their fixtures are the measuring instrument, not
      // the thing measured. (Spelled out rather than left to vitest's
      // defaults because setting `exclude` at all replaces them.)
      // Dormant features' sources leave with their tests (vitest.groups.mts).
      // Non-code files under src/ (the kernel's Markdown) only made the
      // report print parse errors beside the real output.
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.mts", "**/*.d.ts", "**/*.md", "**/*.py", ...DORMANT_SOURCES],
      // No-regression RATCHET floor, not a target. The measured scope
      // spans well-tested libs (access, storage keys/dispositions,
      // downloadTokens, api-key provider/env checks, chat doc
      // resolution, llm model resolution, chat citations, userLookup,
      // documentVersions, userDataCleanup, docxTrackedChanges,
      // documentTypes, chat prompts, workflow catalog ingestion), the
      // route/service layer the integration and service suites drive,
      // and the large still-untested feature libs (courtlistener, mcp,
      // chat tool dispatch, llm providers, spreadsheet handling) — so
      // the global number stays modest.
      //
      // Measured 2026-10-26 without the dormant features (vitest.groups.mts):
      // 74.79% statements, 66.01% branches, 76.99% functions, 77.5% lines.
      // The floors sit just under that, so CI fails on a real *drop* rather
      // than on measurement noise. They had sat 15 points low, where a large
      // regression passed. Floors only go up: when you add tests, raise
      // them in the same change. Backlog + per-area status:
      // docs/testing-coverage.md.
      thresholds: {
        statements: 74,
        branches: 65,
        functions: 76,
        lines: 77,
      },
    },
  },
});
