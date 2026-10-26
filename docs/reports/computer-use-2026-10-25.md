# Computer use: research and a first design

October 25, 2026. Seven research passes, each at least three rounds deep. Their
notes, with every source linked and dated, are in
[`computer-use-2026-10-25/`](computer-use-2026-10-25/):

| Notes | Covers |
|---|---|
| [`macos.md`](computer-use-2026-10-25/macos.md) | How open projects drive a Mac; grounding models; safety patterns |
| [`open-models.md`](computer-use-2026-10-25/open-models.md) | Open models and harnesses; Windows and Linux control layers |
| [`system1.md`](computer-use-2026-10-25/system1.md) | Jev, the System 1 (decision model) category, and its open clones |
| [`openclaw-vm.md`](computer-use-2026-10-25/openclaw-vm.md) | OpenClaw; a Linux VM inside the desktop app that acts on the host |
| [`networking.md`](computer-use-2026-10-25/networking.md) | Raw WireGuard, embedding it in our apps, and the transport |
| [`named-models.md`](computer-use-2026-10-25/named-models.md) | Kimi, DeepSeek and GLM in real computer use; where each model can run, and how fast |
| [`human-input.md`](computer-use-2026-10-25/human-input.md) | Moving the mouse and typing at a human pace, with human variation |

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

**People do use Kimi, DeepSeek and GLM for computer use, in different
ways:**

- **Kimi** has the only documented, runnable setup of the three.
  - **Harness:** the official OSWorld repository has gained a Kimi agent
    "built for Kimi k3" (August 21). It works from screenshots only, writing
    one pyautogui action per turn with a 100-step budget, and is probably how
    K3 scored 84.8.
  - **Independent tests:** they score Kimi below Claude. K2.6 reached 30.1
    against Opus 4.7's 42.8 on SaaS-Bench, using about 50% more steps.
    It was also the best at click accuracy in NVIDIA's Desktop-Delta Bench.
  - **Other work built on it:** Microsoft's OpenForge-RL reuses the harness.
  - **Kimi's own product:** Kimi Work drives a real Chrome or Edge.
  - **Known problems in third-party harnesses:** opencode rejects K3's tool
    schemas, and K3 needs its reasoning echoed back on each turn.
- **DeepSeek V4.1 Flash** accepts images, but publishes no GUI scores. Its
  real use is text-only: rtrvr.ai gives V4 Flash a compressed page DOM, and
  the model writes a single JavaScript plan. Nobody has published a DeepSeek
  planner paired with a separate grounding model.
- **GLM 5.3 Flash** documents a "computer use" example. Z.ai's ZCode browser
  hands screenshots to Flash, because GLM 5.3 itself reads text only. No
  success rates are published. The older AutoGLM-OS agent, which reads the
  accessibility tree, is in the OSWorld repository.

No test has run all three on the same GUI benchmark, and no one has
independently reproduced any headline OSWorld number. No benchmark covers Mac
apps in 2026 either (macOSWorld has had no update). Our own Mac task suite is
the only comparison we'll be able to trust.

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

**The model can run in the cloud, at home, or both.** Nothing requires
computer use to run on the computer being controlled.

- **Encrypted cloud (Phala, which our backend already uses with attestation),
  per million input/output tokens:**
  - Kimi K3: $3.00 / $15.00
  - GLM 5.3 Flash: $0.15 / $0.50
  - DeepSeek V4.1 Flash: $0.75 / $1.60
  - Qwen3.8-27B: $0.20 / $2.50

  All four have a 1M-token context. OpenRouter says all four accept images.
  Phala's pages don't say, so the first test is one real screenshot through
  the attested gateway. Holo4 is served only by H Company's own API.
- **A box at home, measured by the community:**
  - **Qwen3.8-27B on one RTX 5090:** about 90–100 tokens/s, and an image
    turn under 2 s.
  - **GLM 5.3 Flash on two linked DGX Sparks:** 26 tokens/s, with 2.5–4.4 s
    to read each screenshot.
  - **DeepSeek V4.1 Flash on two Sparks:** fits only at a heavy 2.9-bit
    quantization (73 tokens/s); image input there is unverified.
  - **Qwen3.8-27B on a Mac Studio:** 31 tokens/s on an M3 Ultra, 48 on an
    M5 Ultra.
  - **Kimi K3:** about 1.5 TB of weights, so it fits on none of these.
  - **Holo4:** no local numbers published.
- **Time per step (screenshot, think, act), estimated:** about 4–12 s for
  the Flash models hosted, 5–9 s for Qwen3.8-27B on a 5090, and 10–30 s for
  K3. A 30-step task takes from about 1.5 to 15 minutes.

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
or long-horizon planning. We already run decision models in the Auto Mode
gate ([`docs/decision-models.md`](../decision-models.md)), so the client,
calibration and evaluation code exist.

**Human-paced input is a solved problem in one place: Peekaboo.** Peekaboo
(MIT, Swift, v4.9.7, October 23) has an opt-in human profile:

- **Mouse:** a curved path with minimum-jerk timing (smooth acceleration and
  deceleration), a 20% overshoot only on moves over 120 px, and jitter under
  half a pixel. The random generator is seeded, so a run can be replayed in a
  test, and the last event always lands exactly on the target.
- **Typing:** delays drawn from a lognormal distribution, longer after spaces
  and punctuation, and a pause every dozen words.

None of the other agents we checked does this. Those are the Anthropic
reference demo, UI-TARS desktop and Agent S3, plus Cua Driver from secondhand
sources. They move the cursor instantly or in a straight line, and type at a
fixed rate (12 ms per key in Anthropic's demo).

The numbers to model come from the Aalto study of 136 million keystrokes:

- 52 words a minute on average;
- 238 ms between keypresses on average, with a long tail;
- keys held down for about 116 ms, about the same for slow and fast typists,
  so speed comes from the gaps;
- 6% of keystrokes are corrections;
- keys often overlap.

For the mouse, Fitts's law gives the time a move should take, from its
distance and the target's size.

Every platform marks injected input:

- **macOS:** a source state, a process ID, and a free 64-bit user-data field
  on each event.
- **Windows:** an "injected" flag.
- **Linux:** libei.

On a Mac, each move also needs its relative motion fields set, or apps that
read motion will see none. Learned motion generators exist, such as DMTG and
MIME-mouse, but they're built to beat bot detectors and miss on outside data.
A parametric model is simpler and easier to test.

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

7. **Input at a human pace, honestly labelled.** The host helper plans each
   mouse move and keystroke run as timestamped events from a seeded model:
   - moves follow Fitts's law and a curved, minimum-jerk path, with one event
     per display frame;
   - keystroke timing is lognormal at a chosen speed, with longer gaps at word
     boundaries and keys held about 110 ms;
   - typos are opt-in, and never in passwords, code or URLs.

   There are three speeds: instant, light and full, chosen by whether you or
   an app could be watching, plus a speed multiplier. Touching the mouse or
   keyboard cancels the agent at once. Peekaboo's profile is the starting
   point. Each event carries an agent marker in its user-data field, so the
   machine's own software can tell agent input from yours.
8. **The model's location is a setting.** Every model goes through the
   existing model layer (`backend/src/lib/llm/`), so the same agent can use:
   - Phala's attested cloud (the default for privacy);
   - a box at home over the tunnel, such as a 5090, two Sparks or a Mac
     Studio;
   - an ordinary host.

Models to try first, all of them through the same evaluation suite:

- **Planner and actor:** Qwen3.8-27B (Apache-2.0). It's on Phala, and it
  runs on a single 5090 at home.
- **Cheaper planner:** GLM 5.3 Flash, the cheapest on Phala and runnable on
  two Sparks.
- **Strongest open planner:** Kimi K3 on Phala, run with its OSWorld harness
  as the reference.
- **DeepSeek V4.1 Flash:** a text-only planner over the accessibility tree.
- **Grounder:** Holo4-35B-A3B (Apache-2.0) or UI-Venus-1.5, for when the
  accessibility tree isn't enough.

Check each license on its model card before shipping.

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
   Weigh Cua's private APIs and license split against its background input,
   and Peekaboo's human input profile against the work of building our own.
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
- Cloud, home, or both? Phala covers the cloud today, with no hardware to
  buy. A box at home (a 5090 for Qwen3.8-27B, or two Sparks for GLM 5.3 Flash)
  keeps screens off any third party, at about the same speed per step.
- How far does "look like a normal person" go? Using your own browser, cookies
  and address is just operating your machine for you. We shouldn't build
  anything that evades a site's bot defences beyond that.
- Should the phone show a live view of the screen? That's the only feature
  that needs WebRTC.
