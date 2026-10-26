# Computer use on Windows and Linux: research and a build plan

Date: 2026-10-26

The macOS helper (`computer-helper/`, see `computer-use-prototype-2026-10-26.md`)
speaks a small protocol: the helper long-polls the API with a device token
and answers `observe` (front window's controls with refs, a 1280 px
screenshot with ref badges) and `act` (click, type, key, scroll, open_app,
wait), with blocked apps, a password-field refusal, Stop/Pause, a takeover
stop and stale-frame refusal. This report asks what the same helper takes on
Windows and on Linux, and adds a third option the research kept pointing at:
a desktop the agent owns.

Two research passes (Windows; Linux and agent-owned desktops) are condensed
here, with their sources. Claims they could not confirm are marked
**[unverified]** and are the first things the spikes below must settle.

## The short answer

1. **Give the agent its own Linux desktop first.** An X11 desktop (Xvfb or
   Xvnc, a light window manager, Firefox) inside a container makes every part
   of the protocol easy: full accessibility coordinates, XTest input, no
   permission prompts, no takeover problem, nothing at risk on the person's
   machine. It works the same for people on Mac, Windows or Linux, because
   it runs beside their existing workstation VM on the server, and the person
   watches it through noVNC in the web app. It cannot use their logged-in
   apps, which is what the next two steps are for.
2. **Windows helper on the person's own PC** next: it reaches the most
   people, and every API it needs (UI Automation, `SendInput`, low-level
   hooks, `BitBlt`) is stable and permission-free at normal integrity.
3. **Linux helper on the person's own desktop** last, in tiers: X11 fully;
   GNOME and KDE on Wayland with caveats; wlroots compositors best effort.
   Wayland is now the default almost everywhere (GNOME 50 and Ubuntu 26.04
   have no X11 session) and it withholds exactly what the helper needs:
   global coordinates, a global input listener and the active window.
4. **One Rust codebase for Windows and Linux** (and the sandbox, which is the
   Linux X11 backend), sharing the protocol client, config, policy, frames
   and the screenshot pipeline. The macOS helper stays Swift.

## The protocol: what changes

Small, backward-compatible additions to the "Computers" types in
`packages/contracts/index.d.ts`:

- **Platform and capabilities in the heartbeat**:
  `{platform: "macos" | "windows" | "linux" | "sandbox", capabilities:
  {takeover: "full" | "none", coordinates: "screen" | "window" | "refs_only",
  secure_input: "system" | "best_effort"}}`, stored on `computer_devices`
  (a `platform` column and a `capabilities` jsonb). The tool description
  tells the model what this computer can and cannot do, for example "click
  by ref only" on a Wayland desktop whose window origin is unknown.
- **Choosing a computer.** With more than one online, `computer_observe`
  and `computer_act` take an optional `computer` (a name); the default stays
  the most recently seen one. The agent's own desktop is one of these.
- **Roles are a shared vocabulary** (`button`, `checkbox`, `textfield`,
  `combobox`, `link`, `menuitem`, `tab`, `listitem`, `text`, ...) mapped
  from each platform's types, not macOS `AX*` names. The macOS helper maps
  to them too.
- **Keys.** `combo` names are platform-neutral (`ctrl`, `cmd`/`super`,
  `alt`, `shift`, named keys); each helper documents which layout it assumes.
- **`elements_note` and coordinate-free clicks** are already in the
  protocol; Linux on Wayland leans on them.

The backend changes are small: the columns, the parameter, and
capability-aware tool text. The bridge, routes and image path stay as they
are.

## 1. The agent's own desktop (sandbox)

**What it is.** A container image: Xvfb or Xvnc, Openbox or XFCE, Firefox,
a file manager and an office suite, accessibility switched on
(`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, GTK's `toolkit-accessibility`), and
the Rust helper with its X11 backend. The server mints its device token when
it starts the container, so nobody pastes anything. The web app embeds a
noVNC view, view-only by default, with "Take control" and Stop.

**Why first.**
- Every API is easy under X11: AT-SPI gives real screen coordinates, XTest
  injects input, `_NET_ACTIVE_WINDOW` gives the front window, `XGetImage`
  takes the screenshot, and nothing asks for permission.
- It tests the Linux helper's X11 path in CI for free.
- Its risk is contained: no real accounts, a network allowlist, a reset
  between tasks. Prompt injection from web pages is still possible, but the
  damage is limited to the sandbox and what it can reach.
- Prior art converges on it: Anthropic's computer-use demo (X11 + VNC +
  noVNC), Bytebot (XFCE + noVNC + REST daemon), E2B desktop, Hugging Face's
  ScreenEnv, and OSWorld's evaluation VMs.

**Where it runs.** Beside the person's workstation VM on node-a (same
lifecycle and isolation). Resource cost is the open question (an X server
plus Firefox is roughly 0.5–1.5 GB of RAM **[unverified for our image]**),
so it starts on demand and stops when idle.

**What it cannot do.** Use the person's own logins, files and apps. Files
move through the existing workstation and documents; logins are the person's
choice, ideally through the vault.

**Effort:** 1–2 weeks (image, X11 backend of the Rust helper, on-demand
lifecycle, noVNC view in the web app).

## 2. Windows helper

**Stack.** Rust (`windows-rs` for Win32 and COM, the `uiautomation` crate or
direct COM for UI Automation, `tray-icon`), sharing the core crate with
Linux. The Windows research recommended C#/.NET as the fastest route for
Windows alone, at the cost of a 15–150 MB self-contained runtime; Rust costs
an estimated 1.5–2x the Windows-only effort but gives a small, static, signed
binary (which also matters for the antivirus point below) and one codebase
with Linux. If Windows ships alone and soon, C# is the right call; with
Linux and the sandbox in the plan, Rust is.

**Per command.**
- *observe.*
  - **Front app.** `GetForegroundWindow`, then the process exe name. For a
    Store app, the AppUserModelID serves as the `bundle_id`.
  - **Element tree.** UI Automation from `ElementFromHandle(foreground)`.
    One `FindAll` with a `CacheRequest`, so each element's properties arrive
    in a single cross-process call (without caching, a big tree takes
    seconds). Cached properties: control type, name, rect, enabled,
    offscreen, keyboard focus, `IsPassword`. The walk runs on a worker
    thread with a deadline, because a hung app blocks UIA calls. Chromium
    138+ exposes native UIA by default; older Electron apps may need one
    retry after the first call wakes accessibility up **[unverified]**.
  - **Screenshot.** `BitBlt` from the screen DC, or DXGI Desktop
    Duplication if speed demands it. Neither draws a border or asks for
    consent. Windows.Graphics.Capture shows a yellow border unless the
    person grants borderless capture, which an unpackaged exe may not be
    able to request.
  - **Coordinates.** The helper is Per-Monitor-V2 DPI aware, so UIA rects
    are in physical pixels. They map to screenshot pixels with the
    monitor's origin and scale. v1 shows one monitor: the one holding the
    front window.
- *act.*
  - **click.** `InvokePattern.Invoke` for a left single click on a
    button-like ref. Otherwise `SendInput` mouse events with
    absolute-virtual-desktop coordinates.
  - **type.** `KEYEVENTF_UNICODE`, one event per UTF-16 unit, so the
    keyboard layout does not matter. A clipboard fallback covers
    apps or IMEs that ignore it.
  - **key.** Virtual-key combos, with the extended-key flag where needed.
  - **scroll.** `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL`.
  - **open_app.** `ShellExecuteEx` for ordinary apps;
    `IApplicationActivationManager` for Store apps, found by their AUMID.
- *Safety rails.*
  - **Takeover.** Low-level mouse and keyboard hooks (`WH_MOUSE_LL`,
    `WH_KEYBOARD_LL`), installed only while a batch runs. Our events carry
    a random per-launch `dwExtraInfo` tag. An event without the "injected"
    flag is the person, and stops the batch.
  - **Password fields.** UIA `IsPassword` on the focused element, plus the
    `ES_PASSWORD` style on Win32 edit boxes. Password managers and
    credential prompts are blocked by default. There is no equivalent of
    macOS secure input, so this rail is best effort; the capability field
    says so.
  - **Elevated windows.** UIPI silently drops our input to an elevated
    (admin) window, so the agent would believe a click worked. Compare the
    target's integrity level with ours and refuse plainly. Do not ship
    `uiAccess` in v1: it needs a signed install under Program Files and
    widens the attack surface.
  - **Lock screen and secure desktop.** The helper cannot see or drive the
    lock screen, UAC prompts or Ctrl+Alt+Del. Detect them through
    `OpenInputDesktop` and session lock notifications, and stop.
  - **Default blocked apps.** `cmd`, PowerShell, Windows Terminal,
    `regedit`, `mmc`, Task Manager, Settings, Windows Security, and the
    common password managers.
- **Runs** in the person's session, started at sign-in from the `HKCU` Run
  key. Never as a service: session 0 has no desktop.

**Distribution and trust (the biggest non-code risk).**
- **Defender.** An unsigned program that hooks the keyboard and calls
  `SendInput` looks like a keylogger to Defender. Mitigations:
  - Sign every build, with Azure Artifact Signing if the publisher is
    eligible (individuals: USA and Canada only), otherwise an OV
    certificate.
  - Keep the publisher identity and file name stable between releases.
  - Install the hooks only during a batch.
  - Use no packers.
  - Submit each release to Microsoft's false-positive portal.
- **SmartScreen.** Its reputation builds per signer over time. An EV
  certificate no longer skips that, so early users will see "More info,
  Run anyway".
- **Install.** A signed per-user installer, listed in winget. MSIX later,
  if the Store is worth it.

**Prior art.**
- Microsoft's UFO2 combines UIA with vision (OmniParser) for custom-drawn
  UI. Our screenshot plus coordinate clicks plays that fallback role.
- In Windows Agent Arena, the best agent scored 19.5% against 74.5% for
  people. Grounding is the failure mode, so observations should be built
  for the model.
- Windows-Use is UIA-only, with a shell tool we deliberately leave out.
- ChatGPT and Codex computer use on Windows fail silently against elevated
  windows, which is why the helper checks integrity levels.
- Microsoft's own "agent workspaces" (a separate desktop for agents)
  should be watched as a future safer surface **[status unverified]**.

**Effort:** about 3–4 weeks to reach parity with the Mac prototype (Rust adds
roughly half again), plus 1–2 weeks for signing, installer, and a test matrix
(DPI mixes, Chromium/Electron/Store apps, elevated windows, Remote Desktop,
non-US layouts).

## 3. Linux helper on the person's desktop

**The landscape.**
- GNOME 50 removed the X11 session; X11 apps run under XWayland.
- Ubuntu 26.04 LTS and Fedora 44 ship that GNOME.
- KDE Plasma 6.8 drops its X11 session; 6.7 is the last with one
  **[6.8's release unverified]**.
- X11 lives on in XFCE, i3, MATE, Cinnamon and older LTS installs.

**What Wayland withholds, and the workaround for each.**

| Need | X11 | GNOME / KDE on Wayland | wlroots (Sway, Hyprland) |
|---|---|---|---|
| Element tree | AT-SPI, screen coordinates | AT-SPI, **window-relative only**; add the window's origin from the compositor | AT-SPI, window-relative |
| Window origin, front app | `_NET_ACTIVE_WINDOW` | GNOME: a small bundled Shell extension over D-Bus; KDE: a KWin script | `wlr-foreign-toplevel`, `swaymsg`/`hyprctl` |
| Screenshot | `XGetImage` | Screenshot portal, or a ScreenCast portal frame with a restore token (one dialog, then remembered) | portal or `grim` |
| Input | XTest | RemoteDesktop portal with libei (one dialog, then a restore token) | `wlr-virtual-pointer`, `virtual-keyboard` |
| Unicode typing | XTest keysyms | keysyms through the portal; clipboard fallback | `wtype`-style |
| Takeover stop | XInput2 device ids (XTest events have their own device) | **gap** without access to the `input` group | **gap** |
| Password field | AT-SPI `ROLE_PASSWORD_TEXT` | same | same |

Where the window origin is unknown, the helper reports
`coordinates: "refs_only"` and refuses x,y clicks. Ref clicks then go
through AT-SPI's `DoAction`, which needs no coordinates. Where takeover
cannot be detected, the capability says `none`, and the person relies on
Stop, Pause and a global shortcut.

**Stack.** Rust:
- `zbus` and the `atspi` crate for the accessibility tree;
- `ashpd` for the portals;
- `reis` for libei;
- `x11rb` for X11;
- `ksni` for the tray icon.

**Packaging.** `.deb` and `.rpm` plus an AppImage, with a `systemd --user`
unit. Flatpak fights the accessibility bus, so it is not the first choice.
GNOME needs the AppIndicator extension for a tray icon; a small window with
Stop and Pause covers its absence. Prior art: agent-sh's
`computer-use-linux` takes the same portal + AT-SPI approach in Rust, and
each project like it rebuilds the compositor-specific layer.

**Effort:**
- X11: 1–2 weeks once the sandbox's X11 backend exists.
- GNOME and KDE on Wayland: 4–8 weeks, mostly coordinate mapping, the GNOME
  extension and per-desktop testing.
- wlroots: 2–3 weeks more.

## Plan and order

| Step | What | Done when | Estimate |
|---|---|---|---|
| 0 | Protocol additions (platform, capabilities, `computer` parameter, neutral roles); macOS helper reports them | Tests; the Mac helper sends capabilities | 2–3 days |
| 1 | Rust workspace `computer-helper-rs/`: core crate (protocol, transport, config, policy, frames, JPEG + badges), golden tests shared with the Swift helper's JSON fixtures | `cargo test` in CI | 1 week |
| 2 | Sandbox: X11 backend, container image, on-demand start beside the workstation, server-minted token, noVNC view (view-only, Take control, Stop) | "Open example.com in your own browser and summarise it" works from a phone | 1–2 weeks |
| 3 | Windows spike (1–2 days): a throwaway exe that times a cached UIA walk, `BitBlt`s at 150% scaling, sends a click and Unicode text, prints injected versus physical flags from the hooks, and reads `IsPassword` on a Chrome password field; run against Chrome, Edge, Notepad, Settings, VS Code and an elevated PowerShell | Each unknown answered | 2 days |
| 4 | Windows helper, signing pipeline, winget | Mac-parity demo on a clean Windows 11 VM with Defender on | 4–6 weeks |
| 5 | Linux X11 helper (reuses step 2's backend) + packaging | Works on XFCE | 1–2 weeks |
| 6 | Linux Wayland spike: window origin accuracy on GNOME (extension) and KDE (KWin script); portal restore tokens across reboot and lock; libei typing | Support matrix confirmed | 1 week |
| 7 | Linux GNOME and KDE Wayland helper; wlroots afterwards if asked for | Demo on Ubuntu 26.04 and Plasma | 4–8 weeks |

Steps 2 and 3 can run in parallel. Each step ends the way the Mac prototype
did: route and bridge tests on the server, unit tests for the pure parts, a
run against a mock server, then a real run.

## Risks

- **Antivirus and SmartScreen on Windows** (high likelihood): sign, keep a
  stable identity, hook only during batches, submit releases.
- **Wayland coordinates and takeover**: may never reach macOS parity
  without compositor cooperation; the capability field keeps the model and
  the person honest about it.
- **Thin accessibility trees** in custom-drawn or older Electron apps on
  every platform: the screenshot and coordinate clicks remain the fallback.
- **Password detection is best effort** off macOS: conservative blocklists,
  and a stop-and-ask rule for anything that looks like a credential.
- **Sandbox cost and abuse** on node-a: on-demand start, idle stop, network
  allowlist, per-user limits.
- **The less-aligned model with rich access** (raised earlier): the sandbox
  is the safe place to run the evals before a model is allowed near a real
  desktop.

## Sources

Windows:
[GraphicsCaptureSession.IsBorderRequired](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired),
[GraphicsCaptureAccess](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscaptureaccess),
[Native UIA in Chromium](https://developer.chrome.com/blog/windows-uia-support-update),
[Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options),
[SmartScreen reputation](https://learn.microsoft.com/et-ee/windows/apps/package-and-deploy/smartscreen-reputation),
[Authenticode in 2024](https://textslashplain.com/2024/05/22/authenticode-in-2024/),
[UIAccess security](https://learn.microsoft.com/en-gb/windows/win32/winauto/uiauto-securityoverview),
[UFO2](https://arxiv.org/html/2504.14603v2),
[Windows Agent Arena](https://proceedings.mlr.press/v267/bonatti25a.html),
[Windows-Use](https://github.com/CursorTouch/Windows-Use),
[UIPI and computer-use agents](https://codenote.net/en/posts/windows-admin-elevation-blocks-chatgpt-computer-use-uipi/),
[Windows 11 agent workspaces](https://petri.com/windows-11-agentic-computing-workspaces/).

Linux and sandbox:
[GNOME 50 drops X11](https://www.theregister.com/2026/03/19/gnome_50/),
[Fedora Wayland-only GNOME](https://fedoraproject.org/wiki/Changes/WaylandOnlyGNOME),
[Plasma 6.8 Wayland-exclusive](https://www.phoronix.com/news/KDE-Plasma-68-Wayland-Exclusive),
[AT-SPI docs](https://docs.gtk.org/atspi2/),
[GNOME on Wayland coordinates](https://lists.gnome.org/archives/commits-list/2022-May/msg07995.html),
[KDE window-handle MR](https://invent.kde.org/plasma/plasma-integration/-/merge_requests/145),
[GNOME accessibility (Newton)](https://blogs.gnome.org/a11y/),
[xdg-desktop-portal-wlr FAQ](https://github.com/emersion/xdg-desktop-portal-wlr/wiki/FAQ),
[computer-use-linux](https://glama.ai/mcp/servers/agent-sh/computer-use-linux),
[Anthropic computer-use demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo),
[Bytebot architecture](https://docs.bytebot.ai/core-concepts/architecture),
[E2B desktop](https://e2b.dev/docs/template/examples/desktop),
[ScreenEnv](https://huggingface.co/blog/screenenv).
