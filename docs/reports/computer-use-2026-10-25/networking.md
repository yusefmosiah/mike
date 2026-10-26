# Computer-use networking research (2026-10-25)

Legend: [V] verified by fetching a primary/near-primary page this session; [R] reported by forum/blog/vendor, not independently confirmed; [K] my own background knowledge, not checked this session. Search-engine summaries I did not open are [R].

## TL;DR
- Hub-and-spoke is sufficient for agent-on-server computer use. Phone does not need WG at all (HTTPS/WSS to our API).
- Least-friction embedded tunnel on macOS: in-process wireguard-go + gVisor netstack (`tun/netstack`). No root, no NetworkExtension, no VPN slot, no system approval prompt. Cost: only our process can use it, and throughput is lower than kernel.
- NetworkExtension packet tunnel (WireGuardKit) is the heavy path: on Developer ID it must be a system extension with user approval; only needed if OS-wide routing is wanted (not our case).
- Honest v1 recommendation: start with an outbound authenticated WebSocket (or HTTP/2) channel over TLS, built so the transport is swappable; add embedded netstack WG as phase 2 if a concrete need appears (raw TCP/UDP services, UDP media, defence in depth). Raw WG is not needed to meet the hub-and-spoke requirement, but it is cheap in netstack mode, so the owner's preference is satisfiable.

## 1. Topology
- Every computer dials out to a server with a public IP; NAT keepalive keeps the mapping open. WireGuard docs suggest PersistentKeepalive 25 s "works with a wide variety of firewalls", off by default [V: https://www.wireguard.com/quickstart/].
- The agent runs on the server and issues actions to the computer; all traffic is server<->computer. No peer-to-peer needed. [K, follows from architecture]
- Tailscale-style mesh/NAT traversal (STUN, DERP relays, hole punching) is only needed when two NATed endpoints must talk directly. [K]
- When P2P would matter: phone <-> Mac live screen streaming (latency, server bandwidth cost: roughly 2-6 Mbps per 1080p H.264 desktop stream [R: https://antmedia.io/video-codecs-streaming-guide/ and other blogs, wide disagreement]); user-driven low-latency remote desktop; file transfer between devices. Even then, WebRTC (ICE+TURN on our server) solves it without a WG mesh [K]. Note the product's main flow (agent screenshots) does not need it.
- Phone: iOS app talks to our API over HTTPS/WSS. No tunnel needed. Embedding WG on iOS would require an NE packet tunnel; the NE entitlement is obtainable by any paid team, no special approval [R: Apple DTS in https://developer.apple.com/forums/thread/814047], but App Store guideline 5.4 requires VPN apps to come from an organization account and restricts VPN-API use [R: summaries of https://developer.apple.com/forums/thread/834624, /844103, /119162; guideline text not fetched; scope for non-VPN-product use is unresolved in those threads]. Avoid.

## 2. Embedding WireGuard
### Options
| Platform | Option | Privilege | Notes |
|---|---|---|---|
| macOS/iOS | WireGuardKit (wireguard-apple) in NEPacketTunnelProvider | NE entitlement; on macOS Developer ID needs system extension + approval | MIT licensed; needs Go + manual "external build system" target for wireguard-go-bridge; builds for macOS and iOS [V: https://github.com/WireGuard/wireguard-apple (mirror; official at git.zx2c4.com), https://www.wireguard.com/embedding/] |
| any | wireguard-go + `tun/netstack` | None (no TUN device, no root) | `CreateNetTUN`, then `DialContext*`, `ListenTCP`, `ListenUDP`, ping; separate Go module with gVisor dependency [V: https://github.com/WireGuard/wireguard-go/blob/master/tun/netstack/tun.go ; Debian note via search, R]. BatchSize fixed 1; single NIC [V]. |
| any | boringtun (Rust, Cloudflare) | library only; protocol, no tun/stack | [R: search summary of boringtun fork README]. Would need own netstack (smoltcp) in Rust; Rust is attractive if the native app is Rust. |
| Windows | embeddable-dll-service (uses WireGuardNT) or wireguard-nt | Admin/Local System to install kernel driver + service | WireGuard recommends the DLL service over raw WireGuardNT [V: https://www.wireguard.com/embedding/]. `wireguard /installtunnelservice` creates a service per tunnel; runtime config needs Administrator [V: wireguard-windows docs/enterprise.md]. Netstack mode avoids all of this. |
| Linux | kernel WG via netlink/wgctrl-go, or netstack | root/CAP_NET_ADMIN for kernel | wgctrl-go works on Linux/BSD/Darwin for config [V: embedding page]. |

### Can per-app userspace avoid the system VPN slot on Mac?
Yes, [V on mechanics]: netstack never creates an OS interface; Ryan Schachte's write-up states creating a TUN device needs root, while netstack-bound wireguard-go does not, and the app dials via `tnet.DialContext` [V: https://ryan-schachte.com/blog/userspace_wireguard_tunnels]. The tunnel is only usable by code in our process (e.g. our local RPC server listening on the tunnel IP via `ListenTCP`, which the agent connects to; or we dial out through it). It does not appear under Settings > VPN. It works under a Mac App Store sandbox with only the outgoing-network entitlement [K, not verified]. Tailscale's tsnet is the same pattern: embedded node, userspace stack, own IP, no system interface [V: https://tailscale.com/docs/features/tsnet via search, R for fork notes].

Caveats:
- Performance: gVisor netstack is slower than kernel TCP. Coder measured/tuned a 5x gain; default receive buffer capped the window near 512 KB; Tailscale GRO work gave up to 2x [R: https://coder.com/blog/delivering-5x-faster-throughput-in-coder-2-12-0 ; https://github.com/tailscale/tailscale/pull/12921]. For screenshots and control messages (Mbps-scale) this is irrelevant. No clean Mbps-vs-kernel number found; benchmark ourselves.
- Only our process benefits. Fine, since the agent needs only our app.
- wg-embed (freifunkMUC) is not a macOS solution (interface bring-up no-ops on macOS) [R: search summary]; do not use.
- Cgo/Go runtime in a Swift app: ship wireguard-go as a Go static lib or as a bundled helper process (login item/LaunchAgent). [K]

### NetworkExtension details (if we ever need OS-wide)
- App Store build: app extension (.appex) with `packet-tunnel-provider`. Developer ID build: system extension in `Contents/Library/SystemExtensions`, entitlement `packet-tunnel-provider-systemextension`, plus `com.apple.developer.system-extension.install`; hardened runtime for notarization; user must approve in System Settings > Login Items & Extensions; app must be in /Applications [R but consistent across sources: https://allianceinterstellar.com/en/blog/appex-or-sysex-macos-vpn-en ; https://github.com/manaflow-ai/cmux/pull/11789 (a real WireGuardKit-in-sysex implementation, key stored in providerConfiguration, tunnel started on demand with idle shutdown)].
- Xcode has a known bug exporting Developer ID NE apps, per Apple DTS [V: https://developer.apple.com/forums/thread/820618; workaround is in thread 737894, not read]. An unresolved claim: the official WireGuard Mac app uses plain `packet-tunnel-provider` with Developer ID [R, same thread, conflicting].
- Conclusion: NE costs an entitlement profile, a second target, an approval UX, and debugging pain. Not worth it for a per-app channel.

## 3. Key management without a coordination SaaS
Design (mostly [K], standard practice; kernel API behaviour per wgctrl-go docs):
1. Device generates a Curve25519 keypair locally (private key never leaves; store in Keychain on Mac, DPAPI/Credential Manager on Windows, Secret Service/file 0600 on Linux). Note: a root-owned NE sysex cannot read the user Keychain (cmux's design note) [R]; irrelevant for in-process netstack.
2. Enrollment: signed-in app POSTs `{device_pubkey, device_name, platform}` to our authenticated API (user JWT). Server authorizes, allocates a /32 (and optionally /128) from a pool (unique constraint in Postgres, per-user subnets optional), stores peer row, applies it to the hub, returns `{server_pubkey, endpoint, assigned_ip, hub_ip, mtu, keepalive}`. Optionally a preshared key per peer for PQ-hedging.
3. Hub applies peers via wgctrl-go `ConfigureDevice` with `UpdateOnly/ReplacePeers=false`; upstream batches large configs in chunks (peer batch 32) [R: search summary of configure_linux.go]. No public benchmark found for 10k+ peers; kernel WG is designed for many peers but we have not verified; load-test before promising numbers. One hub WG interface per ~tens of thousands of peers is plenty at v1 scale.
4. Source of truth is Postgres; a reconciler diffs DB vs `wg show` at startup and periodically, so a hub restart or second hub is stateless.
5. Rotation: client generates new key, calls authenticated rotate endpoint, server adds new peer with same IP then removes old after handshake. Revocation: delete peer (`Remove: true`), takes effect immediately; also revoke the user session. Enrollment code/token flow for headless Linux: short-lived one-time code.
6. Keepalive 25 s from client (hub does not need it) [V]. Roaming: hub learns endpoint from last authenticated packet [K]. Windows/Mac sleep: re-handshake occurs on next packet; cmux reports needing a path-monitor re-handshake after wake [R].
7. Hub in Docker/OVH: UDP port open in OVH firewall. Can use 443/udp or 51820/udp.

## 4. Self-hostable alternatives (comparison only; sources are SEO-ish roundups [R]: https://wz-it.com/en/blog/mesh-vpn-comparison-2026-overview/, https://birdhost.de/en/blog/netbird-vs-headscale)
- Headscale: self-hosted Tailscale control server; needs Tailscale clients we cannot embed under our brand easily; single-tailnet-oriented, wrong tenancy model.
- NetBird: full open-source stack with own clients/relay/dashboard; mesh and NAT traversal we do not need; heavy, and its clients are a separate install.
- Netmaker: WireGuard mesh/hub management; reported governance/licence churn (sources disagree on Apache vs SSPL) so check the repo.
- Nebula: certificate-based overlay, own protocol, not WG; good at scale, but requires own CA and lighthouse; not WG.
- innernet: Rust WG overlay with CIDR/ACL model; low activity, [K] admin-oriented, not multi-tenant SaaS.
- Firezone: gateway-based resource access (hub-like!), recently re-architected [R]; its client model is a VPN client app, not embeddable.
- wg-easy: web UI for a single WG server; no API-driven per-user enrollment story, no embedding.
All of them solve distribution and coordination that we already have (our authenticated API plus our own app). Raw WG plus a 200-line registry is smaller than integrating any of them. [K]

## 5. Security
- Per-device isolation on the hub: each peer's `AllowedIPs` = only its own /32 (this is what makes cryptokey routing drop spoofed sources) [K, standard WG semantics]. Hub nftables: forward chain policy drop; explicitly no `wg0 -> wg0` accept (spoke-to-spoke traffic re-enters on the same interface and needs a deliberate rule [R: ssdnodes guide via search]); no forwarding to internal networks; input chain permits only the agent's service ports on the hub tunnel IP. Starter rulesets at Pro Custodibus [R: https://procustodibus.com/blog/2022/11/linux-firewall-for-wireguard].
- Best isolation: don't route at all. Run the tunnel endpoint for the agent in a netns/process that has no route to the internal network, and treat the hub as a non-forwarding host (`net.ipv4.ip_forward=0`); the agent connects to the computer's tunnel IP:port directly from the hub host. [K]
- Mutual auth beyond WG keys: WG key identifies the device only. Run an application-level handshake inside the tunnel: the computer-side RPC server requires a per-device token or mTLS with a cert issued by our API (bind to the device pubkey), and the agent presents a short-lived signed capability for each task/session (user, scope, expiry). Protects against a stolen device key and against server-side confused-deputy bugs. Inbound-from-hub only: the device should not accept anything not from the hub IP.
- What goes in the tunnel: control RPC (actions, state), screenshots (PNG/JPEG), optional streaming, input events, file ops. Treat the channel as carrying fully privileged remote control of the machine: sensitive permissions (Screen Recording, Accessibility on Mac) are granted to our app, so the control socket is the crown jewel.
- WS/QUIC over TLS instead of WG, honest comparison:
  - Pros of WSS: works through nearly any egress (WG is UDP-only; blocked UDP needs udp2raw/wstunnel/TCP fallbacks [R: https://www.procustodibus.com/blog/2022/02/wireguard-over-tcp/ , https://www.vpnsmith.com/en/blog/wstunnel-tcp-over-websocket-2026]); reuses existing auth, load balancers, observability, rate limits; no IP allocation, no hub kernel config, no per-peer state; easy horizontal scaling and rolling deploys; no gVisor/Go dependency in a Swift app; trivially portable to Win/Linux.
  - Cons: no cryptographic isolation of peers at L3 (but there is no L3 to reach); TCP head-of-line blocking for streaming (a [R] vendor claim, https://macky.dev/ko/blog/why-vnc-is-slow-over-5g-webrtc); you own the framing, heartbeats, reconnects and resume; another app-layer authenticator to get right.
  - WG pros: tiny audited protocol, silent to unauthenticated scanners (no response without a valid key), roaming, UDP, built-in crypto identity per device, good for exposing arbitrary services. Cons: UDP blocked by some corporate/hotel networks; ops cost of peer state; MTU tuning; in netstack mode extra Go runtime and slower TCP.
  - Verdict: for v1 the WSS control channel is simpler and more reliable on hostile networks; WG's unique benefits (UDP, arbitrary services, scanner invisibility) are not required for screenshot+action RPC. Choose WG if the owner's priority is no-third-party-coordination plus minimal attack surface on the server (no public TCP listener per device) -- but note a WSS endpoint is on our existing API anyway, so there is no new third party either way.

## 6. Remote-control transport over the tunnel
- Custom screenshot+action RPC (what an LLM agent needs). Anthropic's computer-use docs: recommend 1024x768 or 1280x720 for general desktop tasks, avoid >1920x1080; image limits 1,568 px long edge / ~1.15 MP for earlier models, 2,576 px / 4,784 visual tokens for newer ones; ~1,000-1,800 input tokens per screenshot; images must be pre-scaled (API rejects oversize); Retina captures at 2x need downscale or coordinate halving; 500 ms post-click wait in the example; prune to ≤20 images [V: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (read first 100k of 119k chars)]. So payloads are small: a 1280x720 JPEG is on the order of 100-300 KB [K], one per agent step; model inference (seconds) dominates latency, network RTT (tens of ms) is negligible. Even slow netstack TCP suffices.
- VNC/RFB: universal, but pixel-framebuffer protocol; inefficient and TCP-bound [R: HN thread https://news.ycombinator.com/item?id=32526108]; macOS Screen Sharing/VNC requires user enabling and password auth; the agent would have to capture frames anyway. Not recommended: our native app already can capture and inject input with ScreenCaptureKit / CGEvent (Mac), which needs Screen Recording + Accessibility permissions [K].
- WebRTC: right choice only for human-facing live video (phone viewing Mac). UDP congestion control, ~10 ms added latency in robotics measurements, ~170 ms glass-to-glass remote [R: https://transitiverobotics.com/blog/webrtc-latency-breakdown/ and Open Robotics analysis, camera pipelines, not desktops]. Desktop content H.264 is about 250-500 KB/s at 1080p/30fps/2 Mbps [R: https://etducky.com/blog/webcodecs-h264-remote-desktop], a developer reports WebSockets suffice for desktop at 12-30 fps. Complexity: ICE/TURN, codecs, signaling. Can run through our WSS signaling, no WG required.
- Recommendation: RPC over the channel (JSON/protobuf: `screenshot`, `click`, `type`, `key`, `scroll`, `drag`, plus accessibility-tree/app-aware actions); screenshots as JPEG/PNG scaled agent-side; add H.264/WebRTC only when a human-viewing feature ships.

## Gaps / unverified
- No benchmarks found for netstack vs kernel throughput, nor 10k-peer WG hub scaling; test.
- Mac App Store sandbox + embedded wireguard-go: not verified; test early. Notarization of a Go-built helper: standard, [K].
- Windows embeddable-dll-service mechanics not read in detail.
- iOS App Store guideline 5.4 text not read directly.
- Rotating/revoking and the reconciler are design proposals, not tested.
