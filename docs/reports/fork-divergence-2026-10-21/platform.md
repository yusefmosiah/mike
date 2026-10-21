# Area: platform, infrastructure and quality

## Summary

Our platform changes fall into three groups. First, a stack-level rework: the backend now talks to Postgres directly through its own `lib/db` client (replacing supabase-js and PostgREST) and to GoTrue through `@supabase/auth-js`. Compose lost PostgREST and the nginx gateway and now runs stock `postgres:17.6`. Auth middleware, CI, e2e and the stack tests were reworked around that. Second, personal-hosting infrastructure: NixOS config for "node-a" (staging at choir-ip.com, workstation microVMs, a secrets vault, a home-egress proxy, backups) and a GitHub Actions auto-deploy to it. Third, quality tooling: scripted-model e2e specs, Mac-app e2e, a thread-replay simulator, and Vitest/CI tightening. Several things that look like FIX candidates are already upstream: the migration ledger (`49efc046`), the access/confirmed-email hardening (`d146998d`), the password policy (`c94052d7`), and the lockfile security bumps. Our commits say these were ported from upstream (`docs/reports/upstream-picks-2026-10-10.md`), and upstream's lockfiles now carry equal or newer versions. Almost nothing in this area is a clean PR except the direct-Postgres client, and that is large.

Upstream's activity in these paths since the fork is heavy: `schema.sql` 47 commits, `migrations` 49, `modules/user` 38, `.github` 10, `e2e` 17, `docker-compose.yml` 14. Orgs/workspaces, playbooks and audit logs landed upstream. Our fork never took those, so they are the main merge hazard.

## Table

| Cluster | Bucket | Readiness | Maturity | Upstream conflict |
|---|---|---|---|---|
| 1. Direct-Postgres `Db` client (`lib/db`), PostgREST removed | MIXED | NEEDS-WORK (RFC; splittable) | shipped+tested | high |
| 2. GoTrue-only auth, Supabase packages and CLI dropped | MIXED | NEEDS-WORK (depends on 1) | shipped+tested | high |
| 3. Compose/CI/e2e rework onto Postgres+GoTrue; no model in Actions; scheduled runs dropped | MIXED / SUBTRACTIVE | FORK-ONLY (partly NEEDS-WORK) | shipped | high |
| 4. Auth and request-policy tweaks (rate limits removed, onboarding dropped, dev origins) | SUBTRACTIVE | FORK-ONLY | shipped | med |
| 5. Scripted-model e2e, branching/mobile/handoff specs, desktop e2e | ADDITIVE | NEEDS-WORK | shipped (some experimental) | med |
| 6. Test infrastructure (replay simulator, stack tests, conformance snapshot, Vitest React Compiler) | ADDITIVE | NEEDS-WORK | shipped / experimental | low-med |
| 7. Fork schema and migrations (20 migrations) | ADDITIVE (feature-owned) | FORK-ONLY until the owning feature is | shipped | high (numbering) |
| 8. Staging on node-a and the deploy workflow | ADDITIVE | FORK-ONLY | shipped | low |
| 9. Workstation VM host, vault, home egress, backup target (infra side) | ADDITIVE | FORK-ONLY (vault design maybe) | shipped / experimental | low |
| 10. Already-upstream ports and dependency fixes | FIX | Not a PR (upstream has them) | shipped | none |
| 11. Architecture-test tweak, docs, reports/roadmap | ADDITIVE | FORK-ONLY | shipped | low-med |

## Clusters

### 1. Direct-Postgres `Db` client
- **Bucket:** MIXED. **Readiness:** NEEDS-WORK. **Maturity:** shipped+tested.
- **What:** `backend/src/lib/db/client.ts` (about 650 lines) is a chainable builder that supports the slice of the supabase-js API the backend uses: select with aliases, counts, insert/upsert/update/delete, filters (`or`, `not`, JSON paths), order/range, single/maybeSingle, and `rpc` with PostgREST's overload choice. It runs over a `pg` Pool. Rows come back through `json_agg`, and writes go in through `json_populate_recordset`, so results match PostgREST's. Its stated reason is that call sites did not change, Pi Durable needs a direct `DATABASE_URL` anyway, and the gateway and PostgREST are two fewer services. Upstream still uses `lib/supabase.ts` (`createServerSupabase`, `SupabaseClient`) in about 164 files.
- **Key commits:** `c8d747ec` refactor(db): query Postgres directly instead of through PostgREST; `d99f2cc9` fix(db): filter on JSON paths the way PostgREST did; `37a95354` refactor: drop the remaining Supabase names (deletes `lib/supabase.ts`, renames the test helper `supabaseMock` to `dbMock`).
- **Paths:** `backend/src/lib/db/`, `backend/src/__tests__/integration/dbClient.conformance.stack.test.ts` and its `.snap` (recorded from PostgREST v14.12), `stackDb.ts`.
- **Dependencies:** cluster 2 (auth calls were moved off `Db`), cluster 3 (stack tests and compose).
- **Conflict:** high. The mechanical rename touched 540 backend files across the three commits. Upstream's 38 `modules/user` commits and orgs work use `createServerSupabase` and `SupabaseClient` everywhere. Upstream has no `lib/db`, so there is no duplicate work.
- **To contribute:** the client is the only part that stands on its own. A PR could add `lib/db` plus the conformance suite as an opt-in backend (`DATABASE_URL` set means use it). Upstream's `Db` is `SupabaseClient`, and ours is `DbClient`, so a type seam would be needed first.

### 2. GoTrue-only auth
- **Bucket:** MIXED. **Readiness:** NEEDS-WORK. **Maturity:** shipped+tested.
- **What:** `lib/gotrue.ts` and `lib/authSession.ts` replace supabase-js and `@supabase/ssr` with `@supabase/auth-js`. The backend writes the session cookies itself, in the same format `@supabase/ssr` used (verified in both directions, per the commit). Config is `AUTH_URL`, `AUTH_PUBLIC_URL`, `AUTH_SERVICE_KEY`. The Google authorize URL now uses `AUTH_PUBLIC_URL`; Compose used to hand browsers the internal gateway address, which is a standalone bug fix. `middleware/auth.ts` now uses `authAdmin()` for token, MFA and user lookup.
- **Key commits:** `7e1b073c` refactor(auth): keep GoTrue, drop the rest of Supabase; `37a95354`.
- **Paths:** `backend/src/lib/gotrue.ts`, `lib/authSession.ts`, `middleware/auth.ts`, `modules/auth/`, `.env.example`.
- **Dependencies:** cluster 1 and Compose changes in cluster 3.
- **Conflict:** high. Upstream still depends on `@supabase/ssr` and `supabase-js`. Upstream's single auth change, `c94052d7` (policy and sign-in recovery), overlaps `auth.service/routes`.
- **Note:** `auth.service.ts` also has the password policy (cluster 10).

### 3. Compose, CI and e2e rework
- **Bucket:** MIXED (infra) / SUBTRACTIVE (CI scope). **Readiness:** FORK-ONLY. **Maturity:** shipped.
- **What:**
  - `docker-compose.yml` runs stock Postgres plus GoTrue. `docker/db-init/roles.sql` creates the inert `anon/authenticated/service_role` roles. `e2e.yml`, `stack-tests.yml` and `schema-drift.yml` boot Postgres and GoTrue from compose instead of the Supabase CLI, which also removes the pinned CLI and the port-collision workaround.
  - `8b45cdcd`: e2e never receives a model key, so the four live-LLM specs skip in Actions and run locally with `npm run test:e2e:local`.
  - `ee4298e5`: all scheduled runs dropped (nightly e2e, weekly CodeQL and Scorecard, monthly mutation).
  - `97f6de08` and `e223e7c1`: allowlist the fake credentials in gitleaks.
- **Key commits:** `7e1b073c`, `8b45cdcd`, `ee4298e5`, `3a007fa9`.
- **Paths:** `.github/workflows/{e2e,stack-tests,schema-drift,codeql,mutation,scorecard,word-addin}.yml`, `docker-compose.yml`, `docker/db-init/`, `backend/scripts/test-stack.sh`, `scripts/e2e-local-stack.sh`, `docs/e2e-ci.md`.
- **Dependencies:** clusters 1 and 2.
- **Conflict:** high. Upstream changed `.github` 10 times, `docker-compose.yml` 14 times, `e2e/llm.ts` and `anthropic-stub.mjs` (`e436b039`, which runs the LLM specs in CI against an Anthropic fixture). We took the opposite direction: no model in CI, and upstream's stub built on the AI SDK would not match our Pi runtime.
- **Not for upstream:** dropping schedules and the model-in-CI stance is a project choice.

### 4. Auth and request policy
- **Bucket:** SUBTRACTIVE. **Readiness:** FORK-ONLY. **Maturity:** shipped.
- **What:**
  - `ce2773e2` removes every per-IP limiter except the auth and per-user upload-session ones: chat, export, import, delete, general and Word tool-result limits all go. The reason was that scripted replays and heavy sessions from one office IP hit 429s. That weakens upstream's abuse protection.
  - `77698fce` removes the onboarding pages, so new accounts land on `/assistant`.
  - `8e672969` trusts Tailscale, private-network and `.local` origins when `NODE_ENV` is not production (a dev-only CORS widening).
  - `app.ts` mounts the vault, audio and citations routers, and fails closed with `assertPrivateModeBoot()`.
- **Dependencies:** privacy and strict-mode features (covered by another area).
- **Conflict:** med. `app.ts` was touched 6 times upstream, and upstream has rate-limit lanes we deleted.
- **Possible contribution:** only `8e672969` as an opt-in dev convenience, and it is small.

### 5. e2e specs
- **Bucket:** ADDITIVE. **Readiness:** NEEDS-WORK. **Maturity:** shipped, some experimental.
- **What:** `e2e/stubModel.mjs` is a scripted OpenAI-compatible endpoint (numbered answers, streaming, and a "(slow)" mode that holds the stream open). It lets Playwright send real chat turns through the backend, database and Pi runtime with no key or spend. New specs: `branching`, `chat-scroll`, `firm-handoff`, `mobile-layout` and `web-citation-reader`. `desktop/e2e/*.e2e.mjs` drives the Mac app and its menu from the main process. Existing specs and `onboarding.ts` adjusted for the removed onboarding.
- **Key commits:** `7aceab67` branching flows against a scripted model; `d0d40220` and `31987673` local e2e config; `c273ad67` and `9d464130` desktop e2e.
- **Dependencies:** Pi runtime, branching, handoff and mobile features; the Mac app (desktop).
- **Conflict:** med. Upstream touched 13 e2e files. `llm.ts`, `onboarding.ts`, `auth-flows` and `assistant-streaming` overlap with ours.
- **Readiness note:** `stubModel.mjs` plus the compose-based boot could be offered to upstream as a keyless CI path, but it assumes Pi.

### 6. Test infrastructure
- **Bucket:** ADDITIVE. **Readiness:** NEEDS-WORK. **Maturity:** shipped (replay: experimental).
- **What:**
  - `backend/scripts/replay/` (thread replay simulator, about 4,000 lines) re-runs one chat's prompts against a deployment and reports time, tokens, language switches and file-tree diff.
  - Stack tests moved from `*.supabase.test.ts` to `*.stack.test.ts`.
  - Frontend Vitest runs under the React Compiler (`a79068c5`).
  - Coverage-floor fixes.
  - An architecture-test exemption for routeless modules (`retrieval`, `workspace`), a `.js` specifier fix, and `fix(tests)` typecheck repairs.
- **Key commits:** `9c944ad0` replay simulator; `a79068c5`; `856d89ae`; `3450851d`; `2676ee07`.
- **Dependencies:** replay needs node-a workstation pool and our chat/SSE; other items are small.
- **Conflict:** low-med. The architecture-test change is small and rebasable.
- **Useful for upstream:** the Vitest React Compiler setting, if upstream enables the compiler.

### 7. Fork schema and migrations
- **Bucket:** ADDITIVE, owned by features (branching, chunks, firm handoff and turn claims, citation checks, workstations, code approvals, image/text upload types, skill versions, web reader, autocompact, dictation vocabulary, spoken answers). **Readiness:** FORK-ONLY until each feature is contributed. **Maturity:** shipped.
- **What:** 21 migrations dated 20261007 to 20261020. `schema.sql` grew by about 800 lines and now lists them in `schema_migrations`. `migrationLedger.test.ts` enforces this. Two are ports of upstream's: `20261010_04_email_change_moves_grants` (upstream `20261008_01`) and `20261010_06_schema_migrations` (upstream `20261009_03`).
- **Conflict:** high. Upstream added 57 migrations in the same window, and its filenames overlap ours (`20261007_01`, `20261009_01`, `20261020_01`, and so on). The ledger records filenames, so a shared database could apply the same change twice under two names. Any feature PR must renumber its migration after upstream's latest and add the name to `schema.sql`.

### 8. Staging on node-a
- **Bucket:** ADDITIVE. **Readiness:** FORK-ONLY (personal hosting). **Maturity:** shipped.
- **What:** `infra/node-a/staging.nix` runs the repo's compose stack under rootful Podman with Caddy TLS for choir-ip.com, with daily restore-checked backups, health checks and `mike-staging deploy-sha`. `gate.nix` and `gate/gate.py` put a shared password and fail2ban in front of the site. `.github/workflows/deploy-staging.yml` has CI ask node-a over a restricted ssh key to build a commit of main; node-a verifies it is on main and rolls back if health checks fail.
- **Key commits:** `81928b6d`, `7cf93e6d`, `b309cd38`, `be939ad3`, `6cb3ff7a`, `ba801d7b` (`mike-staging api`).
- **Paths:** `infra/node-a/`, `infra/flake.nix`, `.github/workflows/deploy-staging.yml`, `docs/deployment.md`, `docs/recovery-drill.md`.
- **Conflict:** low (new files). `docs/deployment.md` changed by 254 lines and upstream edited it too.
- **Fork-only reason:** hardcoded domain, host IP and key, and the owner's repo URL. Only the deploy-by-sha-with-rollback pattern would be worth describing.

### 9. Workstation hosts, vault, home egress, backups (infra side)
- **Bucket:** ADDITIVE. **Readiness:** FORK-ONLY (the vault design may be shareable once documented). **Maturity:** shipped, with experimental parts.
- **What:**
  - `infra/node-a/workstations.nix` and `infra/workstation/`: Cloud Hypervisor microVMs, one per account from a pool (or temporary, wiped), btrfs snapshots per turn, and a logging egress proxy as the only route out.
  - `infra/vault/`: a dependency-free Node service that stores credentials with envelope encryption and attaches them to VM requests via short-lived leases, so no VM or model sees a value. It has a 918-line test suite and the design doc `docs/vault.md`.
  - `infra/home-egress/`: a reverse-tunnelled proxy sending only YouTube hosts through the owner's Mac.
  - `choir-backup-target.nix`: a stopgap off-host restic target for a different project.
- **Key commits:** `6b433f81`, `8fa8fe91`, `aa7898fb`, `6ddfbd17`, `07df0783` (multi-model security review hardening), `f410af72`, `df9f05cc`.
- **Dependencies:** `backend/src/lib/workstation`, `modules/vault`, `modules/workspace`, and chat code-mode (other areas).
- **Conflict:** low. All new paths.
- **Note:** the backup target is another project's module and should not appear in any PR.

### 10. Already-upstream ports and dependency bumps
- **Bucket:** FIX. **Readiness:** not PRs, because upstream has the equivalent.
- **What:**
  - Ledger `3a007fa9` ports `49efc046` and `a178e85a`.
  - Access hardening: `req.locals.userEmail` is empty unless `email_confirmed_at` is set, so unconfirmed sign-ups cannot inherit email-keyed shares (`37c2b953`, from `d146998d`).
  - Password policy of 10 characters and 72 bytes (`0cfeeacb`, from `c94052d7`).
  - MCP SSRF hostname canonicalisation (`a35a1c5b`, from `1da19c20`).
  - Lockfile-only audit fixes (`ea761b12`, `0bc01f46`, `46867129`, `1837f060`, `97f6de08`). Upstream's lockfiles already carry equal or newer versions of vite, markdown-it, follow-redirects, launch-editor and handlebars.
- **Possibly ours only:** `505b42f5` fix(security): require a pinned measurement on attested lanes (`lib/llm/registry.ts`). It depends on the attested-lane work, so it belongs to the LLM area.

### 11. Docs, reports, architecture rules
- **Bucket:** ADDITIVE. **Readiness:** FORK-ONLY. **Maturity:** shipped.
- **What:**
  - `goals/` holds about 35 mission and station files and `STATUS.md`.
  - `docs/reports/` has dated reports; `docs/test-evidence/` has gzipped Auto Mode gate runs.
  - New docs include `vault.md`, `recovery-drill.md`, `mac-app.md` and `model-costs.md`.
  - Existing docs were edited: `deployment.md`, `e2e-ci.md`, `backend-architecture.md` and others describe Postgres plus GoTrue.
  - AGENTS.md was rewritten for the new structure.
  - `docs/superpowers/specs/2026-06-29-legal-workflows-design.md` was deleted. `composeMigrations.test.ts` was deleted too, replaced by the ledger test.
- **Conflict:** low-med for the doc edits.

## PR candidates

1. **"Add an opt-in direct-Postgres database client with a PostgREST conformance suite"**
   - Scope: `lib/db` (client, pool, tests) plus the conformance test and snapshot. It is gated on `DATABASE_URL` and keeps `SupabaseClient` as the default. It needs a shared `Db` type seam first, and a runtime check that PostgREST and the client agree.
   - Risk: a large API surface, and a maintainer decision about dropping PostgREST.
   - Best treated as an RFC first.
2. **"Fix the Google OAuth authorize URL to use the public auth address"**
   - Scope: `browserAuthUrl` / `AUTH_PUBLIC_URL`. Small, standalone, tested, but only matters if upstream's Compose also hands out the internal gateway URL. Verify first.
3. **"Add a scripted OpenAI-compatible model server for keyless e2e chat specs"**
   - Scope: `e2e/stubModel.mjs`, the local stack script, and one or two specs (branching or streaming). It overlaps upstream's `anthropic-stub.mjs` (`e436b039`), so propose it as a protocol-agnostic alternative.
4. **"Run Vitest under the React Compiler"**
   - Scope: `frontend/vitest.config.mts` and the dependency (3 lines plus a lockfile). Only if upstream builds with the compiler. A test-only change with low risk.
5. **"Add a dev-only trust rule for private-network origins"** (`8e672969`)
   - Scope: `lib/origins.ts` plus tests. It is gated on `NODE_ENV !== production` and small. The security reviewer will want a careful look at `.local` and `.ts.net`.

Nothing else in this area is suitable. The access, password, ledger and SSRF fixes are upstream's own.

## README digest

- The app runs on Postgres and GoTrue only. The backend queries Postgres directly through its own `lib/db` client (no PostgREST, no gateway, no Supabase packages), and signs in through GoTrue with `AUTH_URL`, `AUTH_PUBLIC_URL` and `AUTH_SERVICE_KEY`.
- `docker compose up` starts stock Postgres 17, GoTrue, object storage, Redis and Mailpit. `backend/scripts/migrate.sh` applies new migrations once each and records them in `schema_migrations`.
- Per-IP rate limits apply only to authentication endpoints and per-user upload sessions. Chat, export, import and delete requests are not limited.
- New accounts go straight to the assistant (no onboarding steps). Passwords must be at least 10 characters and at most 72 bytes.
- CI never calls a model. Playwright runs against a scripted local model server, and live-model specs run only on a developer machine with a key. There are no scheduled workflow runs.
- Pushes to main deploy to a staging server (a NixOS box running the compose stack behind a shared password) after CI passes, with automatic rollback on failed health checks. That server also hosts per-account workstation VMs and a secrets vault. This is the owner's own infrastructure and is not needed for a normal install.
- Tests include a conformance suite for the database client, stack tests against real Postgres and GoTrue, Mac-app end-to-end tests, and a replay tool that re-runs a stored chat against a deployment.
