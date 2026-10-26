# Computer use: research and a first design

October 25, 2026. Five research passes, each at least three rounds deep. Their
notes, with every source linked and dated, are in
[`computer-use-2026-10-25/`](computer-use-2026-10-25/):

| Notes | Covers |
|---|---|
| [`macos.md`](computer-use-2026-10-25/macos.md) | How open projects drive a Mac; grounding models; safety patterns |
| [`open-models.md`](computer-use-2026-10-25/open-models.md) | Open models and harnesses; Windows and Linux control layers |
| [`system1.md`](computer-use-2026-10-25/system1.md) | Jev, the System 1 (decision model) category, and its open clones |
| [`openclaw-vm.md`](computer-use-2026-10-25/openclaw-vm.md) | OpenClaw; a Linux VM inside the desktop app that acts on the host |
| [`networking.md`](computer-use-2026-10-25/networking.md) | Raw WireGuard, embedding it in our apps, and the transport |

The notes mark each claim as verified (the source was read) or reported
(secondhand). Read every benchmark figure below as the vendor's own claim, run
in the vendor's own harness. The tables do not compare across harnesses, and
different sources disagree.

## What we're building

You talk to the agent on your phone. The agent runs on our server, and it
operates a computer you have connected: a Mac first, then Windows and Linux.
That computer runs our desktop app. To websites and apps, the agent's work
should look like a normal person on a home connection: your browser, your
cookies, your IP address. It should not look like a bot in a data center.

## What the research found

**Open models have nearly caught up on short tasks, not on long ones.** On
OSWorld-Verified, where a task takes a person about two minutes, these models
score within a few points of the best proprietary ones (about 83–85):

- Qwen3.8-27B (Apache-2.0, fits one GPU): 84.3
- Holo4-35B-A3B (Apache-2.0, 3B active parameters, the fast one): 80.8
- Kimi K3 (custom license, about 8 data-center GPUs): 84.8

Holo4-27B scores 85.2 but is licensed for non-commercial use only. On the
long tasks in OSWorld 2.0, every agent does badly. On strict pass/fail scoring
the best closed result is about 21%, and Agent S4 with Qwen3.8-27B reaches
21.3%. The real gap is keeping track of a long task and checking its own work,
not clicking the right spot.

The three models you named are not computer-use leaders:

- **DeepSeek V4.1 Flash** sees images but makes no GUI claims.
- **GLM 5.3 Flash** claims computer use but publishes no scores.
- **Kimi K3** is strong but far too large for us to host cheaply.

No benchmark covers Mac apps in 2026 (macOSWorld has had no update), so we
will need our own Mac task suite.

**How Macs get driven.** The approach everyone converged on in 2026 is the
accessibility tree plus a screenshot with numbered marks on elements. Clicking
at pixel coordinates is the fallback. The parts:

- **Cua Driver** (trycua, largely MIT, released in April). The most complete
  control layer. It acts in the background without moving the cursor, using
  Apple's private SkyLight framework. That can break with any macOS update and
  probably rules out the Mac App Store. Parts of Cua are under FSL or AGPL.
- **Peekaboo** (MIT). The other mature driver, and OpenClaw's default.
- **Apple.** macOS 26/27 has no computer-use API and no built-in MCP. App
  Intents covers only the apps that adopt it.
- **Permissions.** Every project needs Accessibility and Screen Recording.
  These grants attach to the signed app's identity, so one stable, signed
  helper has to own them, with a screen that shows their status.

**OpenClaw already has our product's shape, and it shows what to avoid.**
OpenClaw (formerly Clawdbot/Moltbot, MIT, about 393k stars) runs a server-side
Gateway with paired "nodes": Mac, phone, Windows, Linux. Each node connects
outbound over WebSocket and declares the commands it accepts, such as
`computer.act`, `screen.snapshot` and `system.run`. Pairing combines a key
pair with a single-use, 10-minute link, and then the owner separately approves
the declared commands. Its Mac app owns the permission grants and drives the
Mac through Peekaboo or Cua. Mac support is its strongest; Windows has a
companion app, and Linux support is experimental.

Copy:

- the node model;
- the pairing;
- declared commands;
- screenshots tagged with a frame ID, so an action refers to the screen it
  was decided on.

Avoid:

- **Token theft by link.** CVE-2026-25253 (CVSS 8.8) let a crafted link steal
  a gateway's token and run code, with 20–40k gateways exposed.
- **Malicious community skills.** Hundreds turned up in its marketplace.
- **No approval per action.** Once computer use is enabled, nothing asks
  before an action runs.

**System 1 / decision models are real and early.** Jev, from TypeSafe
(September 2026), answers with a typed choice and a confidence instead of
text. It is fast (about 0.1–0.5 s) and cheap. Its multimodal version,
`jev-1.14.0` (October), is a preview: images go in behind a "danger zone"
header, and TypeSafe itself says Jev handles images worse than text. Its
weights are not published.

Open multimodal clones exist but are weeks old:

- **OneJev:** 0.8B–27B, Apache-2.0.
- **Liquid d1-3B:** about 30 ms on an M5 Pro; license unstated.
- **Intern-Decision.**
- **GUI-Decisions-31B:** too big for a Mac.

**How decision models fit computer use.** The working pattern is
`typesafe-computer-use`:

1. Code reads the accessibility tree and OCR.
2. It lists the possible actions as typed options.
3. The decision model picks one.
4. Code performs it.
5. A larger model writes only free text.

That project reports about 1.5 s against 5.5 s per step. Independent results
suggest 1.5–6 times faster and cheaper on routine steps, not the 75–200 times
in the marketing. Decision models don't fix perception, a bad list of options,
or long-horizon planning.

**A Linux VM inside the desktop app has a precedent.** Claude Cowork runs its
tools in a Linux VM on Apple's Virtualization framework, and controls the host
by a separate path. The pieces:

- **Mac:** Apple's `containerization` (macOS 26, Apple silicon) talks to its
  VM over vsock. Lima is an Apache-licensed alternative.
- **Windows:** Hyper-V sockets do the same job, but registering the service
  needs admin rights once.
- **Mac App Store:** probably can't do vsock, so plan on Developer ID
  distribution.
- **The browser:** Chrome 136+ no longer allows a debugging port on the
  default profile. The agent can reach your real browser profile through an
  extension, or through Chrome's own consent prompt.

**Networking: a hub at our server is enough.** Every computer dials out to the
server, so there is no NAT to get through. The agent is on the server, so all
the traffic is between the server and the computer. The phone needs no tunnel:
it talks to our API as it does now. A mesh would matter only for the phone
watching a live screen, and WebRTC with a relay on our server covers that.

You can embed raw WireGuard with no system VPN: wireguard-go's userspace
network stack (`tun/netstack`) makes no network interface and needs no root,
no entitlement and no approval in System Settings. The tunnel is usable only
inside our own app, which is all we need. On the server, peers live in
Postgres, and a loop keeps the kernel WireGuard interface in step with the
database through wgctrl-go. Headscale, NetBird and the rest solve coordination
we already have through our own authenticated API.

## The design

```text
 phone app ──HTTPS──▶ server: Mike API + agent (Pi Durable)
                        │  planner model (System 2)
                        │  grounding model
                        │  device registry, approvals, audit log
                        │
                        │  outbound from the device: TLS WebSocket (v1),
                        │  WireGuard userspace tunnel (later)
                        ▼
 desktop app (signed, Developer ID; owns Accessibility + Screen Recording)
   ├─ host helper: perceive (AX tree, screenshot, OCR) and act (AX actions, input events)
   ├─ policy engine: app/site allowlists, approval on the phone for risky
   │   actions, kill switch, hides its own windows from screenshots
   ├─ optional local chooser (System 1) with escalation to the planner
   └─ Linux VM (Apple containerization / Virtualization.framework)
        shell and file tools; reaches the host only through one vsock
        endpoint with typed calls (snapshot, act, browser, pick file)
```

The decisions it rests on:

1. **The device enforces policy and does not trust the server.** A
   compromised server or a prompt injection on screen must not be able to
   approve itself. Risky actions need a fresh approval from the phone, and the
   approval names the screen it was decided on. A kill switch on the Mac
   always works.
2. **Accessibility first, pixels second.** The host helper sends the
   accessibility tree, a downscaled screenshot with marks, and a frame ID.
   Actions refer to elements, or to coordinates within that frame. A stale
   frame is refused.
3. **One "choose" interface, with several backends behind it.** The planner
   produces the options and a chooser picks. To start, the chooser is the
   planner itself. Every (screen state, options, choice, outcome) is logged,
   so Jev, OneJev or Liquid d1 can be tested in shadow mode on our own traces
   before they make any decisions. The chooser runs on the Mac when a local
   model is good enough, which also keeps screen text away from third parties.
4. **Act on the host, isolate the tools.** Anything that should look like you
   (browsing, apps, your accounts) happens on the host through the helper. The
   agent's own shell and file work runs in the VM: no network beyond a proxy,
   and only folders you chose are mounted.
5. **Connectors before the browser, the browser before the screen.** Use an
   API when one exists, the browser extension for web work, and screen control
   only for what's left. Each step down is slower and easier to break.
6. **Transport: WebSocket first, WireGuard second.** An outbound TLS WebSocket
   to our API works on networks that block UDP and reuses our sign-in. The
   embedded WireGuard tunnel comes next. It's worth building when we want the
   server-side agent's own traffic to leave through your machine, from your
   home address. That is the part that needs a real tunnel and not an RPC
   channel.

Starting models: Qwen3.8-27B (Apache-2.0) self-hosted as the planner, with
Kimi K3 as an optional hosted planner. Holo4-35B-A3B or UI-Venus-1.5 as the
grounder. Check each license on its model card before shipping.

## Order of work

1. **A Mac evaluation suite and trace logging.** Twenty or so real tasks, run
   against your own apps.
2. **The Mac node:**
   - pairing (OpenClaw-style: key pair, single-use link, approval of declared
     commands);
   - the WebSocket channel;
   - snapshot and act;
   - a permission status screen;
   - approvals on the phone;
   - a kill switch.
3. **Driver choice.** Prototype on Peekaboo and on Cua Driver, and keep one.
   Weigh Cua's private APIs and license split against its background input.
4. **Grounding and choosing.** Self-host the grounder. Shadow-test decision
   models on the traces.
5. **The Linux VM inside the app,** with the vsock broker.
6. **The embedded WireGuard tunnel,** and the server's traffic leaving through
   your machine.
7. **Windows** (UI Automation, Windows-MCP-style element IDs), then **Linux**
   (AT-SPI; on Wayland, the RemoteDesktop portal and libei).

## Open questions

- Is the Mac App Store needed at all? Its sandbox likely rules out vsock,
  Cua's private APIs and some input paths. Developer ID distribution avoids
  all three.
- Which planner do we host, and on what? Qwen3.8-27B fits one GPU, and the
  OVH nodes have none today.
- How far does "look like a normal person" go? Using your own browser, cookies
  and address is just operating your machine for you. We shouldn't build
  anything that evades a site's bot defences beyond that.
- Should the phone show a live view of the screen? That's the only feature
  that needs WebRTC.
