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
| The agent sends a credential somewhere it should not go. | Every secret is bound, when it is stored, to exact host names (no wildcards: `*.github.io` would include anyone's subdomain). The vault refuses any other destination, and a stored secret's hosts cannot be changed. Hosts the assistant proposes are marked in the form and must be confirmed. |
| The agent misuses a credential at an allowed host (deletes a repository). | Leases are read-only unless the user approves changes, per lease or once per secret. Read-only means GET, HEAD and OPTIONS, with method-override headers removed and override parameters refused; an API that changes things on a GET is not stopped. Leases end with the turn that got them (at most 15 minutes), and every request is logged for the owner. |
| Another user, or another user's agent, reaches someone else's credential, including inside the same firm. | Secrets belong to one user. The control API is scoped by the session's user id. A lease names a VM, and the vault checks it against the socket the request arrived on, which only that VM can use. A lease is issued only in a turn the owner sent, in the owner's own VM. When a guest's turn starts in a shared thread's VM, the vault fences that VM: its leases are revoked and nothing is lent to it, and because what a guest ran can stay behind, its leases stay paused until the owner allows them again in Settings → Vault (or the VM is wiped). If the vault cannot confirm the fence, the guest's turn does not run. Before a temporary VM is wiped for another account, it is fenced the same way. Firm admins have no access. |
| The backend is compromised, or its database is dumped. | The backend has no key to the vault and the database has no secrets. The browser seals the value together with its owner, name, hosts, how it is attached and the write policy, plus a nonce and the time; the vault uses only what was sealed and accepts each envelope once, within ten minutes. So the backend relays ciphertext it can neither open nor store for another account or host. The web app pins the vault key's fingerprint at build time (the deploy reads it from the vault on the host, not from the backend, and fails without it), so a backend that offers another key is refused; a production build without a pin stores nothing. A compromised backend can still ask for leases, including write leases (approval is enforced by the backend, not the vault): misuse at allowed hosts, never the value. |
| The vault's files are copied. | Envelope encryption: each user's key is wrapped by a master key; each value is bound to its user and secret id. `master.key` is readable only by the service. |
| A response echoes the credential back (an error page that prints the header). | The vault removes the value however its characters are escaped, each independently: as is, percent-encoded once or twice (either case), JSON `\uXXXX` or backslash escapes, numeric HTML references (any number of leading zeros, semicolon or not) and the named ones for ASCII characters; also as hex, and as base64 or base64url at any alignment together with the edge groups that carry its first and last bytes, including inside a basic-auth token; in headers too. The scrubber holds back as much of a stream as the longest form could span (a numeric reference counting as one character however it is padded), so no split hides a match, and changes nothing else: binary bodies pass through byte for byte. A response that would need more held back than that (256 KB, or four times the longest form) is cut off; only that response ends. A compressed response is refused, since the scrubber cannot read it, and range requests are stripped, so an echo cannot be fetched in pieces. `Set-Cookie` is removed: a session cookie is a credential of its own. |

Not covered: a compromised host (root on node-a can read the master key and
the process memory), and a compromised browser while the user types a value.
An allowed host that returns the credential transformed in some other way
(encrypted, in another character set, split across responses, a few
characters at a time) defeats the scrubber; choose hosts that do not echo credentials. Anything the credential
itself can read or create at its hosts (private repositories, new tokens) the
agent can read too: use the narrowest token the service offers.

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
`write`. A read lease is issued at once. Every lease ends when the turn does. A write lease is issued at once only
if the user allowed changes for that secret; otherwise it becomes an approval
card, and the lease is issued when the user approves. The tool result tells
the agent to send requests to `$MIKE_VAULT_URL/<lease>/<host>/<path>`. The
vault checks the lease, the VM, the host and the method (GET, HEAD and
OPTIONS are reads; anything else needs a write lease), resolves the host
itself (every address must be public; the connection goes to the checked
address), attaches the value, and returns the response with the value removed.

**Git.** Smart HTTP is ordinary HTTP, so nothing git-specific exists:
`git push $MIKE_VAULT_URL/<lease>/<host>/<owner>/<repo>.git <branch>`. The URL
is used directly rather than saved as a remote, so no lease is left in the
repository. Pushing is a POST, so it needs a write lease. Fetching also
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
- **Leases in memory, VM-bound, one turn long.** A lease is useless outside
  its VM, so it can appear in the conversation. The backend revokes a turn's
  leases when it ends, a VM's when a guest starts working in it or before it
  is wiped, and a user's when their account is deleted (with their secrets).
  A request in flight stops when its lease ends. A restart revokes all of
  them.
- **Settings sealed with the value.** The vault ignores the settings the
  backend sends beside an envelope; the backend still checks them, to give
  people readable errors. Each envelope is accepted once, within ten minutes
  of being sealed, and only by the vault process it was sealed for: the
  seal key comes with a random epoch per process, sealed into the envelope,
  so a restart (which forgets used nonces) cannot make a used one new.
- **No part of a value leaves the vault.** Not even the last characters
  people use to tell keys apart; names and descriptions do that.
- **Bounded.** Each VM may have 8 requests in flight and 32 connections; a
  refused request is answered without reading its body and the connection
  closed; no request outlives 16 minutes. The log is written ahead: a
  request is forwarded, and a secret created, changed, deleted or lent, only
  once its record is on disk, as is allowing a paused workstation again;
  nothing new happens while the log cannot be written. (Revoking leases
  always works.) The service has a memory
  and task limit, so one VM cannot starve the others.
- **No service-specific code.** Bearer, basic and custom-header injection
  cover token APIs and git over HTTPS. Signing (ssh keys), OAuth refresh and
  website logins typed into a browser are not supported yet.
- **Approval at lease time, not per request.** A write lease approved once
  covers that secret's hosts for the rest of the turn (at most 15 minutes).
  The approval is checked again when it is used: the VM must still be the
  user's own, with no guest working in it. Per-request approval would hold
  git's connection open for a person; per-lease approval reuses the chat's
  existing approval flow.

## Limits and follow-ups

- Only the workstation VMs on node-a can use the vault; the development VM
  lane and turns without a workstation get the tools refused.
- Requests go to port 443 over IPv4. No websockets, compressed responses or
  range requests.
- The fingerprint pin is set when the web app is built
  (`VAULT_SEAL_KEY_SHA256`); a build without it checks only that the key
  matches its id.
- Firm-shared secrets (one credential, explicit grants to members) are not
  built; every secret is personal.
- The audit log is local to node-a and rotates at 20 MB.
