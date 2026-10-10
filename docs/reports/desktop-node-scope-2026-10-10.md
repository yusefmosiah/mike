# Desktop app scope: browser and computer use from the user's machine

Date: 2026-10-10. Status: scoping only; nothing here is built or decided.

Owner direction: getting Mike running on a Mac is fine but not the point.
The interesting uses are browsing from the user's residential IP, full
computer use, passing the browser or screen to the phone, and a shared
drive onto the workstation VM. Windows and Linux are scoped, not
deliverables. The research behind this report used four parallel
literature searches (provider patterns, small-model computer use, desktop
architecture, file sync) plus OpenClaw's documentation. Benchmark numbers
below are vendor-reported unless marked otherwise, and several sources
disagree on benchmark versions (OSWorld-Verified, OSWorld 2.0, 2.1); treat
them as directional.

## The short answer

1. **The Mac is a node, not a server.** The desktop app dials out to
   Mike's server and executes typed capabilities the harness asks for
   (open a page, read its accessibility tree, click, capture the screen,
   sync a folder). It holds a device key and the user's own logins; it
   never holds model keys, policy or firm records. This is the rule we
   already have ("the harness stays outside the VM") generalised: the
   harness stays outside *every* effector, whether a microVM, a Mac or a
   phone. OpenClaw's gateway-and-nodes design is exactly this shape, and
   so are Claude's Dispatch and ChatGPT Work's host-connected mobile tasks.
2. **Browser first, computer use second.** A browser on the user's machine
   gives the residential IP and the user's logins with little native code
   and no macOS screen-recording prompts. Full computer use needs a signed
   native helper (Accessibility, Screen Recording) and carries the largest
   prompt-injection exposure of anything we could ship.
3. **Two channels on one session.** The model sees screenshots and
   accessibility trees over the node protocol. The human sees a live
   video view, relayed through our server, and can take over. Taking over
   pauses the agent and invalidates its references. Windows 365 for Agents
   ships this split (an agent channel and a human channel on one session),
   as does OpenClaw (`take_control`).
4. **A Linux VM on the Mac cannot do macOS computer use.** It has no macOS
   window server or accessibility tree. macOS computer use is either the
   real session (consented, per-app approved), or a macOS VM (sandboxed,
   but not the user's Mac, and capped at two by Apple's licence). A local
   Linux VM is still useful, for offline work, but it reaches the Mac's
   capabilities only through the harness, never directly.
5. **The shared drive needs a sync mechanism.** Start with a synced folder
   (Mutagen over a harness-authenticated tunnel, split into Inbox, Outputs
   and Work so conflicts are rare). A Finder-integrated drive (File
   Provider) comes later, once there is a proper sync API.
6. **Computer use scales down further than it did a year ago.** Open 27B
   vision models are reported near 80% on OSWorld-Verified, and small
   grounders fit on a 12 GB GPU. What makes weak models work is structure:
   accessibility-tree observations, a planner with a small grounder,
   recording a run once and replaying it as code, and calling APIs before
   GUIs. Long multi-app tasks and open-web exploration still need a
   frontier model.

## 1. What others ship (late 2026)

Three deployment shapes, and every major vendor now ships at least two:

| Shape | Examples | Gains | Costs |
|---|---|---|---|
| Cloud browser or VM with a live view | ChatGPT Work cloud mode, Windows 365 for Agents, Browserbase, Kernel, Manus cloud | Isolation, parallel runs, nothing on the user's machine | Datacenter IPs and bot walls (Amazon rejected OpenAI's cloud browser as an unsupported client); no user logins |
| Agent drives the user's own browser (extension or CDP) | Claude in Chrome, OpenAI `@Chrome`, Manus Browser Operator, Playwright MCP `--extension`, Comet | Real IP, cookies and fingerprint; no CAPTCHA fights | Largest injection blast radius; the browser must be open |
| Desktop node on the user's machine | Claude desktop and Claude Code computer use, Codex and ChatGPT Work computer use, OpenClaw nodes, Cua Driver | Native apps | Machine awake and unlocked; private-API fragility for background control |

Mike already has the cloud shape: the workstation microVM. The desktop app
adds the other two.

Conventions worth copying:

- **Accessibility tree first, screenshots as fallback.** Anthropic's
  browser toolset reads an accessibility tree with tab-scoped `ref_N`
  handles (capped at 50,000 characters, often cheaper than a screenshot)
  and uses coordinates only for canvas, video, remote desktops and
  cross-origin iframes. Codex on macOS reads the accessibility tree.
- **Cost-ordered routing.** Anthropic and OpenAI both prefer a connector or
  API, then a browser, then full computer use.
- **Per-app tiers on the desktop.** Claude's desktop app makes browsers and
  trading apps view-only, terminals and IDEs click-only, everything else
  full control; hides other windows while it works; excludes its own
  terminal from screenshots; consumes Esc as a stop key so injected
  content cannot use it.
- **Fresh-frame coordinates.** OpenClaw's `screen.snapshot` returns a frame
  id that every coordinate action must echo; a stale frame or a changed
  display fails closed.
- **A critic that never sees page content.** Chrome's agent runs a
  separate model that sees only metadata about each proposed action and
  can veto it; repeated vetoes return control to the user.
- **Credentials never enter model context.** 1Password and Chrome Password
  Manager sign-in flows where the model never sees the secret.
- **Handoff as a tool.** Gemini's `yield_to_user` and `safety_decision` /
  `safety_acknowledgement` are a clean API shape for confirmations.

The injection record is honest and sobering: Anthropic reports about 1%
attack success against its own adaptive attacker and calls that
"meaningful risk"; Brave defeated Perplexity Comet's early fixes; every
vendor says the problem is unsolved. Design for limiting what a successful
injection can do (domains, apps, spending, out-of-band approval on the
phone), not for detecting every one.

**Jev.** TypeSafe AI's Jev is a decision model, not a language or vision
model: one parallel pass returns typed choices with calibrated
probabilities, in 70 to 500 ms. Mike already used `jev-1.13` as a
candidate consent gate (Mission 4). In browser use it appears as the fast
*action chooser* in text-only loops: `browser-use/jev-ultrafast` turns
each page into a numbered table of controls, Jev picks the operation and
target, and a small text model writes only the text to type; no
screenshots. Its published evidence is three repeats of one task (median
9.45 s down to 7.09 s), so it is a promising router to evaluate, not a
proven executor. It cannot see the screen.

## 2. Architecture for Mike

```text
phone / web app ──► Mike server: harness (Pi Durable, tools, policy, audit)
                       │                 │
                       │ ssh over vsock  │ outbound WSS from the device (one multiplexed channel)
                       ▼                 ▼
               workstation microVM    desktop node (Mac app; Windows, Linux later)
               (cloud browser,        ├─ agent browser: dedicated Chrome profile over CDP
                code, files)          ├─ native helper (Swift): ScreenCaptureKit, AX, input
                                      ├─ sync client (Mutagen, later File Provider)
                                      └─ live view publisher ──► SFU on our server ──► phone
```

### 2.1 The node protocol (design once, used by every phase)

- **Dial-out only.** The device opens an authenticated, multiplexed WSS
  channel to the server (QUIC later if needed). No inbound ports, no NAT
  traversal for control. OpenClaw's Mac app does the same (SSH tunnel or
  wss with pinning).
- **Pairing.** A short-lived single-use code shown in the web app, a
  device keypair in the Keychain or Secure Enclave, approval by the signed-in
  user. Asking for broader capabilities later creates a new pending request;
  an approval is never silently widened (OpenClaw's rule).
- **Typed capabilities, not a shell.** `browser.navigate`, `browser.read`,
  `browser.act`, `screen.capture(app)`, `input.act(app)`,
  `egress.open(domain)`, `files.sync(folder)`. Each is a separate grant,
  scoped by app, domain or folder, optionally time-boxed ("this session"),
  revocable from the tray or the phone.
- **The harness is the only policy point.** The node is a dumb effector:
  it executes and reports, and makes no authorisation decisions. Policy,
  approvals and audit live where they live today, in the tool dispatcher.
- **Approvals out of band.** Spending, sending, deleting, credentials and
  any newly seen app need a confirmation on a channel the page cannot
  influence (the phone, or the desktop tray). The approved plan is hashed
  and bound to the request.
- **Audit and kill switch.** Every command and result on the server's
  append-only log; screenshots not kept by default. Stop from the tray,
  from the phone, or by revoking the device on the server; a heartbeat
  makes the device stop acting when it loses the server.
- **Screen content is untrusted data.** Document text, page text and
  screenshots already go through the injection flags (`run_python` is an
  external-content tool); the same applies to node results. Nothing a page
  says can add a grant.

In Mike's code this is a new module (`backend/src/modules/nodes/`) with a
node registry, the WSS endpoint and a dispatcher branch beside the
workstation one; the frontend gets pairing, grants and the live view.

### 2.2 Browsing from the user's machine (residential IP)

Recommended: **the agent's browser runs on the device.** The app launches a
dedicated Chrome profile (or bundled Chromium) and drives it over CDP:
accessibility snapshot with refs, actions, screenshots on request. Traffic
leaves from the user's IP naturally, policy sits at the command layer, and
the same code runs on Mac, Windows and Linux.

- **Logins.** The user signs into the agent profile once for the sites they
  want the agent to use. Attaching to the user's everyday Chrome is
  deliberately awkward since Chrome 136 (the remote-debugging port is
  ignored on the default profile) and since Chrome 144 needs a permission
  dialog per connection; an extension (Claude in Chrome's model) is the
  other route and can come later.
- **No LAN.** The node resolves DNS itself and refuses private, link-local,
  loopback, `.local` and metadata addresses after resolution, pinning the
  resolved IP (the rules in `backend/src/lib/egress.ts`, applied on the
  device). Default ports 80 and 443. Firm admins can set allow and block
  lists; financial and adult categories blocked by default, as Claude in
  Chrome does.
- **Alternative: device as an exit for the VM's browser.** A reverse SOCKS
  stream over the same channel lets the workstation's browser exit through
  the device. It is a few hundred lines but turns the device into a generic
  exit node, needs the same device-side destination checks, and still has
  no user logins. Keep it as an option, not the default; Tailscale exit
  nodes are a poor fit (no per-destination filtering).
- **Legal.** This is the user's agent on the user's IP for the user's
  tasks, not a pooled residential proxy, but consent must be explicit and
  egress must never be pooled or resold. Agents acting in users' accounts
  are in active litigation (*Amazon v. Perplexity* over Comet: a March 2026
  injunction under the CFAA, later vacated on appeal; the dispute is
  undecided). Counsel should review before release, and we should decide
  deliberately whether the agent identifies itself (Web Bot Auth signing)
  or looks like the user's browser. OpenAI's agent is told not to rotate
  fingerprints or evade safeguards and to attempt a CAPTCHA only with
  permission; we should adopt the same posture.

### 2.3 Watching and taking over from the phone

- **Browser-only, first:** CDP `Page.startScreencast` frames (JPEG, acked)
  relayed over the node channel to the web app, input back through
  `Input.dispatch*`. Simple, no new infrastructure. Gaps: no native
  dialogs, and synthetic CDP input breaks some IME composition (one team
  uses a VNC-style viewer for human takeover for that reason).
- **Whole screen, later:** WebRTC. The native helper captures with
  ScreenCaptureKit and encodes in hardware; it publishes to an SFU we run
  (LiveKit, with TURN over TLS on 443 for hostile networks); the phone
  subscribes and sends touch input over a data channel, mapped to the
  target display and injected with CGEvent. One audited hop, recording and
  kill switch on our side; the cost is relayed bandwidth. Peer-to-peer is
  an optimisation for later.
- **Through the server, not to the computer.** The phone never connects to
  the Mac directly. This keeps one authentication model and lets the
  server stop a session.
- **The phone is the web app** (Capacitor shell over the frontend), so
  both paths are ordinary browser code.
- **View-only by default.** Input from the viewer is dropped unless the
  user takes over; taking over pauses the agent and cancels its pending
  input.

### 2.4 Full computer use of the Mac

The shipping pattern (Claude desktop, ChatGPT Work local mode, OpenClaw,
Cua) is the **real session with consent**:

- A small signed native helper (Swift, Developer ID, notarised, hardened
  runtime; Accessibility-gated APIs cannot run under the App Sandbox) holds
  Accessibility and Screen Recording. The app spawns it so it inherits the
  grants.
- Per-app approval per session; app tiers (view-only, click-only, full);
  sensitive categories blocked by default; a machine-wide lock; other
  windows hidden; Esc consumed as stop.
- Observation: accessibility tree with element refs first, screenshot with
  a frame id when the tree is thin.
- **Background control without stealing the cursor** (Codex, Cua) relies on
  private SkyLight calls that Apple can break. Use it behind a provider with
  a documented-API fallback (OpenClaw keeps Peekaboo beside the Cua driver).
- **Friction to expect.** macOS 15 re-prompts monthly for Screen Recording
  for apps that bypass the system picker, and MDM cannot silently grant it
  (it can only let standard users approve). Input needs an unlocked Mac.

**Isolation options, and why the obvious one does not work:**

| Option | What it gives | Limits |
|---|---|---|
| Linux VM on the Mac (Apple Containerization, vfkit) | Local, offline sandbox for code and a Linux browser | Cannot drive macOS apps at all |
| macOS VM on the Mac (Lume, Tart) | Sandboxed, resettable macOS computer use | At most two concurrent macOS VMs (licence clause, enforced by the hypervisor); about 60 GB each; no Mac App Store; none of the user's apps or accounts; the licence's commercial scope needs legal review |
| A second macOS user session | Isolation on the same Mac | No documented way to drive or capture a background user session; treat as unproven |
| The real session, consented | The user's actual Mac | No sandbox; injection exposure; mitigated by app tiers, approvals and the phone kill switch |
| A host helper reached from a local VM | Keeps code in a VM | Only through the harness: the VM never talks to the helper directly, so the harness remains the single policy point |

So "make a VM inside the computer" solves local code execution, not macOS
computer use. The macOS VM tier is an opt-in later option for firms that
want a sandboxed agent Mac, after legal review.

### 2.5 The shared drive

- **Synced folder first.** Mutagen copies its agent into the VM and speaks
  over the system `ssh`; the Mac's `ssh` uses a `ProxyCommand` into a
  harness-authenticated tunnel, so the Mac never reaches the VM directly.
  Three folders: `Inbox` (Mac to VM, one-way), `Outputs` (VM to Mac,
  one-way replica), `Work` (two-way-safe, conflicts listed). Default
  ignores (`node_modules`, `.venv`, `.git` internals), size and entry caps,
  one root only, never the whole home directory.
- **Safety.** Files arriving from the agent get the quarantine attribute
  (an unsandboxed client does not add it on its own; File Provider does).
  The endpoint refuses symlinks that escape the root. Deletes go to a
  server-side trash; the VM snapshots are the second net. A snapshot
  restore is announced to the client as a new epoch rather than looking
  like a flood of edits.
- **Documents of record stay explicit.** Dropping a file in does not make
  it a firm document; "Save to matter" promotes a file into the documents
  facade as a version, and an agent output becomes a document only the same
  way.
- **Then a sync API, then File Provider.** A harness sync API backed by a
  small agent in the VM (stable file ids, a monotonic change cursor) makes
  both a Mutagen replacement and a Finder drive straightforward. Build File
  Provider only on top of that; Nextcloud's File Provider client still had
  an open large-upload bug in September 2026. No kernel extensions, no
  macFUSE, no peer-to-peer (Syncthing would need a path into the VM).
- **Windows** uses the Cloud Files API (NTFS placeholders, as OneDrive
  does); **Linux** gets the synced folder.

## 3. Scaling computer use down

Reported results (vendor numbers; harness-dependent; not reproduced):

| Tier | Example models | Reported results | Licence or price |
|---|---|---|---|
| Frontier | Claude Opus 5.5, GPT-6 Astra | OSWorld 2.1 81.8 (Opus 5.5), OSWorld 2.0 72.6 (Astra) | Hosted |
| Flash | Gemini 3.5 / 3.8 Flash, Claude Haiku 5.5 | OSWorld 78.4 (3.5 Flash); Haiku 5.5 72.4 at max effort, 53.3 at medium, on OSWorld 2.1 | Hosted; Haiku 5.5 $0.10 / $0.50 per M tokens |
| Open ~27B | Qwen3.8-27B; Fara1.5-27B (web); Holo4-27B | OSWorld-Verified 84.3 (Qwen3.8, no scaffold published, no independent result); Online-Mind2Web 72.3 (Fara1.5); OSWorld 2.0 61.7 vs 81.8 for Opus 5.5 (Holo4) | Apache-2.0 (Qwen), MIT (Fara), **non-commercial** (Holo4-27B) |
| Small grounder | MAI-UI 2B/8B, UI-Venus-1.5, Holo3.1 4B | ScreenSpot-Pro 57 to 74 (Claude Sonnet 4.5 was 36.2) | Mostly Apache-2.0 / MIT; fits a 12 GB GPU |
| No model | Cached scripts, APIs, CLIs | Cheapest and most reliable where it applies | |

`Qwen 3.8 27B` exists: `Qwen/Qwen3.8-27B`, dense, native vision, Apache-2.0,
262K context, published around 2026-08-13. Its OSWorld number should be
reproduced on our own tasks before we rely on it; Artificial Analysis rates
it slow with thinking on (160M output tokens across its index at `xhigh`
against a peer median of 48M), so `reasoning_effort=low` or thinking off
matters for agent steps. Memory: about 28 GB at FP8, 14 to 16 GB at 4-bit
(keep the vision tower unquantised; quantisation costs about 2 OSWorld
points).

What lets weak models succeed:

1. **Text observations.** On OSWorld, Gemini 2.5 Flash scored 18.4 with the
   accessibility tree against 5.3 with screenshots only (OS-Harm, 2025;
   unverified table). For frontier models, text plus screenshot beats text
   alone (WebForge: removing screenshots cost Gemini 3 Flash 16 points). So:
   accessibility snapshot with refs by default, screenshot when the tree is
   thin.
2. **Planner plus small grounder.** Grounding took under 4% of task time in
   OSWorld-Human's measurements; planning took 54 to 75%. A 7B grounder was
   as good as a 72B one under the same planner (GTA1). Make the planner
   cheap; the grounder already is. A two-pass grounder (coarse, then a
   zoomed crop) adds about 6 ScreenSpot-Pro points for small models.
3. **Record once, replay as code.** A strong model explores once and
   produces a script; replays run deterministically or on a flash model and
   escalate only on drift (Stagehand caching, Skyvern code blocks, Nova
   Act). Firm work recurs, so this is the biggest cost lever. Evidence is
   vendor claims; we should measure drift ourselves.
4. **APIs and CLIs before GUIs.** OSWorld-MCP: tools lifted o3 from 8.3% to
   20.4%, but models used tools rarely. Route in code, expose few,
   well-named tools.
5. **A cheap verifier per step and best-of-N on hard steps.** Behaviour
   best-of-N added about 6 OSWorld points to Agent S3.
6. **Jev as a router.** A decision model picking the next action from a
   numbered control table is cheap (well under a second) and is worth an
   evaluation against a flash model on our own tasks.

What does not scale down yet: long multi-app workflows (61.7 vs 81.8 on
OSWorld 2.0 between the best 27B and Opus 5.5), open-web exploration of
unfamiliar sites (Browser Use's live-web benchmark: 35 to 37% for older
flash and mini models against 59 to 80% for frontier), and safety judgement,
for which there is no small-model evidence. Consequential actions keep a
human confirmation whichever tier acts.

Proposed routing: the model tier follows the task, and escalation follows
failures (a verifier flags a missed post-condition), not task type alone.
Private screens stay on the local model; MAI-UI reports 40% fewer cloud
calls with an on-device/cloud split chosen by task state and sensitivity.

## 4. Windows and Linux

- **Windows** is ahead at the OS level: an experimental *agent workspace*
  runs agents under a separate standard account in a parallel session,
  limited to known folders, with monitor and takeover; agents must be
  signed. Windows 365 for Agents (generally available mid-2026) offers
  pooled Cloud PCs with an agent channel and a human channel. Capture with
  Windows Graphics Capture, control with UI Automation; input to elevated
  windows needs a signed UIAccess binary, and the UAC secure desktop needs a
  SYSTEM service. A Mike Windows node should run under the agent-account
  model once it is generally available. ChatGPT Work's Windows computer use
  takes over the foreground; macOS gets background mode.
- **Linux**: the xdg-desktop-portal RemoteDesktop and ScreenCast portals
  (consent dialog, PipeWire, libei) on Wayland; or the agent's own Xvfb or
  nested compositor desktop. OpenClaw rejects native Wayland for its
  gateway desktop and needs a managed X11 session.

## 5. Shell and packaging

Keep the upstream Electron wrapper (`docs/mac-app.md`) for the window,
menus, updates and the browser node. Put capture, accessibility and input in
a small signed native helper per OS (Swift on macOS; a Rust or C# helper on
Windows) that talks to the shell over a local socket; that helper is what
macOS permissions attach to. File Provider, when it comes, is a Swift app
extension. Tauri is worth revisiting only if bundle size becomes a problem.
Firms get a signed `.pkg`, a PPPC profile for Accessibility and managed
configuration (server URL, policy); Screen Recording still needs the user's
approval.

## 6. Phases

| Phase | Builds | Done when |
|---|---|---|
| D0. Node protocol | `modules/nodes`: pairing, device keys, typed capabilities, grants, audit, heartbeat, kill switch; the dispatcher branch | A test node pairs, receives a capability call, is revoked from the web app and stops |
| D1. Desktop wrapper and browser node | The upstream Electron wrapper (per `docs/mac-app.md`) plus an agent Chrome profile over CDP; `browser.*` tools routed to the device when it is online; device-side egress checks | A chat turn reads a bot-protected page through the user's Mac, from the user's IP, with the request logged; a LAN address is refused |
| D2. Watch and take over | CDP screencast relayed to the web app and phone; take over and hand back | The owner watches a turn on the phone, takes over to type a password, and hands back |
| D3. Synced folder | Mutagen over the harness tunnel; Inbox, Outputs, Work; quarantine on arrival; Save to matter | A file dropped in Inbox is read by the agent; its output appears in Outputs, quarantined; a snapshot restore resyncs cleanly |
| D4. Native helper and screen view | Swift helper: ScreenCaptureKit, accessibility tree, input; app tiers and approvals; WebRTC through a LiveKit SFU | The agent completes a task in a native Mac app with per-app approval, visible live on the phone, stopped from the phone |
| D5. Small-model tiers | An evaluation set from the firm's own recurring tasks; runs on a flash model, Qwen3.8-27B self-hosted, a small grounder, and a Jev text loop; record-and-replay | A table of success, cost and time per tier on our tasks, reproduced, not vendor numbers |
| D6. Isolation and other platforms | Sync API and File Provider; macOS VM tier (after licence review); Windows node on the agent workspace; Linux node | Each with its own acceptance when scheduled |

D0 is the foundation for everything else; D1 and D2 deliver the residential
browsing the owner asked for; D4 is the full computer use.

## 7. Decisions for the owner

1. **Logins:** agent Chrome profile the user signs into (recommended
   first), or a Chrome extension in the user's everyday browser (more
   reach, more risk, Web Store review).
2. **Live-view relay:** self-host LiveKit on our servers for D4, accepting
   the relayed bandwidth.
3. **Legal review** before release: residential egress and site terms of
   service; the macOS licence's scope for commercial macOS VMs (D6).
4. **Bot posture:** identify the agent (signed requests) or behave as the
   user's browser; no fingerprint rotation or CAPTCHA solving either way.
5. **GPU for local models:** node-a has no GPU in the inventory we know of;
   D5's self-hosted tier needs one (a 24 to 48 GB card, or a Mac with
   enough memory for MLX).

## Sources

Primary or near-primary sources the conclusions rest on (the four research
reports cite more):

- OpenClaw: [nodes](https://docs.openclaw.ai/nodes), [computer use](https://docs.openclaw.ai/nodes/computer-use), [Mac remote](https://docs.openclaw.ai/platforms/mac/remote), [macOS VMs](https://docs.openclaw.ai/install/macos-vm), [v2026.8.1 browser and computer use](https://docs.openclaw.ai/releases/2026.8.1/browser-and-computer-use)
- Anthropic: [computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), [best practices](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude), [Claude Code computer use](https://code.claude.com/docs/en/computer-use), [computer use safety](https://support.claude.com/en/articles/14128542-computer-use-safety), [Dispatch](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork), [prompt-injection defenses](https://www.anthropic.com/news/prompt-injection-defenses)
- OpenAI: [computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), [use your computer with Codex](https://learn.chatgpt.com/use-cases/use-your-computer-with-codex)
- Google: [Gemini computer use](https://ai.google.dev/gemini-api/docs/computer-use), [Chrome agent security architecture](https://blog.google/security/architecting-security-for-agentic/)
- Microsoft: [Windows agentic security](https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security), [Windows 365 agent sessions](https://learn.microsoft.com/windows-365/agents/agent-session-lifecycle), [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Fara1.5-27B](https://huggingface.co/microsoft/Fara1.5-27B)
- Chrome: [remote-debugging port change](https://developer.chrome.com/blog/remote-debugging-port), [auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)
- Cua: [trycua/cua](https://github.com/trycua/cua), [the no-foreground contract](https://cua.ai/docs/explanation/the-no-foreground-contract)
- Jev: [InfoQ](https://www.infoq.com/news/2026/10/typesafe-ai-jev-released/), [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
- Models: [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), [Holo4-27B](https://huggingface.co/Hcompany/Holo4-27B), [MAI-UI-8B](https://huggingface.co/Tongyi-MAI/MAI-UI-8B), [Qwen-UI-Agent](https://arxiv.org/html/2607.28227v1), [GTA1](https://arxiv.org/html/2507.05791v3), [OSWorld-Human](https://arxiv.org/html/2506.16042), [WebForge](https://arxiv.org/html/2604.10988v1), [OSWorld-MCP](https://arxiv.org/html/2510.24563v1), [Browser Use model benchmark](https://browser-use.com/posts/what-model-to-use)
- Streaming: [Kernel live view](https://www.kernel.sh/docs/browsers/live-view), [LiveKit remote control](https://livekit.com/blog/yeah-but-can-it-run-doom)
- macOS VMs: [Apple forum on the two-VM limit](https://developer.apple.com/forums/thread/830383), [Apple Containerization](https://github.com/apple/containerization)
- Sync: [Apple File Provider](https://developer.apple.com/documentation/fileprovider/replicated-file-provider-extension.md), [Mutagen](https://mutagen.io/documentation/synchronization/), [Windows Cloud Files API](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine), [Nextcloud large-upload issue](https://github.com/nextcloud/desktop/issues/9883)
- Legal: [Amazon v. Perplexity injunction](https://www.geekwire.com/2026/judge-blocks-perplexitys-ai-bot-from-shopping-on-amazon-in-early-test-of-agentic-commerce/), [appeal](https://www.mediapost.com/publications/article/417007/appeals-court-sides-against-amazon-lifts-perplexi.html)
