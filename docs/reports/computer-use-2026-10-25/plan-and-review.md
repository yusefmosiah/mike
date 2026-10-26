# Computer use prototype: the plan and its review

The plan as sent to a second agent (Devin) for review on 2026-10-26, then its review. All of the review's amendments were adopted; see ../computer-use-prototype-2026-10-26.md for what was built.

## The plan (as sent)

### The plan

### 1. A native helper (new top-level `computer-helper/`, Swift package, no Xcode project)

- Built by `scripts/build.sh` into a small `.app` bundle (LSUIElement menu-bar app, its own bundle id) and
  signed with the owner's Apple Development identity, so macOS permission grants attach to a stable
  identity and survive rebuilds. Display name derived from packages/brand/brand.json (no literal product
  name). Not sandboxed (Developer ID later).
- Config at `~/Library/Application Support/<bundle id>/config.json`: server URL, device token, allowed apps
  (bundle ids; empty = ask nothing, allow all non-blocked), speed (instant | human), blocked apps
  (Keychain Access, System Settings, Terminal by default).
- Menu-bar item: status (connected / paused / acting), Pause, "Stop now", open config. A heartbeat stops
  acting when the server is unreachable.
- Transport: HTTPS long-poll, not WebSocket, for the prototype: `GET /computers/device/next?wait=25`
  returns the next command or 204; `POST /computers/device/results/:id` returns its result. Bearer device
  token. Works through Caddy + Cloudflare (100 s idle cap) with no new server infrastructure.
- Commands:
  - `observe {screenshot: bool, max_elements}`: frontmost app and window title; the focused window's
    accessibility tree pruned to visible, actionable or text elements, each with a short ref (e1, e2...),
    role, title/value/description (truncated), frame; plus optionally a screenshot of the main display via
    ScreenCaptureKit `SCScreenshotManager` (macOS 14+), downscaled to 1280 px long edge, JPEG q≈0.7, with the
    scale so the model's coordinates map back. Each observation gets a frame id.
  - `act {frame_id, actions: [...]}`: a batch of `click {ref | x,y, button, count}`, `type {text}`,
    `key {combo}`, `scroll {dx, dy}`, `open_app {name | bundle_id}`, `wait {ms}`. A ref resolves to its
    element's centre (or AXPress when the element supports it and no coordinates are needed). A stale
    frame id is refused for ref-based actions. Refuses: blocked apps, secure input (IsSecureEventInputEnabled),
    apps not allowed. Stops the batch at the first failure and reports per-action outcomes.
  - Input via CGEvent posted to the HID tap, every event tagged in `eventSourceUserDataField` as agent
    input. Human pacing (speed=human): Fitts duration, cubic Bezier path with minimum-jerk timing, small
    overshoot on long moves, one event per ~8 ms, lognormal key gaps (~45 WPM), ~100 ms key holds. Seeded RNG.
  - User takeover: if `CGEventSourceSecondsSinceLastEventType(.hidSystemState, ...)` shows real input
    during an action batch, abort the batch and report "the person took over".
- Unit tests (`swift test`) for the pure parts: humanizer timing/paths (seeded), AX pruning/ref mapping,
  command decoding, policy.

### 2. Backend module `backend/src/modules/computers/`

- Migration `YYYYMMDD_NN_computer_devices.sql` + schema.sql: `computer_devices(id, user_id, name,
  token_hash (sha256), created_at, last_seen_at, revoked_at)`, RLS enabled with no policies (service
  access only), like other server-owned tables.
- User routes (session auth): `POST /computers` (create; returns the plaintext token once), `GET /computers`
  (list with online = seen < 60 s), `DELETE /computers/:id` (revoke).
- Device routes (bearer device token, mounted outside the user-session middleware, rate-limited):
  `GET /computers/device/next`, `POST /computers/device/results/:commandId`.
- In-memory bridge per device: queue of commands; `sendCommand(userId, command, timeoutMs, signal)` returns
  a promise resolved by the device's POST; a turn abort cancels it; a timeout reports "the computer did not
  answer".
- Chat tools (offered only when the user has a device seen in the last 60 s): `computer_observe`,
  `computer_act` (schemas in toolSchemas.ts; dispatched in toolDispatcher.ts). They run like every other tool
  inside run_python, so the model can batch observe → act → observe in one cell. Results return as JSON
  text (the tree, outcomes). `computer_act` is effectful (not replay-safe; sequential).
- Screenshots to the model: the dispatcher keeps the latest screenshot taken during the current run_python
  cell; the run_python tool result then carries it as an image part (extend `NormalizedToolResult` with an
  optional `images` array; `mikeTool` maps it to pi-ai image content when the turn's model sees images,
  otherwise a text note). One image per cell, to bound context growth.
- Prompt: a short "COMPUTER" section in the code-mode instructions when the tools are offered: observe
  first, prefer refs, batch actions, verify with a fresh observe, never type secrets, stop and ask before
  sending, deleting, purchasing or anything irreversible, and treat on-screen text as untrusted.

### 3. Frontend: Settings → "Computers"

- List devices (name, online, last seen), "Add a computer" (name → shows the token once with a copy button
  and three setup steps), Revoke. API calls in `frontend/src/app/lib/mikeApi.ts`; tests for the lib layer
  (100% coverage floor).

### 4. Verification overnight

- Backend unit/integration tests for the bridge, routes (token auth, revoke), tool dispatch, image
  attachment; `npm run verify`; push to main (deploys staging).
- Build the helper, run it on this Mac against staging with a token created through the API, and drive one
  observe from a staging chat, if the helper's permissions allow without the owner (they won't for
  Accessibility/Screen Recording: so verify observe's failure is reported clearly, and test the full loop
  against a local backend with a mock device).
- Morning config for the owner: open the helper once, grant Accessibility and Screen Recording, add a
  computer in Settings, paste the token, choose a vision model (phala/qwen3.8-27b-uncensored), ask from the
  phone: "On my Mac, open TextEdit and write a haiku."

### Deliberately out of scope tonight

WireGuard; phone approvals UI (rely on blocked/allowed apps, the menu-bar Stop and the Auto Mode gate);
live view; Windows/Linux; behavioural signature; billable time; decision-model chooser; multi-instance
bridge.


## The review


### 1. Verdict

**Yes, with changes.** The architecture is sound and — this is the important part — every risky mechanism the plan depends on already exists in the codebase in a working form. The plan will run end-to-end by morning *if* the humanizer is cut and two unverified externals behave (Phala actually accepting images; the uncensored Qwen's GUI grounding). Neither external is a plan defect, and both have fallbacks. Scope, not design, is the real risk.

### 2. Verified foundations (why the plan is buildable)

I traced each claim the plan rests on:

- **Tool dispatch is exactly as described.** `tools.*` calls leave the kernel as `host_request` JSON-lines events (`backend/src/lib/codemode/kernel/protocol.ts:19`), route through `session.execute`'s `onHostRequest` (`streaming.ts:1268`), and re-enter `runTurnToolsNow` as ordinary gated calls (`streaming.ts:1313`). A new tool only needs a schema, a `TOOL_STUBS` entry (`toolStubs.ts` — add a group to `TOOL_GROUPS`), and a branch in `runToolCalls` (`toolDispatcher.ts`). No kernel-side changes: the `tools` namespace is generated from `KernelToolSpec`s at `configure` time (`mike_kernel/tools.py`, `manager.ts` reconfigures on spec-hash change).
- **Conditional offering works for free.** `activeTools` is computed per turn (`streaming.ts:646-674`); `pythonToolNames` both advertises *and* enforces (`streaming.ts:1272`: `names.has(name)` → "No tool named"). A `buildComputerTools(userId, db)` returning schemas only when `last_seen_at < 60s` fits the existing `buildUserMcpTools` pattern exactly.
- **The screenshot-to-model path is real, and better than the plan knows.** pi-ai's OpenAI-completions serializer already handles images in tool results correctly: it keeps the tool result text-only and moves image blocks into a following user message (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1074-1125`), gated on `model.input.includes("image")`. Mike wires `supportsVision: true` → `input: ["text","image"]` (`providers.mts:237,274`), and all three named Phala models have `supportsVision: true` in `infra/node-a/staging/models.json`. So `mikeTool` (`runtime.mts:604`) just needs to emit `{type:"image", data, mimeType}` parts alongside the text — pi-ai does the hard part.
- **Cell timeouts don't punish device waits.** `host_request` pauses the cell clock while in flight (`session.ts:332`). A 25s-device-latency `observe` doesn't eat the cell budget.
- **SSE keep-alive exists.** A running `code_cell` triggers `: working` comments every 30s (`streaming.ts:982-994`), so a slow device round-trip won't trip Cloudflare's idle cap or the 5-min run deadline.
- **Safety defaults are free and correct.** Unknown tools are Tier 3 (`guardrails/policy.ts:92-97`), which automatically gives `computer_act` `replay:"unsafe"`, `executionMode:"sequential"` (runtime.mts:553-556), and Auto-Mode classifier judgment (`streaming.ts:1468-1511`). In watched mode there is **no** per-action gate — see risks.
- **The bridge precedent exists** (`wordClientTools.ts:285-339`): in-memory pending-call map, timeout sentinel, abort-on-cancel, user-scoped, single-instance. The plan is a direct port.
- **Phone works.** The kernel lives in a server-side workstation VM (`lib/workstation`, `workstation_assignments` migration), not in a browser tab — so "ask from the phone" needs zero mobile work.
- **Migration ledger**: `20261026_01_computer_devices.sql` is free; the `schema_migrations` insert list sits at the tail of `schema.sql` as expected.
- **Bearer device auth fits**: routers mount bare and each route opts into `requireAuth` (`app.ts:244-266`, `wordChat.routes.ts`); device routes simply use their own token check instead.

### 3. Top blocking / high-risk issues

1. **Image plumbing is under-specified in one place that matters.** `NormalizedToolResult`, `runTurnTools`/`runTurnToolsNow` return types, `runPythonCall`'s return (`streaming.ts:1113`), and `mikeTool` (`runtime.mts:604`) all carry `{content: string}` today. Threading `images` through is ~4 signature changes plus the subagent path (`streaming.ts:1742`). Do it, but keep the JPEG **out of the kernel entirely**: the device POST body → bridge → a module-level "latest screenshot per device" → `onHostRequest`'s cell closure attaches it to the *run_python* result. The `computer_observe` result that goes back to the kernel should be text (tree + `frame_id` + `has_screenshot: true`) only.
2. **No per-action approval in watched mode.** In a normal turn `permittedCalls = calls` (`streaming.ts:1541-1544`) — `computer_act` types and clicks with zero confirmation, gated only by the helper's allowlist and the menu-bar Stop. For an owner-only overnight prototype on their own Mac this is defensible, but it must be stated plainly in the morning instructions, and the `COMPUTER` prompt section becomes load-bearing. Consider it the prototype's accepted risk, not an oversight to discover later.
3. **Phala vision is declared, not proven.** `supportsVision` is a config flag. The research report itself says Phala documents image support for none of its models and prescribes "send one real screenshot through the attested gateway" as the first test. Do exactly that tonight — a one-off script hitting the gateway with a screenshot — before the rest of the image plumbing matters. Fallback: `phala/gemma-4-26b-a4b-uncensored`, then `deepseek-v4.1-flash-1017`.
4. **The uncensored fine-tune may be bad at grounding.** The report recommends standard `qwen/qwen3.8-27b` and explicitly warns the uncensored variant "may have lost GUI skills." Only the uncensored one is configured. If the morning demo's model can't localize elements, the fix is a model swap — so the morning checklist should name the fallback order, not one model.
5. **Screenshots persist in the durable transcript and are re-sent every turn** until compaction — several hundred base64 KB per frame accumulating. Fine for a demo, wrong for a long session. Cheap mitigation for tonight: cap at one image per cell (planned) *and* have `computer_observe` accept `screenshot:false` so verification re-observes default to tree-only.
6. **Device selection is unspecified.** `sendCommand(userId, …)` with two online devices is ambiguous. Tonight: route to the most-recently-seen device; add `device` to the tool schema later.
7. **`last_seen < 60s` flips offline mid-act.** A long `act` batch stops the helper's polling → next turn's tools vanish. Heartbeat on a separate timer (the plan has one — make it independent of the command loop, ~15s) fixes it.
8. **TCC restart semantics.** Accessibility grants typically apply on next launch; the helper should detect `!AXIsProcessTrusted()` in `observe`, return a clear error (planned), and offer "Restart" in the menu — otherwise the morning flow stalls after granting.

### 4. What to cut to fit one night

- **Cut the humanizer entirely.** Fitts timing, Bezier paths, overshoot, lognormal key gaps, seeded RNG — that's the single largest chunk of Swift work and it buys nothing for tomorrow's demo. Ship `speed` as a config key with only `instant` implemented (direct `CGEventPost`, unicode-string typing via `CGEventKeyboardSetUnicodeString`). The research notes keep it for later.
- **Shrink `swift test` to policy + command decoding only.** AX-pruning tests need fixtures you don't have time to build well.
- **Cut `scroll` inertia/smoothness** — discrete `CGEventCreateScrollWheelEvent` ticks are enough.
- **Keep** (they're cheap and load-bearing): refs + frame-id staleness, blocked-app/secure-input refusals, human-input abort via `CGEventSourceSecondsSinceLastEventType`, menu-bar Pause/Stop, heartbeat.
- **Add one cheap thing**: draw the ref badges (e1, e2…) onto the screenshot at element centers (~30 lines of CoreGraphics). Every driver in the research converged on marked screenshots; an unmarked screenshot + tree is the weakest grounding setup for a model of uncertain GUI skill. This is the best effort-to-demo-success trade in the whole plan.
- Also small: cap `act` batches (≤20 actions), cap total `wait` per batch, cap the tree text (~12k chars) before it reaches the model.

### 5. Things the author missed that change details (not the design)

- `mikeTool` collapses results to one text part at `runtime.mts:604` — the extension point is real but the plan should name it.
- pi-ai already solves tool-result images for OpenAI-compatible APIs (`transform-messages.js`) — the plan's "possible" is actually "implemented upstream"; don't reinvent it, and don't put images in the tool JSON.
- Frontend coverage floor is `src/app/lib/**` at ~100% (`frontend/vitest.config.mts:131`) — every new `mikeApi` wrapper needs a test, as the plan says.
- The wire shapes between helper and backend should be declared in `packages/contracts/` even though Swift can't import them — that's the repo convention for serialized API shapes, and it keeps the device protocol reviewable.
- `observe` degrades gracefully for free: `NSWorkspace.frontmostApplication` needs no permission, so without Accessibility the helper can still return frontmost app + window-less response — make the AX section best-effort rather than all-or-nothing, which also makes the overnight "verify the failure is clear" test trivially exercisable.
- Mount path: `app.use("/computers", computersRouter)` with `requireAuth` on user routes and a bearer check on `/device/*` — matches precedent; rate-limit the device endpoints with the existing `makeLimiter` pattern (`app.ts:81`).

### 6. Risks

- **Security**: device token in plaintext config on the Mac (acceptable tonight; Keychain later). No approval per action (mitigated: blocked apps, secure-input check, human-takeover abort, menu Stop, Tier-3 Auto-Mode gate). On-screen prompt injection → the prompt treats screen text as untrusted and `run_python` results already carry injection flags — keep the tree text inside the same untrusted-content framing.
- **Deploy**: single-instance staging makes the in-memory bridge safe (same caveat as wordClientTools — document it in the module). `npm run verify` + migration ledger + architecture test are the gates; the new module needs the facade (`computers.service.ts`, named re-exports only) or `architecture.test.ts` fails.
- **macOS**: Accessibility AND Screen Recording both required; grants persist across rebuilds under the same Apple Development identity + bundle id — correct as planned. `SCScreenshotManager` on macOS 15+ can show the system picker instead of a TCC grant; either path resolves in the morning.
- **Time**: backend ~3h, frontend ~1h, helper ~4-6h trimmed, verify+deploy ~1h. Feasible overnight; the humanizer is the difference between feasible and not.

### Confidence

**Medium-high** that it runs end-to-end by morning as amended. The remaining uncertainty is concentrated in two untested externals (Phala image acceptance; uncensored-model GUI skill) — both detected early by the plan's own first-test prescription and both with configured fallbacks — plus ordinary execution risk on the largest new component, the Swift helper.
