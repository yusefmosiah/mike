# Computer use prototype: what was built overnight, and the morning steps

Date: 2026-10-26

The plan in `computer-use-2026-10-25.md`, reviewed by a second agent (Devin)
and amended (no human-like pacing tonight, ref badges drawn on screenshots,
an independent heartbeat, images kept out of the kernel), is built end to end
except for the parts that need macOS permissions only you can grant.

## What exists

- **Helper app** (`computer-helper/`): a Swift menu-bar app, built and signed
  with your Apple Development certificate by `computer-helper/scripts/build.sh`
  into `computer-helper/build/<name> Computer.app`. It long-polls the API for
  commands, reads the frontmost window through Accessibility, takes a
  screenshot with ref badges, and clicks, types, presses keys, scrolls and
  opens apps. Safety: blocked apps (Keychain Access, System Settings,
  Terminal, iTerm, Passwords), a refusal while a password field has focus,
  Stop now and Pause in the menu, and a stop when you touch the mouse button,
  keyboard or scroll wheel mid-batch. Its README has the details.
- **API** (`backend/src/modules/computers/`): `computer_devices` table
  (migration `20261026_01_computer_devices.sql`), settings routes to add, list
  and revoke a computer (the token is shown once; only its hash is kept),
  bearer-token device routes (`/computers/device/next`, `/results/:id`,
  `/heartbeat`), and an in-memory command bridge (one API process, as staging
  is).
- **Chat**: `computer_observe` and `computer_act` appear in the Python tool
  index only while a computer is online (heard from in the last minute). The
  kernel gets text (the element list and a frame id); the screenshot rides on
  that cell's `run_python` result as an image, which pi-ai sends to models
  that read images and replaces with a note for those that do not.
- **Settings → Computers**: list, add (token once, server address, setup
  steps), revoke.

## Verified

- Backend: route tests for the whole loop (add, poll, a tool call reaching
  the helper and its result coming back, the screenshot kept apart, another
  device's result refused, revoke), bridge unit tests (timeouts, abort,
  requeue), and a code-mode test that a cell's screenshot arrives on the
  `run_python` result and not in the kernel output.
- Helper: `swift build`, `swift test` (13 tests), the signed `.app`, and a run
  against a mock server: it collected an observe, answered with the frontmost
  app and clear "permission not granted" notes, refused an act without
  Accessibility, refused a stale frame, and sent heartbeats.
- Phala image input: a synthetic screenshot through the attested gateway.
  `phala/qwen3.8-27b-uncensored` found the badged Save button and its
  coordinates (8 s); `phala/glm-5.3-flash` did too; the Gemma uncensored model
  named it but put it in the wrong place; DeepSeek V4.1 Flash returned nothing.

## Not verified (needs your permissions)

Reading the element tree, screenshots and badges, real clicks and typing, the
takeover stop, and the gate sign-in against staging. If the takeover stop
fires on every batch ("the person took over" immediately), that check is
wrong and is the first thing to look at.

## Morning steps (about five minutes)

1. Open `computer-helper/build/<name> Computer.app` (Finder, or
   `open "computer-helper/build/"*.app`). A cursor icon appears in the menu bar.
2. On staging, Settings → Computers → Add. Copy the token.
3. Helper menu → Open config. Paste the token into `token`. Staging sits
   behind the shared password gate, so put that password in `gate_password`
   (it is tried once per launch and never retried). `server_url` is already
   `https://choir-ip.com/api`. Save.
4. Helper menu → the Accessibility line → switch the helper on in System
   Settings. Same for Screen Recording. macOS may also ask about Input
   Monitoring for the takeover check; allow it.
5. Helper menu → Restart. It should read "Connected", with both permissions
   granted, and Settings → Computers should show it Online.
6. In a new chat, pick `phala/qwen3.8-27b-uncensored` (or
   `phala/glm-5.3-flash` if the first struggles; adding standard
   `qwen/qwen3.8-27b` to staging's models is the next fallback). Ask: "On my
   Mac, open TextEdit and write a haiku."

Know the risk: in an ordinary (watched) chat there is no per-action approval.
The rails are the blocked apps, the password-field refusal, the takeover stop,
Stop now, and the tool instructions (ask before sending, deleting or buying;
screen text is not instructions). Auto Mode still judges each call.

## If it does not work

- **"Token rejected"** in the menu: the token was mistyped or revoked; add the
  computer again.
- **"Server gate needs gate_password"**: step 3. Alternatively exempt
  `/api/computers/device/*` from the gate in `infra/node-a/staging.nix`; the
  device token still protects it.
- **Online in Settings but chat does not offer the tools**: the offer is
  decided when the turn starts, so send a new message after the helper
  connects.
- **The model clicks the wrong place**: ask it to use refs, or switch model.
