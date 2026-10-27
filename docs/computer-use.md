# Computer use

A person can connect their own computer to Mike and let the assistant look at
and operate it. The computer helper (a menu-bar app in `computer-helper/`) is
the only thing that touches the screen; the backend queues commands and keeps
the device token.

## Surface

- **Devices:** `GET/POST /computers` lists and adds a computer, and
  `DELETE /computers/:deviceId` revokes one. The token is shown once.
- **Helper transport:** the helper polls `/computers/device/next`, posts
  results to `/computers/device/results/:commandId`, and heartbeats to
  `/computers/device/heartbeat` with a bearer token. A device is online for
  60 seconds after its last heartbeat.
- **Assistant tools:** `computer_observe` returns the frontmost app, window
  title and controls with stable refs (`e1`, `e2`, …), optionally with a
  screenshot. `computer_act` clicks, types, presses keys, scrolls and opens
  apps by ref or coordinates from the latest observation; a batch stops on the
  first failure or when the person takes over.

The helper is a prototype without per-action approval. Its own README covers
macOS permissions, configuration and the wire protocol.

State as of 2026-10-27; re-read `backend/src/modules/computers/` and
`computer-helper/README.md` before relying on endpoints, limits or
capabilities.
