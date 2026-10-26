# The agent's own desktop

A container with a virtual X display, the Openbox window manager, Firefox
ESR and Mousepad, and the X11 computer helper (`crates/x11`). The agent
works here instead of on a person's computer. The person can watch the
screen through noVNC on port 6080, which is view-only by default.

## Build and run

From `computer-helper-rs/`:

```bash
docker build -f sandbox/Dockerfile -t computer-sandbox .
docker run --rm -p 127.0.0.1:6080:6080 \
  -e COMPUTER_SERVER_URL=https://choir-ip.com/api \
  -e COMPUTER_DEVICE_TOKEN=... \
  computer-sandbox
```

Create the device token in Settings › Computers. While the container runs,
`http://localhost:6080/vnc.html` shows its screen.

| Variable | Meaning |
| --- | --- |
| `COMPUTER_SERVER_URL` | The API, ending in `/api`. |
| `COMPUTER_DEVICE_TOKEN` | The device token. |
| `COMPUTER_GATE_PASSWORD` | The shared password, when a gate stands in front of the server (staging). |
| `COMPUTER_HELPER_CONFIG` | A JSON config file, the same shape as the other helpers' config, used instead of the variables above. |
| `COMPUTER_PLATFORM` | `sandbox` (the default) or `linux`. On a person's own X11 session use `linux`, which keeps the default blocked apps. |
| `SANDBOX_SCREEN` | The virtual screen, `1280x800x24` by default. |
| `SANDBOX_VNC_INPUT` | `1` lets the noVNC viewer type and click as well as watch. |

noVNC has no password. Publish port 6080 to localhost only, or put it behind
a proxy that authenticates.

## What the helper reports

- **Platform:** `sandbox`.
- **Coordinates:** `screen`. Clicks and scrolls may aim at screenshot points
  as well as refs.
- **Takeover:** `none`. Only the agent acts here.
- **Secure input:** `best_effort`. The helper refuses to type or click while
  a password field from the last observation has focus.

The element tree comes from AT-SPI, so the apps must have accessibility on.
The image sets `GTK_MODULES` and `GNOME_ACCESSIBILITY`, and the helper turns
on the session's accessibility flag when it starts.

## Check it

```bash
python3 sandbox/smoke.py --out /tmp/sandbox-smoke
```

The script stands in for the API and drives the helper in a fresh container.
It opens Mousepad, types two lines, and reads them back from the element
tree. It then opens a menu by ref and checks that a stale frame is refused.
`--out` keeps the screenshot, the observation and the helper's log.
