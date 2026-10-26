# Computer helper (macOS)

A small menu-bar app that lets chat use your own Mac when you ask it to. Chat
calls `computer_observe` and `computer_act` from its Python cell; the server
queues each call for this helper, which reads the frontmost window, takes a
screenshot, clicks and types, and returns the result.

It is a prototype: input is instant (no human-like pacing yet) and there is no
per-action approval. The safety rails are listed below.

## Build

```bash
./scripts/build.sh
```

This builds a release binary and assembles `build/<name> Computer.app`, where
`<name>` comes from `packages/brand/brand.json`. The script signs with the
Apple Development identity named in the script (override with
`SIGN_IDENTITY=...`, or `SIGN_IDENTITY=-` for ad-hoc). The bundle id
(`org.privateaistack.computer-helper`) and identity stay the same between
builds, so macOS keeps its permission grants after a rebuild.

Tests cover the pure parts (wire protocol, config, policy, key parsing):

```bash
swift test
```

## First run

1. Open `build/<name> Computer.app`. A cursor icon appears in the menu bar and
   the helper writes a config template.
2. In the web app, open Settings → Computers, add a computer and copy its token.
3. Menu → Open config. Paste the token into `token`. Set `gate_password` if the
   server sits behind the staging password gate (see below). Save.
4. Menu → "Accessibility: not granted — open settings…". macOS shows its prompt
   and adds the helper to System Settings › Privacy & Security › Accessibility;
   switch it on.
5. Menu → "Screen Recording: not granted — open settings…", and switch it on
   under Screen & System Audio Recording.
6. Menu → Restart. The status should read "Connected", and both permission
   lines "granted".

## Config

`~/Library/Application Support/org.privateaistack.computer-helper/config.json`
(owner-only file mode, since it holds the token):

| field | meaning |
| --- | --- |
| `server_url` | The API base. For a web deployment this is the site origin plus `/api`, because the web app proxies `/api/*` to the backend: staging is `https://choir-ip.com/api`. A local backend is `http://localhost:3001` (no `/api`). |
| `token` | The device token from Settings → Computers. Only its hash is stored on the server. |
| `gate_password` | Staging's shared password, if the site is behind the password gate. The helper signs in once per launch; a wrong password is never retried, because five wrong tries block the address for a day. Leave empty elsewhere. |
| `allowed_apps` | Bundle ids the helper may act in. Empty means every app not blocked. |
| `blocked_apps` | Bundle ids the helper never acts in or opens. Defaults: Keychain Access, System Settings, Terminal, iTerm, Passwords. |
| `speed` | `instant`, the only speed so far. |

Edit the file, then choose Restart.

## Safety

- **Blocked and allowed apps.** Before every click, key, scroll or type, the
  helper checks the frontmost app against the lists; `open_app` checks the app
  it would open.
- **Secure input.** When a password field has focus (macOS secure input), the
  helper refuses to click or type. It also never reads the value of a secure
  text field.
- **Stop now / Pause.** Stop now ends the running batch at the next action or
  within 100 ms of a wait. Pause stops polling and heartbeats, so the server
  marks the computer offline and chat stops offering it.
- **Takeover.** A listen-only event tap watches for clicks, key presses and
  scrolls. Every event the helper posts is tagged (`eventSourceUserData`), so
  any untagged one is you: the batch stops with "the person took over". Mouse
  movement alone does not count, so brushing the trackpad does not interrupt.
- **Limits.** At most 20 actions per batch, 5 s per wait and 15 s of waiting
  per batch; at most 150 elements per observation, strings cut at 80
  characters.
- **Stale frames.** Refs (`e1`, `e2`, …) and screenshot coordinates belong to
  one observation. An `act` whose `frame_id` is not the latest observation is
  refused if it uses either; observe again.

## Protocol

Types are declared in `packages/contracts/index.d.ts` ("Computers") and
mirrored in `Sources/ComputerHelperCore/Protocol.swift`.

- `GET {server_url}/computers/device/next?wait=25` with
  `Authorization: Bearer <token>`: 200 with one command (`observe` or `act`),
  or 204 when nothing arrived in 25 s.
- `POST {server_url}/computers/device/results/{id}` with
  `{"ok":true,"observation":…}`, `{"ok":true,"act":…}` or
  `{"ok":false,"error":"…"}`.
- `POST {server_url}/computers/device/heartbeat` every 15 s, independent of the
  command loop, so a long batch does not make the computer look offline. Its
  body says what this helper is and can do (`ComputerHeartbeat`):
  `{"platform":"macos","capabilities":{"coordinates":"screen","takeover":"full","secure_input":"system"}}`.
  Chat passes those limits on to the model.

`observe` returns the frontmost app, its focused window's title, and the
window's visible actionable and text elements, each with a ref, role, label
and frame in screenshot pixels. Roles are the shared names every helper uses
(`button`, `textfield`, `menuitem`, ...; `ComputerRole` in the contracts),
with the macOS role in `native_role`. With `screenshot: true` it adds a JPEG of the
main display scaled to 1280 px on the long edge, with each ref drawn at its
element's centre. Without Accessibility or Screen Recording permission the
observation still arrives, with `elements_note` or `screenshot_note` saying
what is missing.

`act` actions: `click` (`ref`, or `x`/`y` in screenshot pixels; `button`,
`count`), `type` (`text`; newlines and tabs are sent as keys), `key` (`combo`
such as `cmd+s`, `return`, `cmd+shift+t`, `f5`; US key layout), `scroll`
(`dy > 0` scrolls down, `dx > 0` right, in lines; optional `ref` or `x`/`y`
to point at first), `open_app` (`name` or `bundle_id`), `wait` (`ms`). A left
single click on a button-like ref uses the accessibility press action rather
than the mouse. The batch stops at the first failure and reports each
action's outcome.
