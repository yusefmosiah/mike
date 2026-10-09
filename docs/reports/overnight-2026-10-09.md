# Overnight report, 2026-10-09

Written by the agent for the owner. Nothing here is accepted; every item
below is "built and exercised", with the receipt that shows how far. The
owner's instruction for the night: "Get Mike deployed, make code mode work
with sandboxing, complete all the missions you can, and get creative with
addressing nonfunctional requirements."

## First thing to do in the morning

Mike is running at **https://choir-ip.com**, the staging copy on node-a.
Sign-up is closed. To sign in, run on your machine:

```
ssh root@51.81.93.94 mike-staging owner-link <your email>
```

It creates your account if needed, gives that account the workstation VM
(`ws-owner`), restarts the backend so it sees that, and prints a one-time
sign-in link. Nothing is emailed. No account exists on staging yet: the
agent did not create one there, so the first chat turn on staging is
yours.

## What landed on `main`

| Commit | What |
|---|---|
| `6b433f81` | Workstation guest image and the `run_command` tool (Mission 13, phases 1–2) |
| `50e182d8`, `8fa8fe91` | node-a managed from `infra/`; workstation host on Cloud Hypervisor (phase 3) |
| `81928b6d` | Staging on node-a at choir-ip.com |
| `a63d0a32` | Code mode: `run_script` in a QuickJS sandbox (Mission 11, first slice) |
| `d0334c2e` | Staging backend reaches its VM; a snapshot before each turn's first command |
| `b309cd38` | Daily restore-checked backups and five-minute health checks for staging |
| `b337ea44` | Code-mode live receipt |
| `ebe0be74` | Plain timeline labels for scripts, workstation commands and web tools |
| `f0b26692` | Mission 13 phase 2 acceptance receipt |
| `5fcf365f` | Logging egress proxy as the VMs' only way out (phase 4) |
| `6cb3ff7a` | Staging kept out of search engines |
| `36604642`, `bd13d0c1` | Prompt-injection flags on tool results, with a live receipt |
| `db680985`, `908b92fe` | Voice: OpenRouter lane, Settings → Voice, browser engines, test bench (Mission 10, first slice) |
| `ed58ee82` | Fix for a CORS test that `db680985` broke (see Verification) |
| `7aceab67` | Branching flows end to end in Playwright against a scripted model (Mission 3) |

## Staging (node-a)

- **What runs.** The repository's `docker-compose.yml` under rootful Podman.
  Docker would set the kernel's FORWARD policy to DROP and cut off the VMs.
  Overrides are in `infra/node-a/staging/compose.override.yml`. Caddy
  handles TLS for choir-ip.com, routing `/gotrue/*` to GoTrue, presigned
  `/mike/*` requests to RustFS, and everything else to the frontend.
  Every published container port binds loopback. From the Mac, the public
  IP refused 3000, 3001, 5432, 6379, 8025, 1025, 9000, 9001, 54321 and
  3128.
- **Secrets.** Generated on the host once (`/var/lib/mike-staging/*.env`,
  mode 0600). Model and search keys were copied by name from
  `backend/.env`; their values were never printed. Sentry is off: the
  first deploy logged `[sentry] enabled for worker-thread`, the fix is in
  `81928b6d`, and now the backend logs `disabled for api` and
  `disabled for worker-thread`. Code mode is on.
- **Found on the way.** GoTrue could not resolve `db`. The NixOS Podman
  module opens DNS only on `podman0`, while compose networks get
  `podman1`, `podman2` and so on. DNS is now open on every Podman bridge.
- **Checks.** After the last deploy (`908b92fe`): `mike-staging deploy`
  exit 0, `mike-staging health` printed `healthy`, and from the Mac
  `https://choir-ip.com/`, `/login`, `/gotrue/health`, `/api/health`,
  `/robots.txt` and `/settings/voice` all returned 200. The backend logged
  `[sentry] disabled for api` and `disabled for worker-thread`. That deploy
  also built both Docker images from the repository root with the new
  frontend dependencies and the backend's `openssh-client`.
- **Backups.** `mike-staging backup` runs daily at 03:30 UTC. It dumps
  Postgres, restores the dump into a scratch database and compares
  public-table counts, then archives object storage. Backups are kept 14
  days. First run: `backup .../20261009T175412Z: 940K, public tables: live
  63, restored 63`. They live on the same RAID1 disks, so they cover
  mistakes, not loss of the machine.
- **Health.** `mike-staging health` runs every five minutes. It fetches the
  three public URLs through TLS and checks disk use; on failure it logs,
  starts whatever stopped, and fails the unit. Nothing pages anyone yet;
  `systemctl --failed` and `journalctl -u mike-staging-health` show it.
- **Host changes.** Every change went `nixos-rebuild test` under a 10-minute
  rollback timer, then a fresh ssh login, then `switch`. The current
  generation is 49 or later. Choir's builder module and owner key are
  unchanged.
- **Deploying again.** rsync the working tree to
  `/var/lib/mike-staging/src`, write the commit to `.git-sha`, then run
  `mike-staging deploy`. A deploy that pulls a commit from GitHub would
  be better (see below).

## Workstation VMs (Mission 13)

Receipts are in `goals/mission-13-workstation-vms.md`.

- **Phase 2 acceptance (dev VM, local stack).**
  - A chat turn ran pandas in the VM through four `run_command` calls.
  - It answered "North, at $29,530.68" and "Gizmo, at $28,048.73",
    matching to the cent a direct run in the VM.
- **Phase 3 (node-a).**
  - `ws-owner` runs under Cloud Hypervisor, reached by ssh over vsock.
  - The agent ran `rm -rf ~/*`; `ws restore` brought the files back in
    17.6 s with identical SHA-256 hashes.
  - The harness now asks the host for a snapshot before each turn's first
    `run_command`. The host reuses one under two minutes old, keeps 48 turn
    snapshots and 14 daily ones, and never prunes manual ones. From inside
    the staging backend container:
    `snapshot: {"ok":true,...}`, then
    `"stdout":"ws-owner\nagent\n3.1.5\n200\nhost-blocked\n"`.
- **Phase 4 (node-a).**
  - The VM's only way out is a logging proxy (tinyproxy) on the host.
  - The proxy cannot open connections to loopback, private, link-local or
    CGNAT addresses (an nftables rule on its uid), so a name that resolves
    inward gets nowhere.
  - Probes from the guest:
    - https, git, pip, Node `fetch` and git-over-ssh work through the
      proxy;
    - direct egress and the host's ssh are blocked;
    - `127.0.0.1:3001`, `10.89.0.1:3001`, `169.254.169.254` and
      `192.168.1.1` fail through the proxy;
    - port 25 is refused.
  - The proxy log shows each request with the VM's address.
- **Phase 6, first part.**
  - Prompt-injection flags: a deterministic detector scans results from
    tools that carry outside text. A flagged result gets a notice the model
    reads; nothing is blocked.
  - Fetched web pages and command output are now nonce-fenced like
    documents.
  - Zero false flags on 2,042 paragraphs of this repository's docs.
  - Live: a planted "rm -rf ~/data ... do not tell the user" in a VM file
    was flagged. The model summarised the real notes and told the user
    about the planted text, and the files were intact. That is one model
    and one run.
- **Not done.**
  - Phase 5 (dogfooding) is yours.
  - Outbound PII checks on HTTPS need the proxy to terminate TLS with a CA
    in the guest. That is your decision; see the open questions in the
    mission file.
  - Snapshots are not replicated off the machine.

## Code mode (Mission 11, first slice)

- **What it is.** `run_script` runs model-written JavaScript in QuickJS
  (WebAssembly) inside the backend.
  - There is no `process`, `require`, `fetch` or timers.
  - `tools.<name>(args)` goes through the turn's ordinary tool path: Auto
    Mode gate, mutation gate, events, write queue.
  - Calls return promises, so `Promise.all` fans out.
- **Limits.** 64 MiB heap, an interpreter-enforced deadline (120 s by
  default), 100 tool calls and 20,000 output characters. The turn's abort
  signal cancels the script. It is offered only with `CODE_MODE_ENABLED`,
  which is on in staging.
- **Tests.** 13 sandbox tests, including:
  - `while (true) {}` stops at the deadline;
  - a 32 MiB allocation fails against a 16 MiB cap;
  - a host-escape attempt sees `undefined`.

  Plus 5 streaming tests, including that a conversation that cannot write
  gives its scripts no write tools.
- **In the production image on staging.** A script ran
  `Promise.all` over two tool calls and saw `typeof process` and
  `typeof fetch` as `undefined`.
- **Live with a real model (local stack, deepseek-v4.1-flash).** Asked to
  rank ten cities by population with separate searches, the model chose
  `run_script` on its own and ran 10 searches in one 585 ms script. With
  only four workflows to read, it called the tools directly.
- **Not done.**
  - `agents.delegate()`: delegation lives in the Pi runtime, not the tool
    list.
  - Tool discovery and exposure modes.
  - `store`/`load`.
  - A timeline view of a script's inner calls.

## Voice (Mission 10, first slice)

- **What it is.**
  - Settings → Voice offers four engines for dictation and read-aloud:
    this server, OpenRouter (never in strict private mode), this browser
    (on-device recognition only, plus the OS voices), and an open model in
    the browser (Whisper Base, Kokoro 82M).
  - Prices are shown in each model's own billing unit.
  - The browser model asks first with "about N minutes", measured, never a
    size.
  - A test bench compares engines side by side.
  - Preferences are kept per device.
- **Live, backend.** Kokoro spoke a sentence for $0.000045. Qwen3 ASR
  transcribed it word for word for $0.000015; Voxtral Mini wrote "10%"
  for "ten percent".
- **Live, in Chrome on the local stack.**

  | Engine | Latency | Cost |
  |---|---|---|
  | Browser voices (muted) | 9.0 s | on device |
  | Kokoro 82M | 1.2 s | $0.000045 |
  | Voxtral Mini TTS | 2.6 s | $0.0012 |
  | Sesame CSM 1B | 4.7 s | $0.00051 |

  The run found two defects, both fixed: price precision, and a silent "no
  engine selected" state.
- **Not done, deliberately.**
  - Downloading a browser model live: a few hundred megabytes into your
    browser is your call.
  - Recording the microphone unattended.
- **Image cost.** The frontend image grew from 2.75 GB to 3.69 GB with
  this change (`podman images` on node-a, before and after). Most of that is
  `onnxruntime-node`, 536 MB on disk, which transformers.js pulls in although
  the app only runs it in the browser; `onnxruntime-web` adds 92 MB. The
  same dependency brings a moderate `sprintf-js` advisory on a path the app
  never runs.

## Branching (Mission 3)

- **What changed.** Mission 3's acceptance is Playwright runs of each flow
  in the real app. `e2e/branching.spec.ts` now runs those flows: regenerate,
  prompt edit, stepping between siblings with a reload, branch into a new
  thread, project chat, and a phone viewport. They go through the real web
  app, backend, Postgres and Pi runtime.
- **The stub.** Answers come from `e2e/stubModel.mjs`, a scripted
  OpenAI-compatible server behind the e2e stack's "E2E placeholder" model.
  No model is called, so CI runs it too. The workflow starts the stub. It
  runs on pull requests and nightly, not on a push to `main`, so it has not
  run in Actions yet.
- **Receipt.** `npx playwright test e2e/branching.spec.ts`: 6 passed
  (2.0m), counting the sign-in setup. The controls you reported missing were
  present and worked in these runs; whether that matches what you saw needs
  your look. Details are in `goals/station-5-pi-tree-branching.md`.
- **Whole local suite.** 66 passed, 4 skipped (LLM specs, no key), 1 failed.
  The failure is the tabular upload spec: the run put the web app on port
  3100 because the Docker dev stack holds 3000, and local storage's CORS
  allows only port 3000. It is documented in `docs/e2e-ci.md`.

## Verification run tonight

| Command | Result |
|---|---|
| `npm test --prefix backend` (after the injection flags) | 1 failure, `src/lib/pdfText.test.ts` "drops the worker and suspends OCR..."; 3 of 3 runs alone passed. It is a timing test in OCR code this work did not touch; flaky under load. |
| `npm test --prefix backend` (at `908b92fe`) | 241 files passed, 1 failed, 11 skipped; 4414 tests passed, 1 failed, 90 skipped. The failure was `cors.test.ts` "exposes the request id to cross-origin scripts", broken by `db680985`: the voice commit exposes three audio headers to the browser, and only the audio tests had been run before pushing it. The test now expects the new header list (6 of 6 pass). pdfText passed in this run. |
| `npx tsc --noEmit -p backend` | clean |
| `npm run typecheck --prefix frontend` | exit 0 |
| `npm run lint --prefix frontend` | 0 errors, 32 warnings (none in new files) |
| `npm test --prefix frontend` | 258 files, 2211 tests passed |
| `npm run build --prefix frontend` | exit 0 |
| Docker images | built from the repository root by each staging deploy (`mike-staging deploy` exit 0) |
| `npx playwright test e2e/branching.spec.ts` (ports 3201/3100) | 6 passed |
| `npx playwright test` (whole suite, ports 3201/3100) | 66 passed, 4 skipped, 1 failed (upload refused by storage CORS on port 3100; see Branching) |
| `git diff --check` | clean before every commit |

## Spend

OpenRouter, recorded in the reports:

| Item | Spend |
|---|---|
| Auto Mode quality run | $0.5361 |
| Speed run | $0.1578 |
| Probes | about $0.001 |
| Layered-gate runs | $0.18 |
| Layered checks | $0.11 |
| Voice tests tonight (one backend round trip, one bench run) | about $0.002 |
| **Total** | **about $0.99**, against the $2 cap |

Chat turns ran on the OpenCode Go subscription.

## Decisions waiting for you

1. **Sign in to staging** with `owner-link` (above) and try a turn that uses
   the workstation.
2. **The rename** (Interleaf, Slipstream, ...): nothing renamed yet.
3. **TLS interception** in the egress proxy for outbound PII checks, or
   host-level logging only.
4. **Browser models:** they add 0.94 GB to the frontend image. Options:
   strip `onnxruntime-node` in the Dockerfile, or load transformers.js from
   a pinned CDN build instead of bundling it.
5. **Off-machine copies** of backups and VM snapshots: there is no second
   machine yet.
6. **Deploy from git** instead of rsync, so `.git-sha` is exact. That needs
   a deploy key or a public mirror.

## Housekeeping left running on the Mac

- The e2e backend on port 3201, the frontend dev server on 3100 and the
  stub model on 21434 (for the branching runs).
- The `mike-workstation-dev` container (dev VM on port 2222) is still up.

All are local and safe to stop.
