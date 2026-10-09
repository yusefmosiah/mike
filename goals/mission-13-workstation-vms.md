---
readiness: approved direction 2026-10-09; phases not yet built
---

# Mission 13: Workstation VMs

Owner direction, 2026-10-09. Mike gets a real operating system to work in, and
the safety comes from containment and recovery rather than from a classifier
judging each call.

## Why

The Auto Mode gate (Mission 4) tried to decide, call by call, whether the user
consented to an action. The best held-out result on our corpus was hosted Jev
1.13: 23.8% of legitimate calls refused, and 2 harmful calls let through by
the model (Mission 4 has the replay command).
Anthropic reports 17% misses on overeager actions for its own classifier, and
an independent stress test of it measured 70% misses and 32% false blocks on
ambiguous authorization. The owner's experience matches: false positives every
half hour in daily use. Per-call consent classification is retired as a
safety mechanism (see Mission 4).

What replaces it:

- **Containment:** the agent works in a per-employee VM that holds no secrets
  and cannot reach the host's control plane or other employees' VMs.
- **Recovery:** anything the agent does to that VM can be rolled back.
- **Deterministic boundary policy:** what leaves the VM goes through an egress
  proxy; what changes firm records goes through harness tools with fixed rules.
- **Narrow classifiers where they work:** prompt-injection flags on tool
  results and PII checks on outbound text. They label content; they never grant
  permission.

## Decisions (owner, 2026-10-09)

- **microvm.nix with Cloud Hypervisor** on bare-metal NixOS hosts.
- **The harness stays outside the VM.** Mike's backend, Pi Durable, Postgres,
  object storage, model keys and connector tokens live on the host side. The
  VM never holds them.
- **One persistent VM per employee**, inside one firm. Not multi-tenant: a firm
  runs its own hosts.
- **A full operating system:** a real filesystem, bash, Python, git, Node.
  QuickJS alone is not enough; code mode's `tools.*` scripts (Mission 11) are a
  separate layer for orchestrating Mike's own tools.
- **Networking on.** Web search, fetching pages, pushing to a git remote and
  publishing a blog all need it. It is controlled, not removed. This replaces
  Station 9's "zero network egress" constraint.
- **Durable and recoverable.** The main threat is the agent destroying data
  (`rm -rf *`); the answer is that the data comes back.
- **Private stack first.** Self-hosted models and services are the target;
  Google Drive and similar connectors stay optional for clients who want them.

## Lessons taken from go-choir

`~/go-choir` runs Firecracker guests built with microvm.nix, with the agent
harness and its database inside each guest. Its problem log records the costs
of that placement: the embedded store starved guest memory, the host
hibernated guests mid-run because it could not see guest activity, runtime
fixes did not reach existing guests, keys and files were not restored on a
fresh guest, and guests could reach other guests, the host's control ports and
the open internet. Mike avoids most of these by keeping the harness on the
host. Kept from go-choir:

- **A realization holds no unique state** (its invariant O21): a VM's disk is
  recoverable from storage outside the VM.
- **Capsules** (`internal/capsule`: namespaces, overlayfs upper layer,
  cgroup, seccomp, Landlock, broker): changes stay inert until committed.
  Useful later for per-command undo and review (phase 6).
- **The guest image is declarative Nix** with a read-only store disk shared by
  every VM.

## Architecture

```text
browser -> Mike frontend -> Mike backend (harness: Pi Durable, tools, policy)
                               |  ssh over vsock (one channel per VM)
                               v
               employee VM (Cloud Hypervisor, NixOS guest)
                 /nix/store  read-only erofs disk, shared
                 /home       data disk = ZFS volume on the host
                 eth0        tap -> nftables -> egress proxy -> internet / allowlisted internal services
```

- **Exec channel.** microvm.nix's `microvm.vsock.ssh.enable`: systemd's ssh
  generator listens on vsock port 22, reached from the host through Cloud
  Hypervisor's vsock socket (`ssh vsock-mux/<socket>`). No custom guest agent,
  and no network path from the guest to the host.
- **Storage.** Each VM's data disk is a ZFS volume on the host. The harness
  snapshots it before every agent turn that runs a command, plus on a
  schedule; snapshots are out of the guest's reach. Restore is a rollback or a
  read-only clone for single files. `zfs send` (syncoid) replicates to a
  second machine.
- **Networking.** The guest's tap reaches only the egress proxy: no host
  ports, no other taps. The proxy allows the internet and named internal
  services, blocks private ranges otherwise (the rules in
  `backend/src/lib/egress.ts` and `privateIp.ts`), logs every request, and is
  where outbound PII and confidential-figure checks run (the deterministic
  Layer 1 facts from Mission 4: figures copied from private documents, matter
  numbers in search queries).
- **Firm records stay in Mike.** Documents, versions, projects and sharing
  remain in Postgres and object storage. The VM holds working files: scratch,
  analysis, repositories, scripts. Moving a document into the VM is an export
  by the harness; bringing a result back is an upload through the documents
  facade, which records a new version.
- **Mike from inside the VM** (later): Word and Excel manipulation and
  workflows such as tabular review, callable from code. The VM gets no token;
  calls go back to the harness over a vsock capability socket bound to that
  VM's user, so an injected script can do at most what that user can do in
  Mike, through the same tool dispatcher and audit trail.

## Phases

Each phase lands on `main` when its acceptance passes. Nothing here is accepted
until the owner says so.

1. **Guest image and local boot.** A flake under `infra/workstation/` builds
   the guest: NixOS, bash, Python with `python-docx` and `openpyxl`, git,
   Node, LibreOffice headless. It boots on a Mac with vfkit (NAT networking;
   microvm.nix has no vfkit vsock yet) and on Linux with Cloud Hypervisor.
   Acceptance: from the host, `ssh` runs `python3 -c ...` and edits a .docx in
   the guest; the transcript is the receipt.
2. **Harness exec tool.** `backend/src/lib/workstation/` runs a command in an
   employee's VM over ssh (vsock on Linux, TCP for local dev), with timeout,
   output limits, working directory and streamed output, wired as a chat tool
   through the one dispatcher. Acceptance: a chat turn runs a Python analysis
   in the VM and answers from its output.
3. **Recovery on a Linux host.** Cloud Hypervisor, ZFS volume per VM, a
   snapshot before each command-running turn. Acceptance: the agent runs
   `rm -rf ~/*`; the files come back from the turn's snapshot; the procedure
   and its output are recorded.
4. **Boundary.** nftables and the egress proxy. Acceptance: from inside the
   guest, the host's service ports and another VM are unreachable, a public
   site and an allowlisted internal service are reachable through the proxy,
   and the proxy log shows each request.
5. **Dogfood.** The owner keeps a repository in the VM and uses Mike as a
   remote coding and writing agent, for example a script that publishes a blog
   post. Document export and import between Mike and the VM.
6. **Later.** Mike's Word, Excel and workflow tools from code over the vsock
   capability socket; capsules (overlay per command) for per-command undo and
   review; prompt-injection flags on tool results.

## Receipts

**Phase 1, 2026-10-09 (dev lane, not the Linux host).** The `dev-aarch64-linux`
guest ran under QEMU with software emulation inside Docker Desktop on the
owner's M1 (the Mac's own aarch64 builder was down). `backend/scripts/workstation-smoke.mts`
drove it through the harness's exec library (`runInWorkstation`):

| step | result |
|---|---|
| `id`, `pwd`, `df /home` | uid 1000 `agent`, `/home/agent`, `/dev/vdb` 7.8G mounted on `/home` |
| tools | Python 3.14.7, Node v22.23.3, git 2.55.0 |
| write a .docx with python-docx, then edit and read it back | `['Workstation smoke test', 'Edited by python-docx inside the workstation VM.']` |
| openpyxl workbook with a formula | `=A2*B2` read back |
| `cat /does/not/exist` | exit 1, stderr returned |
| `sudo true` | refused (`a password is required`), exit 1 |
| `sleep 30` with a 3 s limit | exit 124, `timedOut: true` after 3.7 s |

After a VM restart (new boot id) the edited .docx was intact. The .xlsx,
written seconds before the container was killed, came back **0 bytes**: an
unclean stop loses whatever the guest had not flushed. Phase 3 must sync or
freeze the guest filesystem before each snapshot and stop VMs cleanly.

First run found a bug, fixed before the receipt above: the empty home disk
is mounted over `/home` after NixOS creates home directories, so
`/home/agent` did not exist; a tmpfiles rule now creates it after the mount.

**Phases 3 and 4 (boundary part), 2026-10-09, on node-a** (x86_64, KVM,
btrfs on md RAID1; ZFS is not available there, so snapshots are btrfs).
`infra/node-a/workstations.nix` runs `ws-owner` under Cloud Hypervisor
(4 vCPU, 6 GiB, 64 GiB sparse home disk); its state directory
`/var/lib/microvms/ws-owner` is a btrfs subvolume.

- Exec over vsock: `ws ssh ws-owner ...` printed `uid=1000(agent)`,
  `Linux 6.18.37 x86_64`, `/dev/vdb 63G ... /home`, guest address
  `10.77.1.2/24`. Fix found on the way: `systemd-ssh-proxy` needs
  `ProxyUseFdpass=yes` (now in the host tool and the harness library).
- Boundary, probed from inside the guest with TCP connects:
  `1.1.1.1:443 reachable`, `https://example.com` 200; blocked: the host's
  tap address and public IP (`10.77.1.1:22`, `51.81.93.94:22`, `:80`),
  `169.254.169.254:80`, `192.168.1.1:80`, another VM's subnet
  `10.77.2.2:22`. First probe found the host's ssh reachable from the guest
  (input path, not forward); input from `ws-*` is now dropped.
- Recovery: the agent wrote `~/data.xlsx` and a git repo; `ws snapshot`
  (guest `sync`, then a read-only btrfs snapshot); the agent ran
  `rm -rf ~/* ~/.[!.]*` (0 entries left); `ws restore ws-owner
  20261009T171046Z-before-rm` took 17.6 s including the VM restart;
  afterwards both files had the same SHA-256 as before
  (`ecd2f4f8...`, `4a28fc25...`) and `git log` showed `6b22f94 init`.
  Fix found on the way: VM images carry btrfs's no-copy-on-write attribute,
  and a clone needs a target with the same attribute.
- Deployed with `nixos-rebuild test` under a 5-minute rollback timer, a fresh
  ssh login, then `switch` (generation 43). Choir's builder key stayed in
  `/etc/ssh/authorized_keys.d/root`.

Still open for phase 4: the logging egress proxy and outbound PII checks.
The NAT path is filtered but not proxied.

**Harness link on staging, 2026-10-09 (node-a, not accepted).** The staging
backend (a container under Podman) reaches `ws-owner` through
`/run/mike-workstations/ws-owner.sock`, a socket-activated `socat` relay to
the VM's vsock socket; only that directory and the harness key (read-only)
are mounted into the container. `vsockProxy.js` does Cloud Hypervisor's
`CONNECT 22` handshake as the ssh ProxyCommand. Each turn's first
`run_command` asks `/run/mike-workstations/control.sock` for a snapshot;
the host flushes the guest, reuses a turn snapshot under two minutes old,
keeps the newest 48 turn snapshots and 14 daily ones (a daily timer), and
never prunes manual ones.

Control socket, from the host:

```
snapshot ws-owner turn    -> ok ws-owner/20261009T174847Z-turn
snapshot ws-owner turn    -> ok ws-owner/20261009T174847Z-turn   (reused)
snapshot ws-other turn    -> error unknown vm
snapshot ws-owner ../etc  -> error bad label
rm -rf /                  -> error unknown request
```

From inside `mike-backend-1`, through the compiled harness library
(`snapshotOncePerTurn`, then `runInWorkstation` with the relay proxy):

```
snapshot: {"ok":true,"snapshot":"ws-owner/20261009T174847Z-turn"}
{"ok":true,"exitCode":0,"stdout":"ws-owner\nagent\n3.1.5\n200\nhost-blocked\n",...,"durationMs":4105}
```

(hostname, user, openpyxl version, `https://example.com` status, and a
`curl` to the Podman gateway's backend port that failed.) No chat turn has
used it yet: `WORKSTATION_USER_IDS` is written by `mike-staging owner-link`
when the owner's account is created, and that has not happened.

## Open questions for the owner

- Which machine is the first Linux host for phases 3 and 4? Cloud Hypervisor
  needs KVM, which this M1 cannot provide (no nested virtualization).
- VM size per employee (vCPU, memory, disk) and whether idle VMs suspend.
- Whether employees get a terminal or file browser on their VM in the web app,
  or reach it only through Mike.
- Where replicated snapshots live, and how long they are kept.
