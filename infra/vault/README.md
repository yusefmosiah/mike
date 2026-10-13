# Vault

A small service on the VM host that keeps users' credentials (API keys,
tokens, passwords) and attaches them to requests the workstation VMs make.
No VM, model or browser session other than the one that entered it ever
holds a stored value. The design and its reasoning are in
[`docs/vault.md`](../../docs/vault.md); this file is about running it.

## Layout

| File | What |
| --- | --- |
| `src/main.ts` | Startup: keys, store, sockets (systemd socket activation, or Unix sockets named in the environment for development). |
| `src/crypto.ts` | Envelope encryption at rest; opening values the browser sealed. |
| `src/store.ts` | The encrypted store (`secrets.json`), replaced atomically on each change. |
| `src/policy.ts` | Names, hosts, how a value is attached, read versus write. |
| `src/leases.ts` | Short-lived, VM-bound capabilities, in memory only. |
| `src/control.ts` | The backend's API: manage secrets, issue leases. Never returns a value. |
| `src/data.ts` | What a VM sees: `/<lease>/<host>/<path>` forwarded with the secret attached. |
| `src/forward.ts` | The upstream request: public addresses only, pinned, certificate checked. |
| `src/scrub.ts` | Removes every form of the secret from what comes back. |
| `src/audit.ts` | One JSON line per use or change, never a value. |

Node runs the TypeScript directly (type stripping, Node 22.18 or newer), so
the code uses erasable syntax only and imports with `.ts` extensions. There
are no dependencies.

## Commands

```bash
node --test infra/vault/test/*.test.ts            # unit and end-to-end tests
backend/node_modules/.bin/tsc -p infra/vault      # type check
```

The end-to-end test starts the control and VM sockets and an HTTPS server
with a certificate made by `openssl` at test time.

## On node-a

`infra/node-a/vault.nix` runs it as `mike-vault.service` (a dynamic user, no
capabilities, no network but public IPv4 addresses) with these sockets:

- `/run/mike-vault/control.sock` for the backend, which mounts
  `/run/mike-vault` (`infra/node-a/staging/compose.override.yml`) and finds
  it through `VAULT_CONTROL_SOCKET`.
- `/var/lib/microvms/<vm>/notify.vsock_8200` for each VM. Cloud Hypervisor
  hands a guest's vsock connection to host port 8200 to this socket, so the
  socket identifies the VM. In the guest, `mike-vault.socket` relays
  `127.0.0.1:8200` to it (`infra/workstation/guest.nix`), and
  `MIKE_VAULT_URL=http://127.0.0.1:8200`.

State is in `/var/lib/private/mike-vault` (systemd's dynamic-user location):
`master.key`, `seal.pkcs8`, `secrets.json`, `audit.jsonl`. The store is
useless without `master.key` and `master.key` is useless without the store:
back them up together, somewhere other people cannot read, or not at all.
Losing `master.key` loses every stored secret; users store them again.

```bash
systemctl status mike-vault
journalctl -u mike-vault
curl --unix-socket /run/mike-vault/control.sock http://vault/v1/health
ws ssh ws-owner bash -lc 'curl -s $MIKE_VAULT_URL'   # the usage text, from a VM
```

Restarting the service revokes every lease (they live in memory); stored
secrets are unaffected.
