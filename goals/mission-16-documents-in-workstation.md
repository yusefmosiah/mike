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
    library/<folder>/<file>             the user's own documents outside projects
    templates/<folder>/<file>           the user's templates
    out/                                scratch space for results
    .manifest.json                      what the harness copied, for the next sync
  ```

  Everything except `out/` is read-only (files `0444`, directories `0555`).
  Names are made safe for a filesystem, and clashes are numbered in creation
  order (`Lease.docx`, `Lease (2).docx`), so a sync never shuffles files
  between names.
  - **Phase 1 (copy), built.** Once per turn, before the turn's first
    `run_command`, the harness brings `~/mike/` up to date over the ssh channel
    it already uses (`backend/src/lib/workstation/files.ts`): a small Python
    receiver in the guest writes new and changed files through a temporary
    name and an atomic rename, and removes anything the user can no longer
    read or that was deleted. Only changes travel, in sessions of about 64 MB.
    The manifest records the version id and size of each path; an entry whose
    file the agent removed or changed is dropped when it is read, so that file
    is sent again. A sync failure does not stop the command; the command's
    result says the documents could not be copied.
  - **Phase 2 (mount).** When the NAS exists, the same tree is a read-only
    mount (virtiofs or NFS) of a per-user view, and the copy step goes away.
    The layout and `out/` do not change, so nothing the agent or a skill does
    changes either.
- **Scope: everything the user can read in Mike.** The same documents the
  web app shows them (`backend/src/modules/workspace/workspace.view.ts`):
  every accessible project's ready documents, plus their own library and
  templates. Sharing and org grants are evaluated by the existing access
  checks at sync time, never inside the VM. Workflow assets stay out.
- **One way back: `save_to_mike`.** A tool with `path`, and optionally
  `filename`, `replace` and `to_library`
  (`backend/src/modules/workspace/workspace.save.ts`):
  - A new file becomes a new document in the chat's project, or in the
    library for a standalone chat or with `to_library`. Creating in a project
    needs edit access there.
  - `replace` names a file under `~/mike/`; the harness resolves it against a
    fresh view of what the user can read, and records a new version of that
    document through the documents module (`storeDocumentFile`) if the user
    can still edit it.
  - Nothing is ingested implicitly. Files left in `out/` without a save stay
    there.
  - Results can be any Mike document type. Plain text (`.txt`, `.md`, `.csv`)
    became a document type for this, so a Markdown summary or a CSV comes
    back as itself; the upload path accepts it too, checked to be UTF-8 with
    no NUL bytes, and the web app shows it in a plain-text viewer.
- **Results show in chat.** Each save is a visible tool result with a link to
  the new document or version, like any generated document.
- **Guests.** In a shared thread whose code runs in the host's workstation,
  a guest gets `run_command` only, gated by the host as before. There is no
  sync and no `save_to_mike` in someone else's workstation: the host's
  `~/mike` holds the host's documents, and a guest's documents never go
  there.

## The boundaries we keep

1. **The VM gets no credentials.** No database, object-storage, NAS-write or
   Mike API token. The harness does every read and write as the user.
2. **Permissions are checked when the harness reads or writes,** never by
   trusting anything from the VM. A publish rechecks write permission at
   publish time; a stale copy never grants write access.
3. **The harness reads back only the regular file a save names,** inside
   `/home/agent`: no symlinks (`O_NOFOLLOW`, and the parent directory's real
   path must stay in the home directory), at most 100 MB, and its bytes must
   be the type its name says (images are re-encoded as uploads are, text must
   be UTF-8, Office and PDF files must start with their signatures).

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

## Staging receipts (2026-10-11), not accepted

The first live turn (chat `11a455a8`, before `df12113e`) saved
`inventory.md` but found no `~/mike`: code-mode turns (`run_python`) never
synced. After `df12113e` deployed (staging deploy of `8cb586f2`), the same
account and model (`opencode-go/glm-5.3-flash`, code mode), sent through
`mike-staging api` on node-a, chat `c8bdc5dd-e56d-40a4-9d35-99618140b16a`:

- `find ~/mike -maxdepth 3` listed `.manifest.json`, `projects/PSNP/` with
  its six documents (four `.docx` reports and briefings, two dated market
  reports, `Tabular Review Pilot - 10 Documents.xlsx`) and `library/` with
  `cliff-walk.jpg` and the earlier `inventory.md`. `ls ~/skills` listed
  `compare-documents`, `draft-from-template`, `extract-key-terms`,
  `proofread` (acceptance 1, and Mission 17's `~/skills`).
- The agent wrote `~/mike/out/workspace-check.md` and saved it with
  `save_to_mike(..., to_library=True)`: `doc_created` for document
  `bedcb34d-4c52-48df-90a1-2e5b12d6d24b`, version 1, read back with
  `read_document` (acceptance 2, library form).
- Defect found: the first `save_to_mike(path="~/mike/out/workspace-check.md")`
  failed with "Could not read ~/mike/out/workspace-check.md: no such file";
  the agent retried with `/home/agent/mike/out/...`, which worked. The guest
  readers joined `~/...` onto the home directory literally. Fixed for
  `save_to_mike` and `save_skill`'s folder path (`READ_FILE`, `READ_TREE` in
  `lib/workstation/files.ts`), with tests.

- Acceptance 3, after the fix deployed (chat `77627889`): the agent copied
  `~/mike/library/workspace-check.md` to `~/mike/out/`, appended a line and
  called `save_to_mike(path="~/mike/out/workspace-check.md",
  replace="/home/agent/mike/library/workspace-check.md")`: "Saved as version
  2 of 'workspace-check.md'" (same document `bedcb34d`). `GET
  /single-documents/bedcb34d-.../versions` lists version 1 (765 bytes) and
  version 2 (796 bytes, current). The `~/` path now works.

Not yet run live: acceptance 4 (share and revoke) needs a second staging
account, and the agent does not create accounts on staging; 5 (two users)
is covered by tests. On 2026-10-11 staging's `auth.users` held one account
(the owner's) and no test accounts, so there is no one to share from. To
run it: the owner signs up a second account on staging (any email they
control), shares a document from it with their main account, and the agent
runs the check turns before and after the revoke.

## Not yet

- A `mike-save` command inside the VM. The tool is enough for the agent; a
  command would need a request file the harness polls for.
- A separate `~/mike/chats/` tree. A standalone chat's attachments are
  library documents, so they are under `~/mike/library/` already.

- The NAS and the phase 2 mount.
- Large libraries: measure the first full copy and the per-turn delta on a
  realistic account before deciding whether phase 1 needs a size cap.
