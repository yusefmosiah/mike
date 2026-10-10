import { defineConfig, devices } from "@playwright/test";

/**
 * Run `npx playwright install` to download the browsers.
 * See https://playwright.dev/docs/test-configuration.
 */
/** Specs that mock the API in the browser; see the "synthetic" project. */
const SYNTHETIC_SPECS = [
    /assistant-streaming\.spec\.ts/,
    /tabular-chat-lifecycle\.spec\.ts/,
];

/* Locally, the backend Playwright starts runs against the mike-e2e stack
   (scripts/e2e-local-stack.sh); test users must be created in that stack's
   GoTrue too (e2e/users.ts). CI sets these itself. */
/* E2E_API_PORT and E2E_WEB_PORT move the servers Playwright starts locally,
   for a machine whose development stack already holds 3000 and 3001. Uploads
   need the web app on 3000 or 3100, the origins local storage's CORS allows
   (docker/storage-cors.json). */
const API_PORT = process.env.E2E_API_PORT ?? "3001";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "3000";
const STUB_MODEL_PORT = process.env.E2E_STUB_MODEL_PORT ?? "21434";

if (!process.env.CI) {
    process.env.AUTH_URL ??= `http://localhost:${process.env.E2E_AUTH_PORT ?? "21421"}`;
    process.env.AUTH_SERVICE_KEY ??=
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJtaWtlLWxvY2FsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.uD8koYAMq_1hAlVmm1t5PYasyb98YME7G_UYVa5ME1Y";
}

export default defineConfig({
    testDir: "./e2e",
    /* Every parallel worker signs in as its OWN user (worker 0 is the
       historical e2e@mike.local; see workerAccount() in e2e/users.ts and the
       worker fixture in e2e/fixtures.ts), so workers never share project,
       chat or workflow lists or a session. Files still run one test at a time
       within a worker: several specs build on state created earlier in the
       same file. Locally the default stays at one worker because `next dev`
       compiles routes on demand; CI passes --workers against a production
       build (.github/workflows/e2e.yml). E2E_WORKERS overrides both. */
    fullyParallel: false,
    workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,
    timeout: process.env.REACT_STRESS === "1" ? 90_000 : 30_000,
    /* Fail the build on CI if you accidentally left test.only in the source */
    forbidOnly: !!process.env.CI,
    /* Playwright's assertion default is 5s, which is tight for this app's first
       paint after a cold Next.js dev compile — so nearly every expect() in the
       suite hand-rolled its own `{ timeout: 10_000 }`. Make that the project
       default: new assertions inherit it, and only genuinely slower waits need
       to spell out an override. */
    expect: { timeout: 10_000 },
    /* Stress failures must remain failures even if their timing is intermittent. */
    retries: process.env.REACT_STRESS === "1" ? 0 : process.env.CI ? 2 : 0,
    /* Reporter. On CI, "github" alone would REPLACE Playwright's default html
       reporter, so playwright-report/ would never be written and the workflow's
       artifact upload (docs/e2e-ci.md, "Failure artifacts") would have nothing
       to ship. Include annotations, per-test progress and the HTML report;
       `open: "never"` stops the reporter from trying to launch a
       browser on the CI box after the run. */
    reporter: process.env.CI
        ? [["github"], ["list"], ["html", { open: "never" }]]
        : "list",
    /* Shared settings for all the projects below */
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${WEB_PORT}`,
        video: process.env.PW_VIDEO === "1"
            ? { mode: "on", size: { width: 1280, height: 720 } }
            : "off",
        trace: process.env.REACT_STRESS === "1" ? "retain-on-failure" : "on-first-retry",
        screenshot: "only-on-failure",
    },

    projects: [
        /* Run the auth setup before all other tests */
        {
            name: "setup",
            testMatch: /auth\.setup\.ts/,
        },

        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
            testIgnore: SYNTHETIC_SPECS,
            dependencies: ["setup"],
        },

        /* Specs that mock every /api call inside the browser and need no
           backend, database or account. Kept in their own project so CI can
           run them on runners that skip the database/API stack, and fully
           parallel because nothing is shared between their tests. */
        {
            name: "synthetic",
            use: { ...devices["Desktop Chrome"] },
            testMatch: SYNTHETIC_SPECS,
            fullyParallel: true,
        },
    ],

    /* Start the backend and the Next.js dev server when running locally.
       The backend command first runs the local-stack setup (Docker check,
       Postgres + GoTrue, schema + migrations, env wiring) so a plain
       `npm run test:e2e` works against a ready local stack — see
       scripts/e2e-local-stack.sh. Idempotent: a few seconds when already up. */
    webServer: process.env.CI
        ? undefined
        : [
              {
                  command:
                      "bash ../scripts/e2e-local-stack.sh --serve-backend",
                  cwd: "backend",
                  env: {
                      PORT: API_PORT,
                      FRONTEND_URL: `http://localhost:${WEB_PORT}`,
                      E2E_STUB_MODEL_PORT: STUB_MODEL_PORT,
                  },
                  url: `http://localhost:${API_PORT}/health`,
                  reuseExistingServer: true,
                  timeout: 120_000,
              },
              {
                  command: `npm run dev -- -p ${WEB_PORT}`,
                  cwd: "frontend",
                  env: { API_BASE_URL: `http://localhost:${API_PORT}` },
                  url: `http://localhost:${WEB_PORT}`,
                  reuseExistingServer: true,
                  timeout: 120_000,
              },
              /* The "E2E placeholder" model's endpoint (e2e/stubModel.mjs). */
              {
                  command: `node e2e/stubModel.mjs ${STUB_MODEL_PORT}`,
                  url: `http://127.0.0.1:${STUB_MODEL_PORT}/health`,
                  reuseExistingServer: true,
                  timeout: 10_000,
              },
          ],
});
