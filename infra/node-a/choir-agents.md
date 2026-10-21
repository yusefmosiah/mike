# Choir agents VM: setup runbook

A microVM on node-a where Claude Code works on go-choir, signed in to the
owner's Claude Max account. The module is `choir-agents.nix` in this
directory; its header explains the design. This file is the one-time setup,
written to be followed by an orchestrating Claude Code on the owner's iMac
with the owner beside it.

State on 2026-10-21: the module and its three companion edits are in the
working tree of `/Users/wiz/Dev/mike`, not committed, not deployed.
node-a's config copy, `/root/mike-infra`, matches this repo's `main` at
`1bc1c23f`.

## Ground rules

- The owner approves each step that changes node-a (steps 2 and 3) before it
  runs. Reading is fine.
- The VM shares the owner's Max usage limits with every other session.
- Never print, log or commit the login code, the Claude credentials file
  (`~/.claude/.credentials.json` in the VM) or a private key.
- Your Bash tool has no terminal. Anything interactive in the VM runs in a
  tmux session there: start it with `tmux new-session -d`, read it with
  `tmux capture-pane -p`, answer it with `tmux send-keys`.
- Node-a's rule (`/root/HANDOFF.md`): `nixos-rebuild test` first, a fresh
  ssh login, then `switch`. Choir's builder module and the owner's root key
  must stay as they are.

## 1. Check the change (local, read-only)

```sh
cd /Users/wiz/Dev/mike
git status --short infra/           # 4 modified + choir-agents.nix, choir-agents.md
git diff infra/
nix eval --raw path:./infra#nixosConfigurations.node-a.config.system.build.toplevel.drvPath
```

What the diff must show, and nothing else in `infra/`:

- `configuration.nix` imports `./choir-agents.nix`.
- `workstations.nix` sets `_module.args.workstationVms` (Mike's VMs only)
  and its memory comment mentions the agents VM.
- `vault.nix` and `staging.nix` read `workstationVms` instead of every
  microVM, so the agents VM is not in Mike's pool or vault. Staging's pool
  must still be `ws-01,ws-02,ws-03,ws-04`.

Ask the owner whether to commit it first (branch `feat/node-a-choir-agents`,
or main if they say so).

## 2. Copy the config to node-a (owner approves)

```sh
rsync -a --exclude result /Users/wiz/Dev/mike/infra/ node-a:/root/mike-infra/
```

## 3. Deploy with a rollback timer (owner approves)

On node-a, in one ssh command:

```sh
ssh node-a '
  set -e
  prev=$(readlink -f /run/current-system)
  # Roll back by itself in 10 minutes unless cancelled.
  systemd-run --unit=choir-agents-rollback --on-active=600 "$prev/bin/switch-to-configuration" test
  nixos-rebuild test --flake /root/mike-infra#node-a
'
```

The first build compiles the guest's store image; give it up to 30 minutes
(run it in the background, not under a short timeout). Then, from a new
connection:

```sh
ssh -o ControlPath=none node-a 'systemctl is-active microvm@agents microvm@ws-owner mike-vault tinyproxy; systemctl --failed --no-legend'
```

All active and nothing failed: cancel the rollback and switch.

```sh
ssh node-a 'systemctl stop choir-agents-rollback.timer; nixos-rebuild switch --flake /root/mike-infra#node-a'
```

Anything wrong: let the timer fire (or run it now with
`systemctl start choir-agents-rollback.service`) and report to the owner.

## 4. Reach the VM from the iMac

Add to `~/.ssh/config` (ask the owner first; it is their file):

```
Host choir-agents
  User agent
  ProxyCommand ssh node-a choir-agents-vsock
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
```

Then wait for Claude Code to install (a boot-time service, through the
proxy):

```sh
ssh choir-agents 'systemctl status claude-code-install --no-pager | head -5; claude --version'
```

If `claude --version` says it cannot run a dynamically linked executable,
nix-ld is not working: stop and report.

## 5. Sign in with the owner's Max account

```sh
ssh choir-agents 'tmux new-session -d -s login claude auth login; sleep 5; tmux capture-pane -p -t login'
```

Give the owner the URL it shows. They sign in with the claude.ai account
that has Max and get a code back. Type it in:

```sh
ssh choir-agents "tmux send-keys -t login '<code>' Enter; sleep 5; tmux capture-pane -p -t login"
```

Look for `Login successful`, press Enter (`tmux send-keys -t login Enter`),
and check: `ssh choir-agents 'claude auth status'`. It should say claude.ai
login with a Max plan, not an API key.

## 6. GitHub access to go-choir

```sh
ssh choir-agents 'ssh-keygen -t ed25519 -N "" -C choir-agents@node-a -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub'
```

The owner adds that public key at
https://github.com/choir-hip/go-choir/settings/keys with **Allow write
access**. Then:

```sh
ssh choir-agents 'ssh -o StrictHostKeyChecking=accept-new -T git@github.com; git clone git@github.com:choir-hip/go-choir.git ~/go-choir'
```

Ask the owner which name and email the agents' commits should carry, and
set them in the VM only (`git config --global user.name/user.email`), not in
any repository file.

## 7. Remote Control

The `claude-remote-control` service retries every minute until it has a
login and `~/go-choir`, then runs in tmux session `remote-control`. The
first run asks two questions:

```sh
ssh choir-agents 'tmux capture-pane -p -t remote-control'
```

Answer `y` to "Enable Remote Control?" and to "Trust /home/agent/go-choir?"
(`tmux send-keys -t remote-control y Enter`), one at a time, reading the
pane between. The owner should then see the session in claude.ai/code and
the Claude app.

## 8. Smoke test

```sh
ssh choir-agents 'cd ~/go-choir && go version && go build ./... && go test ./internal/agentcore'
ssh choir-agents 'cd ~/go-choir && claude -p --output-format text "Reply with the output of: go env GOVERSION"'
```

Go may first download go-choir's 1.26.9 toolchain. A cgo or ICU error
means the environment in `choir-agents.nix` (`agentEnv`) needs fixing;
report it rather than patching the VM by hand: the VM's system is rebuilt
from that file.

## Using it

One task per worktree, from the iMac:

```sh
ssh choir-agents 'cd ~/go-choir && claude -p -w <task-name> --permission-mode bypassPermissions --output-format stream-json --verbose "<prompt>"'
```

Skipping permission prompts is acceptable here because the VM is the
sandbox: no secrets beyond the Claude login and the go-choir deploy key, no
route to node-a's services, every request logged by the proxy
(`journalctl -u tinyproxy` on node-a).

Limits: no Nix in the VM (no `nix build` or guest images), Dolt is
nixpkgs' build rather than go-choir's pin, no Playwright browsers, 4 cores
and 6 GiB.
