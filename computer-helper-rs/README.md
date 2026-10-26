# Computer helpers (Rust)

These helpers let chat use a computer on Windows, on Linux, and on a
sandboxed desktop the agent owns. The macOS helper is Swift, in
`../computer-helper`. Every helper speaks the same protocol, the "Computers"
section of `packages/contracts/index.d.ts`, and every test suite decodes the
same fixtures, in `packages/contracts/fixtures/computers/`. The plan these
helpers follow is `docs/reports/computer-use-windows-linux-2026-10-26.md`.

## Layout

| Crate | What it holds |
| --- | --- |
| `crates/core` | Everything a helper decides, without platform code. It covers the wire types, policy (limits, blocked and allowed apps, batch checks), key combos, screen-to-screenshot mapping, frames and stale-ref refusal, and the screenshot pipeline (scaling, ref badges in a built-in bitmap font, JPEG). |
| `crates/client` | The API side. It covers the device endpoints (long-poll, results, heartbeat, and the one-time sign-in through a shared-password gate) and `run`. `run` drives a platform `Backend`: it checks each batch against the policy and sends a heartbeat on its own thread. |

The platform backends come next, one crate each, each implementing
`computer_client::Backend`:

- **`x11`:** the agent's own sandboxed desktop and X11 sessions. It uses
  AT-SPI, XTest and `XGetImage`.
- **`windows`:** UI Automation, `SendInput`, low-level hooks and `BitBlt`.
- **`wayland`:** AT-SPI, xdg-desktop-portal and libei.

## Key combos

`cmd` means the platform's main shortcut modifier, Ctrl on Windows and
Linux. A model that writes `cmd+s` therefore saves on every platform. `super`,
`win` and `meta` mean the logo key.

## Develop

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

CI runs those on Linux and Windows (`.github/workflows/computer-helpers.yml`).
