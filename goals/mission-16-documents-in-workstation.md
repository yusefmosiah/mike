# Mission 16: Documents in the workstation

Owner direction, 2026-10-11: "I think we just need to get the docs in the VM.
... we're going to have a NAS ... in the VM, we're going to have read access
over the NAS and no way to write into it [directly], [but] a safe way [to
write]. ... obviously it needs to be secure, but ... I don't understand why
it can't just be simpler."

This reverses Mission 13's "documents stay out of the VM; moving one in is an
explicit export". The agent should find the user's documents as ordinary files
in its workstation and give results back without ceremony.

## How we got here

An agentic consensus panel ran in divergent mode on 2026-10-11 (ten models,
nine answered; opencode failed on an invalid API key). Their options fell into
six families:

| Family | Idea | Why not first |
| --- | --- | --- |
| Copy in, publish out | The harness copies the user's documents into `~/mike/` before a turn; results come back through one publish step. | Chosen for phase 1. |
| Read-only mount | A host-side tree (later the NAS) mounted read-only into the VM, with the same publish step. | Chosen for phase 2, when the NAS exists. |
| NAS as the record now | Documents become files on the NAS; Postgres only indexes them. | The right direction, but project sharing does not map onto directory permissions, and it is a migration. |
| `mike pull`/`mike put` CLI | The VM fetches on demand over vsock. | The agent has to remember to fetch; files are not "just there". |
| Git per project | Versions are commits. | Office files are binary; sharing does not map onto repositories. |
| Tools only | No files in the VM. | The opposite of what is wanted. |

Nearly every panelist agreed on the boundaries kept below, and on what not to
build.

## Shape

- **One layout, two transports.** The agent sees:

  ```text
  ~/mike/
    projects/<project name>/<folder>/<file>
    library/<folder>/<file>
    chats/<chat title>/<attachment>     standalone chats' attachments
    out/                               what the agent wants to give back
  ```

  Everything except `out/` is read-only (files `0444`, directories `0555`).
  - **Phase 1 (copy).** Before a command-running turn, the harness brings
    `~/mike/` up to date over the ssh channel it already uses (`lib/workstation/exec.ts`):
    it adds new and changed files and removes anything the user can no longer
    read or that was deleted. Only changes travel; a manifest
    (`~/mike/.manifest.json`, document id, version id, sha256 per path) tells
    the harness what is there.
  - **Phase 2 (mount).** When the NAS exists, the same tree is a read-only
    mount (virtiofs or NFS) of a per-user view, and the copy step goes away.
    The layout, the manifest format and `out/` do not change, so nothing the
    agent or a skill does changes either.
- **Scope: everything the user can read in Mike.** The same documents the
  web app shows them. Sharing and org grants are evaluated by the existing
  access checks at sync time, never inside the VM.
- **One way back: publish.** A tool, `save_to_mike`, and the same thing as a
  command inside the VM (`mike-save <file> [--project P] [--folder F]
  [--replace <path under ~/mike>]`, which writes a request file under
  `~/mike/out/` that the harness picks up at the end of the command):
  - A new file becomes a new document in the chat's project, or in the
    library for a standalone chat.
  - `--replace` names a file under `~/mike/`; the harness looks it up in the
    manifest and records a new version of that document through
    `createDocumentVersion`, if the user may still write to it.
  - Nothing is ingested implicitly. Files left in `out/` without a save stay
    there.
- **Results show in chat.** Each save is a visible tool result with a link to
  the new document or version.

## The boundaries we keep

1. **The VM gets no credentials.** No database, object-storage, NAS-write or
   Mike API token. The harness does every read and write as the user.
2. **Permissions are checked when the harness reads or writes,** never by
   trusting anything from the VM. A publish rechecks write permission at
   publish time; a stale copy never grants write access.
3. **The harness reads back only regular files** under `~/mike/out/` (or the
   path named in a save): no symlinks (`O_NOFOLLOW`), size-capped, type
   sniffed as for any upload.

## What we will not build

- A FUSE gateway or any live filesystem before the NAS.
- Two-way sync, file watchers, or "a file changed in the VM, so make a
  version".
- Per-project or per-thread scoping inside one user's VM. It is one person's
  machine.
- Approval prompts for reading documents or for saving results.
- Recall of copies. Once a file has been in the VM, copies the agent made and
  the VM's snapshots keep it until snapshot retention removes it. This is the
  same as a download, and it is written down rather than engineered around.

## Acceptance

1. A chat turn on an account with a few projects runs `ls -R ~/mike` in the
   workstation and sees each project's documents by folder, plus the library.
2. The agent runs Python over a document in `~/mike/projects/...` and saves a
   result with `save_to_mike`; it appears in the project as a new document,
   linked from the chat.
3. `--replace` records a new version of an existing document; the version
   history shows it.
4. A document shared with the user appears after the share; after the share is
   revoked, the next command-running turn no longer has it in `~/mike/`.
5. A document the user cannot read never reaches their VM (a test with two
   users), and a symlink in `out/` pointing outside is refused.
6. Backend tests, the architecture test and the stack tests pass.

## Not yet

- The NAS and the phase 2 mount.
- Large libraries: measure the first full copy and the per-turn delta on a
  realistic account before deciding whether phase 1 needs a size cap.
