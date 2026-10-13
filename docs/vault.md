# Secrets vault

People give the assistant credentials so it can act for them: an API key, a
token that can push to a repository, a password. The vault lets the assistant
**use** a credential without anyone but its owner ever **holding** it: not
the model, not the workstation VM it runs code in, not other users, not the
backend. This document is the design; `infra/vault/README.md` is how to run
it.

## What it protects against

| Threat | Answer |
| --- | --- |
| The agent is talked into leaking a credential (prompt injection from a web page, a document, a repository). | The value is never in the VM or the model's context, so there is nothing to print, write or send. |
| The agent sends a credential somewhere it should not go. | Every secret is bound, when it is stored, to the hosts it may be sent to. The vault refuses any other destination, and a stored secret's hosts cannot be changed. |
| The agent misuses a credential at an allowed host (deletes a repository). | Leases are read-only unless the user approves changes, per lease or once per secret; leases expire in 15 minutes; every request is logged for the owner. |
| Another user, or another user's agent, reaches someone else's credential, including inside the same firm. | Secrets belong to one user. The control API is scoped by the session's user id. A lease names a VM, and the vault checks it against the socket the request arrived on, which only that VM can use. A lease is issued only in a turn the owner sent, in the owner's own VM. Firm admins have no access. |
| The backend is compromised, or its database is dumped. | The backend has no key to the vault and the database has no secrets. New values are sealed in the browser to the vault's public key, so the backend relays ciphertext. A compromised backend can still ask for leases (misuse at allowed hosts) but cannot learn a stored value or redirect one to a new host. |
| The vault's files are copied. | Envelope encryption: each user's key is wrapped by a master key; each value is bound to its user and secret id. `master.key` is readable only by the service. |
| A response echoes the credential back (an error page that prints the header). | The vault removes the value, and its URL- and base64-encoded and basic-auth forms, from response headers and bodies. |

Not covered: a compromised host (root on node-a can read the master key and
the process memory), and a compromised browser while the user types a value.
A compromised backend could also serve a different sealing key to the browser
and read values entered after that; pinning the key in the web app would
close this, and is not done yet.

## Pieces

```
browser ──sealed value──▶ backend ──control.sock──▶ vault (node-a host) ──HTTPS──▶ api.example.com
                                                      ▲
VM: curl $MIKE_VAULT_URL/<lease>/api.example.com/...  │ vsock port 8200, one socket per VM
```

- **The vault** (`infra/vault`, `mike-vault.service` on node-a): holds the
  keys and the encrypted store, issues leases, and forwards requests. No
  dependencies; Node runs its TypeScript directly.
- **Control socket** (`/run/mike-vault/control.sock`): only the backend
  container mounts it. Create, list, update (description and write policy
  only), delete secrets; issue and revoke leases; read the audit log. It never
  returns a value.
- **VM sockets** (`/var/lib/microvms/<vm>/notify.vsock_8200`): Cloud
  Hypervisor connects a guest's vsock connection to host port 8200 to this
  file, so which socket a request arrived on says which VM sent it. Inside
  the guest, `127.0.0.1:8200` relays to it (`MIKE_VAULT_URL`).
- **Backend** (`backend/src/lib/vault`, `backend/src/modules/vault`, the
  `vault_*` chat tools): the user's secrets by metadata, and leases for turns
  in the user's own workstation.
- **Web app**: Settings → Vault, the vault form, and the credential request
  in the chat.

## Flows

**Storing a credential.** The user opens the form from Settings → Vault, or
from the card the assistant shows when it calls `vault_request_secret` (the
turn pauses like a question). The form seals the value in the browser
(ECDH P-256 with the vault's sealing key, HKDF-SHA256, AES-256-GCM) and sends
the envelope with the name, the allowed hosts, how the value is attached
(bearer, basic with a username, or a named header) and whether changes need
approval. The value is never in the chat; the assistant's answer is the name
it was stored under.

**Using one.** The assistant calls `vault_lease` with the name and `read` or
`write`. A read lease is issued at once. A write lease is issued at once only
if the user allowed changes for that secret; otherwise it becomes an approval
card, and the lease is issued when the user approves. The tool result tells
the agent to send requests to `$MIKE_VAULT_URL/<lease>/<host>/<path>`. The
vault checks the lease, the VM, the host and the method (GET, HEAD and
OPTIONS are reads; anything else needs a write lease), resolves the host
itself (every address must be public; the connection goes to the checked
address), attaches the value, and returns the response with the value removed.

**Git.** Smart HTTP is ordinary HTTP, so nothing git-specific exists:
`git remote set-url origin $MIKE_VAULT_URL/<lease>/<host>/<owner>/<repo>.git`
and `git push`. Pushing is a POST, so it needs a write lease. Fetching also
uses POST, so a private fetch needs a write lease too; public repositories
need no credential.

## Choices

- **A separate service, not the backend.** The backend is large and
  internet-facing; the vault is a few hundred lines with no dependencies, no
  open ports and a sandboxed systemd unit. Splitting them is what makes "the
  backend cannot read secrets" true.
- **Destinations fixed at entry.** Updating a secret can change its
  description and write policy, never its hosts or how it is attached.
  Otherwise anyone who could call the control API could redirect a secret to
  a host they own and read it from the incoming request.
- **Leases in memory, VM-bound, short.** A lease is useless outside its VM,
  so it can appear in the conversation. A restart revokes all of them.
- **No service-specific code.** Bearer, basic and custom-header injection
  cover token APIs and git over HTTPS. Signing (ssh keys), OAuth refresh and
  website logins typed into a browser are not supported yet.
- **Approval at lease time, not per request.** A write lease approved once
  covers that secret's hosts for 15 minutes. Per-request approval would hold
  git's connection open for a person; per-lease approval reuses the chat's
  existing approval flow.

## Limits and follow-ups

- Only the workstation VMs on node-a can use the vault; the development VM
  lane and turns without a workstation get the tools refused.
- Requests go to port 443 over IPv4. No websockets.
- Firm-shared secrets (one credential, explicit grants to members) are not
  built; every secret is personal.
- The audit log is local to node-a and rotates at 20 MB.
