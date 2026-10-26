import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { DORMANT_SOURCES, DORMANT_TESTS, testGroup } from "./vitest.groups.mjs";

const group = testGroup();

// Unit tests only; Playwright e2e specs (*.spec.ts) stay out. Dormant
// features' tests run nightly, not in CI: vitest.groups.mts.
const testFiles =
    group === "dormant" ? DORMANT_TESTS : ["src/**/*.test.{ts,tsx}"];
const excludedTests = [
    "node_modules/**",
    "e2e/**",
    "**/*.spec.ts",
    ...(group === "core" ? DORMANT_TESTS : []),
];

// Files that cannot run in a VM context (see `projects` below). A new test
// failing with "Cannot redefine property: window" belongs here.
const VM_UNSAFE_TESTS = [
    "src/app/(pages)/published/page.test.tsx",
    "src/app/components/projects/ProjectDocumentTabs.colors.test.tsx",
    "src/app/components/shared/views/TextView.test.tsx",
    "src/app/hooks/useRemountPersistentState.test.tsx",
    "src/app/lib/authRedirects.test.ts",
    "src/app/lib/errorReporting.test.ts",
    "src/app/lib/theme.test.ts",
    "src/app/lib/voice/browserModels.load.test.ts",
    "src/app/lib/voice/browserSpeech.test.ts",
    "src/app/lib/voice/deviceSpeech.test.ts",
    "src/app/lib/voice/voiceEngine.test.ts",
    "src/app/lib/voice/web/capabilities.test.ts",
    "src/app/lib/voice/web/player.test.ts",
    "src/app/lib/voice/web/prime.test.ts",
    "src/app/lib/voice/web/webBackend.test.ts",
];

const resolvePath = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
    // The app builds with the React Compiler (next.config.ts), so tests do
    // too: code that reads mutable state during render passes uncompiled
    // tests and breaks in production (useModelVision did).
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    resolve: {
        // Mirror the `@/*` path alias from tsconfig.json so unit tests resolve
        // the same module specifiers the app uses.
        alias: [
            {
                find: /^@mike\/upload-session-client$/,
                replacement: resolvePath("./src/shared/api/uploadSessionClient.ts"),
            },
            {
                find: /^@\/(.*)$/,
                replacement: resolvePath("./src/$1"),
            },
            // The unit tests run in jsdom, i.e. as the browser. `@sentry/nextjs`'s
            // package entry is the Node/server build, which pulls in bundler
            // plugins that call fileURLToPath(import.meta.url) — and under the
            // jsdom transform import.meta.url is an http:// URL, so importing
            // it throws before any test runs. `@sentry/react` is the exact SDK
            // the Next package re-exports for the browser, so tests exercise
            // the same client API the app uses.
            {
                find: /^@sentry\/nextjs$/,
                replacement: "@sentry/react",
            },
        ],
    },
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: ["./vitest.setup.ts"],
        // What next.config.ts inlines for src/app/lib/brand.ts.
        env: {
            NEXT_PUBLIC_BRAND: readFileSync(
                resolvePath("../packages/brand/brand.json"),
                "utf8",
            ),
        },
        // jsdom 27's CSS-color parser (@asamuzakjp/css-color) is CJS but
        // require()s the ESM-only @csstools/css-calc. That require() happens
        // in the worker process while the jsdom environment boots — before
        // Vite's transform pipeline is involved — so deps.inline can't fix it.
        // Instead, let Node itself handle require(esm): default on >=22.12,
        // and enabled by this (there harmless) flag on 22.0–22.11.
        execArgv: ["--experimental-require-module"],
        // Generous timeouts to absorb cold-start jsdom + transform latency on CI.
        testTimeout: 20000,
        hookTimeout: 20000,
        // Two projects with one configuration. Most files run in "unit": each
        // in a fresh VM context inside a reused worker thread, instead of a
        // new process that builds jsdom from scratch, which was ~40% of the
        // suite's time (the whole suite: 387 s on two workers, 81 s this
        // way). The files in VM_UNSAFE_TESTS cannot run in a VM context (they
        // redefine `window`, `document` or `location` to imitate a server
        // render, or load native tooling), so they keep a process each.
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    pool: "vmThreads",
                    include: testFiles,
                    exclude: [...excludedTests, ...VM_UNSAFE_TESTS],
                },
            },
            ...(group === "dormant"
                ? []
                : [
                      {
                          extends: true,
                          test: {
                              name: "unit (own process)",
                              pool: "forks" as const,
                              include: VM_UNSAFE_TESTS,
                              exclude: excludedTests,
                          },
                      },
                  ]),
        ],
        // Undo every spy, stubbed global and stubbed env var after each test,
        // so no test depends on another one's leftovers.
        restoreMocks: true,
        unstubGlobals: true,
        unstubEnvs: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            // Ratchet the lib layer only, mirroring the backend's decision to
            // gate src/lib/**: components/hooks are exercised by their own
            // suites but not floor-gated (their coverage is UI-shaped and
            // noisy). src/app/lib/** is the client library: mikeApi (the
            // frontend half of the SSE contract), upload validation, model
            // availability, utils, and the cookie-session auth wrapper.
            include: ["src/app/lib/**"],
            // Dormant features' sources leave with their tests.
            exclude: ["src/app/lib/**/*.test.*", ...DORMANT_SOURCES],
            // No-regression RATCHET floor, not a target. The lib layer is
            // effectively fully tested: every mikeApi endpoint wrapper has a
            // route/method/body assertion, and the remaining gap is only the
            // dev-logging branch and a couple of `?? null` default arms.
            // Measured on this tree: 100% statements, 99.07% branches,
            // 100% functions, 100% lines. The floors are those measurements
            // rounded down to whole percentages, so a real drop fails CI.
            // Floors only go up: when you add tests, raise them in the same
            // PR. Backlog + per-area status: docs/frontend-testing.md.
            // NOTE: a 100% statements floor also fails when a REBASE brings
            // in upstream code whose fallback arms have no tests yet — the
            // fix is to cover the new arms in this file's suites, not to
            // lower the floor (that is how this tree got back to 100 twice).
            thresholds: {
                statements: 100,
                branches: 99,
                functions: 100,
                lines: 100,
            },
        },
    },
});
