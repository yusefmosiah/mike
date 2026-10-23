# Choir agents VM: setup runbook

A microVM on node-a where Claude Code works on go-choir, signed in to the
owner's Claude Max account. The module is `choir-agents.nix` in this
directory; its header explains the design. This file is the setup, written
to be followed by an orchestrating Claude Code on the owner's iMac with the
owner beside it, and corrected after the first run.

State on 2026-10-21: set up and running. The module and its companion edits
are on the local branch `feat/node-a-choir-agents` of `/Users/wiz/Dev/mike`
(not pushed: the repo is public and this is the owner's infrastructure), and
node-a's `/root/mike-infra` is that branch. `/root/HANDOFF.md` on node-a
says so, so a later sync of `main` alone does not drop the VM. Before the
first deploy node-a was also missing the vault fix 4a9ed1d2 (never copied,
not held back); step 2 deployed it with the VM.

## Ground rules

- The owner approves each step that changes node-a (steps 2 and 3, and every
  later redeploy) before it runs. Reading is fine.
- The VM shares the owner's Max usage limits with every other session.
- Never print, log or commit the login code, the Claude credentials file
  (`~/.claude/.credentials.json` in the VM), the GitHub token or a private
  key. Where a secret must be typed, the owner types it in the VM's terminal
  themselves (steps 5 and 6), so it never passes through the agent.
- Your Bash tool has no terminal. Anything interactive in the VM runs in a
  tmux session there: start it with `tmux new-session -d`, read it with
  `tmux capture-pane -p -J`, answer it with `tmux send-keys`.
- Node-a's rule (`/root/HANDOFF.md`): `nixos-rebuild test` first, a fresh
  ssh login, then `switch`. Choir's builder module and the owner's root key
  must stay as they are.
- Compare all of `infra/` with node-a before copying, not a few files:
  `rsync -an --checksum --itemize-changes --exclude result infra/ node-a:/root/mike-infra/`.
  Anything listed besides your change is a difference to report first.

## 1. Check the change (local, read-only)

```sh
cd /Users/wiz/Dev/mike
git status --short infra/
git diff infra/
nix eval --raw path:./infra#nixosConfigurations.node-a.config.system.build.toplevel.drvPath
```

What the change must contain:

- `configuration.nix` imports `./choir-agents.nix`.
- `workstations.nix` sets `_module.args.workstationVms` (Mike's VMs only)
  and its memory comment mentions the agents VM.
- `vault.nix` and `staging.nix` read `workstationVms` instead of every
  microVM, so the agents VM is not in Mike's pool or vault. Staging's pool
  must still be `ws-01,ws-02,ws-03,ws-04`.

Commit it on `feat/node-a-choir-agents` and do not push (owner, 2026-10-21).

## 2. Copy the config to node-a (owner approves)

```sh
rsync -an --checksum --itemize-changes --exclude result /Users/wiz/Dev/mike/infra/ node-a:/root/mike-infra/   # preview
rsync -a --exclude result /Users/wiz/Dev/mike/infra/ node-a:/root/mike-infra/
```

## 3. Deploy with a rollback timer (owner approves)

Build first, without activating anything. The first build compiles the
guest's store image and can take a long time; run it in the background so
the rollback timer below only covers the switch:

```sh
ssh node-a 'nixos-rebuild build --flake /root/mike-infra#node-a'
```

Then arm the timer and test-activate, in one ssh command:

```sh
ssh node-a '
  set -e
  prev=$(readlink -f /run/current-system)
  # Roll back by itself in 10 minutes unless cancelled.
  systemd-run --unit=choir-agents-rollback --on-active=600 "$prev/bin/switch-to-configuration" test
  nixos-rebuild test --flake /root/mike-infra#node-a
'
```

Use a new unit name for each redeploy (`choir-agents-rollback2`, …); a
finished transient unit's name can still be taken. Then, from a new
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

A redeploy that changes only the guest restarts only `microvm@agents`; the
home disk (login, `gh` token, checkout, caches) survives it.

## 4. Reach the VM from the iMac

Add to `~/.ssh/config` (ask the owner first; it is their file, so back it up):

```
Host choir-agents
  User agent
  IdentityFile ~/.ssh/id_ed25519_ovh
  ProxyCommand ssh node-a choir-agents-vsock
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
```

`IdentityFile` matters: the VM authorizes only the owner's node-a key, and
without it ssh offers the default keys and is refused. Then wait for Claude
Code to install (a boot-time service, through the proxy):

```sh
ssh choir-agents 'systemctl status claude-code-install --no-pager | head -5; claude --version'
```

If `claude --version` says it cannot run a dynamically linked executable,
nix-ld is not working: stop and report.

## 5. Sign in with the owner's Max account (owner types the code)

```sh
ssh choir-agents 'tmux new-session -d -s login claude auth login; sleep 5; tmux capture-pane -p -J -t login'
```

Give the owner the URL it shows, and have them attach from their own
terminal so the code goes straight into the VM:

```sh
ssh -t choir-agents tmux attach -t login
```

They open the URL, sign in with the claude.ai account that has Max, paste
the code at the prompt, press Enter at `Login successful`, and detach
(Ctrl-b d). Check: `ssh choir-agents 'claude auth status'` must show
`"authMethod": "claude.ai"` and `"subscriptionType": "max"`, not an API key.

## 6. GitHub access to go-choir

The choir-hip organization disables deploy keys, so the VM uses a
fine-grained personal access token of the owner's, entered through `gh`
(owner, 2026-10-21: agents may push, and are told to work through PRs).

The owner creates it at https://github.com/settings/personal-access-tokens/new:
resource owner `choir-hip`, only the `go-choir` repository, Contents and
Pull requests read and write, a short expiry (30 days). They enter it
themselves, interactively (GitHub.com, HTTPS, authenticate Git: yes, paste a
token):

```sh
ssh -t choir-agents gh auth login
```

Then point git's credential helper at `gh` on the PATH. `gh` writes its own
store path, which a VM rebuild replaces:

```sh
ssh choir-agents 'for h in https://github.com https://gist.github.com; do
  git config --global --unset-all credential.$h.helper
  git config --global --add credential.$h.helper ""
  git config --global --add credential.$h.helper "!gh auth git-credential"
done
gh auth status
git clone https://github.com/choir-hip/go-choir.git ~/go-choir
cd ~/go-choir && git push --dry-run origin HEAD:refs/heads/agents-auth-check'
```

The dry run proves push access without creating anything. The agents'
commits carry `Choir Agents <yusef@mosiah.org>` (owner), set in the VM only:

```sh
ssh choir-agents 'git config --global user.name "Choir Agents"; git config --global user.email yusef@mosiah.org'
```

## 7. Remote Control

The `claude-remote-control` service retries every minute until it has a
login and `~/go-choir`, then runs in tmux session `remote-control`, in
bypass mode with capacity 6. The first run asks two questions, in this
order: "Trust /home/agent/go-choir?" then "Enable Remote Control?".

```sh
ssh choir-agents 'tmux capture-pane -p -J -t remote-control'
ssh choir-agents 'tmux send-keys -t remote-control y Enter'   # one at a time, reading the pane between
```

The pane then shows `Connected · go-choir` and an environment link. The
owner should see the session in claude.ai/code and the Claude app. The
answers persist on the home disk; later restarts ask nothing.

An interactive session started by hand in bypass mode
(`claude --remote-control <name> --permission-mode bypassPermissions` in
tmux) asks four first-run questions: theme (Enter), security notes (Enter),
the bypass warning (Down, Enter to accept), the fullscreen renderer (Down,
Enter for "Not now").

## 8. Smoke test

```sh
ssh choir-agents 'cd ~/go-choir && go version && go build ./... && go test ./internal/agentcore'
ssh choir-agents 'cd ~/go-choir && claude -p --allowedTools "Bash(go env:*)" --output-format text "Reply with the output of: go env GOVERSION"'
```

Go first downloads go-choir's 1.26.9 toolchain. Measured 2026-10-21 on 4
cores: a cold `go build ./...` about 7 CPU-minutes, warm 32 s; the agentcore
package test 6 min 11 s, almost all on one core. Without a permission flag
`claude -p` cannot run the command (it cannot ask), so the second line
allows that one command.

A cgo or ICU error, or "no space left on device", means the environment in
`choir-agents.nix` (`agentEnv`) needs fixing; report it rather than
patching the VM by hand: the VM's system is rebuilt from that file. (The
first run hit the latter: `/` and `/tmp` are a ~3 GB RAM-backed rootfs, so
`TMPDIR` and `GOTMPDIR` now point at `/home/agent/.tmp`.)

## Using it

One task per worktree, from the iMac, with the model chosen per task:
Sonnet for work linear in the plan or optimizing a metric, Opus where the
design is open (owner, 2026-10-21).

```sh
ssh choir-agents 'cd ~/go-choir && claude -p -w <task-name> --model <model> --permission-mode bypassPermissions --output-format stream-json --verbose "<prompt>"'
```

Continue the same task with `claude -p --resume <session-id> "<follow-up>"`.

Sessions on the iMac and in the VM can message each other with
`SendMessage` (each lists the other in `ListAgents`), but only between
sessions in the same permission mode: a message to a session in another mode
waits for a human to approve it in that session. The VM's Remote Control
sessions run in bypass mode for that reason. A peer's reply is delivered to
the receiving session between its tool calls, so do not block on a
long-running command while waiting for one.

Skipping permission prompts is acceptable here because the VM is the
sandbox: no secrets beyond the Claude login and the GitHub token, no route
to node-a's services, every request logged by the proxy
(`journalctl -u tinyproxy` on node-a). The token can push to `main`; the
agents are told to open PRs instead. Security work runs here too: the owner
accepts that its PRs are public, since nothing launches before the holes are
patched.

Limits: no Nix in the VM (no `nix build` or guest images), Dolt is
nixpkgs' build rather than go-choir's pin, no Playwright browsers, no
`hostname` command (read `/proc/sys/kernel/hostname`), 8 vCPU and 10 GiB.
