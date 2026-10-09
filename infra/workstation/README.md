# Workstation VMs

One persistent microVM per employee, where Mike's agent runs commands: bash,
Python, Node, git and the office-file libraries, in a real filesystem. The
harness (Mike's backend) stays outside the VM; the VM holds no secrets. See
[`goals/mission-13-workstation-vms.md`](../../goals/mission-13-workstation-vms.md).

- `guest.nix`: the guest system. The agent's account is `agent`, home on the
  VM's data disk (`/home`), no root or sudo login, ssh by key only.
- `flake.nix`: the guest in two lanes.
  - `ch-<system>`: production, Cloud Hypervisor, ssh over vsock only.
  - `dev-<system>`: development, QEMU with guest ssh forwarded to port 2222.

## Development VM

The harness's dev key is read at evaluation time, so no key is committed:

```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/mike-workstation-dev
export WORKSTATION_SSH_PUBKEY="$(cat ~/.ssh/mike-workstation-dev.pub)"
```

On a Mac with a working aarch64-linux Nix builder:

```sh
nix build --impure .#packages.aarch64-darwin.dev-vm -o dev-vm
./dev-vm/bin/microvm-run          # creates home.img in the current directory
```

Without a builder, run the Linux lane inside Docker (software emulation,
slower, no KVM needed):

```sh
docker run -d --name mike-workstation-dev -p 127.0.0.1:2222:2222 \
  -v "$PWD":/src:ro -v mike-workstation-nix:/nix -v mike-workstation-work:/work \
  -e WORKSTATION_SSH_PUBKEY nixos/nix:latest \
  sh -c 'cp -r /src /tmp/flake && nix --extra-experimental-features "nix-command flakes" \
    build --impure path:/tmp/flake#packages.aarch64-linux.dev-vm -o /work/dev-vm \
    && cd /work && exec ./dev-vm/bin/microvm-run'
```

Then:

```sh
ssh -i ~/.ssh/mike-workstation-dev -p 2222 agent@127.0.0.1 python3 --version
```

and point the backend at it (`backend/.env.example`, `WORKSTATION_*`): the
listed users' chat turns get the `run_command` tool.

The dev lanes have open NAT networking and no snapshots: they are for
building the harness, not a safety boundary. Recovery (host ZFS snapshots)
and the egress boundary come with the Linux host (Mission 13 phases 3 and 4).
