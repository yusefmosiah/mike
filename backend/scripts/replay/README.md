# Thread replay simulator

Re-runs the owner's prompts from one chat, in order, against a fixed
backend, starting from the world the chat started in, and compares the
result with the original. It exists to check harness fixes against a real
long research and writing thread: did the language switches, empty answers,
broken ask_inputs prompts, repeated sections and tool errors go away, and
what did the fixes do to time and tokens?

The original and the replay share as much state as can be reproduced:

| State | How it is reproduced |
|---|---|
| Prompts, attachments, workflows | `extract` reads them from the chat's `chat_messages` rows, along one branch |
| ask_inputs answers | the replay's k-th pause in a turn gets the original k-th pause's answers, item by item, where they still fit; otherwise skipped |
| Workstation home directory at T0 | `replay-baseline.sh` on node-a builds it from the owner VM and its snapshots and loads it into a pool VM |
| Attached documents | `seed` uploads copies as the simulation account through the upload-session API, so the documents module creates the rows |
| Memory | `seed` writes the owner's memory into the simulation account (current content: `memory_files` keeps no history, so the content at T0 cannot be recovered unless you pass `--memory-file`) |

Everything runs through the same HTTP API and SSE stream the web app uses,
logged in as a dedicated simulation account. Nothing here writes to the
database directly.

## Files

| File | What it is |
|---|---|
| `cli.mts` | entry point: `extract`, `seed`, `run`, `report`, `plan-baseline` |
| `extract.mts` | branch path, turns, original ask_inputs answers and metrics |
| `asks.mts` | mapping original ask_inputs answers onto the replay's pauses |
| `runner.mts` | the replay loop: POST /chat, SSE with resume, ask_inputs continuation, retry, state file |
| `seed.mts` | attachments and memory for the simulation account |
| `client.mts` | cookie or bearer session, SSE reader, upload sessions |
| `metrics.mts` | measurements over stored parts and pi durable entries, duplicate and ask_inputs checks |
| `script.mts` | writing-system detection for the language check |
| `files.mts` | `find -printf` listings, the baseline rule, tree diff |
| `report.mts` | comparison, Markdown and JSON |
| `replay-baseline.sh` | node-a script that builds and loads the T0 home directory |

Run everything from `backend/` with Node 22.18 or newer (type stripping is on
by default; on 22.6 to 22.17 add `--experimental-strip-types`).

## 0. Export the original thread

On the deployment's database (read-only queries). Replace `:chat` with the
chat id.

```sql
-- The chat's messages: every branch; extract picks one.
\copy (select json_agg(json_build_object('id', id, 'parent_message_id', parent_message_id, 'role', role, 'content', content, 'files', files, 'workflow', workflow, 'created_at', created_at) order by created_at) from public.chat_messages where chat_id = :'chat') to 'msgs.json'

-- The chat's pi conversation lineage (needed to pick its model calls out of
-- the entries table when other chats ran at the same time).
\copy (select record from pi_durable.documents where kind = 'mike.chat' and key_value = :'chat' and retired_at is null order by created_at desc limit 1) to 'lineage.json'

-- Conversations: the lineage and the subagents its turns started.
\copy (select json_agg(json_build_object('id', id, 'r', record::json)) from pi_durable.conversations) to 'convs.json'

-- Model calls, compactions and tool results of those conversations
-- (list the lineage ids and their subagent conversations).
\copy (select json_agg(json_build_object('id', id, 'conv', conversation_id, 'r', record::json) order by id) from pi_durable.entries where conversation_id = any(:'ids'::bigint[])) to 'entries.json'
```

The entries are optional: without them the report still compares
`turn_usage` input/output/cost, tools, errors and answers, but not model
calls, cached or reasoning tokens, compactions, or the original's wall time.

## 1. extract

```sh
node scripts/replay/cli.mts extract --messages msgs.json --out thread.json \
  [--leaf <message-id>] [--entries entries.json --convs convs.json --conversations lineage.json]
```

- `--leaf`: the last message of the branch to replay; default the newest
  message nobody answered.
- `--conversations`: a comma list of conversation ids, or the lineage JSON;
  subagent conversations they own are added from `--convs`.

`thread.json` holds T0 (the first prompt's time), the ordered prompts with
attachments and workflows, each turn's original ask_inputs and answers, and
the original metrics. Model calls are split into turns by time: a turn runs
from its first answer row to the next prompt on any branch, and a
regenerated (off-path) answer under the same prompt ends it.

## 2. The simulation account and its VM

1. Create a dedicated account on the deployment and give it a password. Its
   email decides how its VM is handled (`backend/src/lib/workstation/config.ts`):
   a `+test` local part or a reserved domain makes it a *temporary* account,
   whose pool VM is wiped after `WORKSTATION_TEMPORARY_IDLE_MINUTES` (120) of
   idleness, and taken back after 15 minutes idle when the pool is short. A
   long replay with `--delay-ms` or a pause between steps can lose its files
   that way.
2. A pool VM is assigned lazily on the account's first turn
   (`workstation_assignments`). The baseline has to be in the VM before that
   turn, so assign it up front, after `ws wipe <vm>`, with an operator
   insert (temporary = false keeps the idle sweep away from it):

   ```sql
   insert into public.workstation_assignments (vm, user_id, temporary)
   values ('ws-03', '<simulation user id>', false);
   ```

   Remove the row (and `ws wipe ws-03`) when the replay is finished.
3. The runner reads its credentials from the environment and never prints
   them:

   ```sh
   export MIKE_URL=https://<web app origin>       # API at $MIKE_URL/api unless MIKE_API_BASE is set
   export MIKE_SIM_EMAIL=... MIKE_SIM_PASSWORD=...  # or MIKE_SIM_TOKEN (bearer)
   export MIKE_OWNER_EMAIL=... MIKE_OWNER_PASSWORD=...  # only for seed --owner
   ```

## 3. Baseline home directory (node-a, root)

```sh
replay-baseline.sh --t0 2026-10-11T19:52:37Z --exclude-chat <chat-id> --dry-run
replay-baseline.sh --t0 2026-10-11T19:52:37Z --exclude-chat <chat-id> --out /root/baseline.tgz --load ws-03 --wipe
```

Per regular file or symlink under `/home/agent`: the owner VM's current copy
if its mtime is before T0; else the copy in the newest snapshot taken before
T0 (`ws snapshots ws-owner`; its `home.img` is attached read-only through a
loop device and mounted `ro,noload`); else nothing. `.cache`, `.npm`,
`node_modules` and `~/.mike/kernels/<chat-id>*` of the replayed chats are left
out (`--all-kernels` drops every kernel snapshot). The owner VM is only read
(`find` and `tar -c` over `ws ssh`). `--load` refuses anything but a pool VM,
and `--wipe` runs `ws wipe` on it first. `--dry-run` prints
`source<TAB>size<TAB>path` for every included file, then the absent and
excluded paths, and stops.

`node scripts/replay/cli.mts plan-baseline --current cur.txt --snapshot snap.txt --t0 <iso>`
computes the same selection from two listings, for checking a dry run.

Blind spots: a file created after the snapshot and deleted after T0 is
missing, and a file changed both between the snapshot and T0 and again after
T0 comes back in its snapshot version.

## 4. seed

```sh
node scripts/replay/cli.mts seed --thread thread.json --out seed.json \
  [--attachments-dir attachments/] [--owner] [--memory-file memory-at-t0.md | --no-memory] \
  [--workflow-map workflows.json]
```

- Attachments: looked up in `--attachments-dir` as `<version_id>`,
  `<document_id>` or `<filename>`; with `--owner`, missing ones are
  downloaded as the owner from `GET /single-documents/:id/file?version_id=`.
  To copy them from storage instead, list them with
  `select id, document_id, filename, storage_path from public.document_versions where id = any(...)`
  and save each object as `attachments/<version_id>`.
- Memory: `--memory-file`, else the owner's current memory with `--owner`.
- Workflows: prompts that applied a workflow carry its id. A
  `--workflow-map` file `{"<original id>": {"id": "...", "title": "..."} | null}`
  maps it to one the simulation account can use (null drops it); unmapped ids
  are sent as they are unless `run --drop-unmapped-workflows`.

Re-running `seed` with the same `--out` skips what is already seeded.

## 5. run

```sh
node scripts/replay/cli.mts run --thread thread.json --seed seed.json --out replay-<model>/ \
  --model <model id> --reasoning high --time-zone America/New_York \
  [--from N] [--until N] [--delay-ms 5000] [--retry] [--autocompact 120000] [--max-ask-rounds 5]
```

For each prompt: read the chat back (`GET /chat/:id`) for the history the web
app would send, `POST /chat` with the prompt and its seeded attachments, read
the SSE stream to `[DONE]` (resuming from the last frame id on a dropped
connection, as the web app does), then answer any ask_inputs pause with the
mapped original answers and the same user text the web app sends. `--retry`
answers a failed prompt once more through the regenerate path (`POST
/chat/:id/leaf`, then `link_only_to_message_id`). `--autocompact` calls
`PUT /user/autocompact {model, tokens}` first and carries on if the
deployment does not have it.

Output directory:

| File | Contents |
|---|---|
| `state.json` | chat id, model, next turn, completed and failed turns; a second `run` on the same `--out` resumes from it (a different model or reasoning level is refused) |
| `run.json` | what was run against what |
| `turn-NNN.json` | per turn: status, timings, attempts (HTTP status, turn and message ids, errors, reconnects), ask_inputs answers sent, attachments that could not be sent, and the stored assistant rows |
| `turn-NNN.<attempt>.frames.ndjson` | every SSE frame, with its id and ms since the attempt started |
| `docs/` | documents the replay created or edited (`--no-download-docs` to skip) |

The prompts carry the replay's send time, not the original's; the history is
the stored transcript, as after a reload, so the ask_inputs answer texts of
earlier turns are not in it (they are not stored as messages).

## 6. Final file trees

```sh
ws ssh ws-owner "find /home/agent -mindepth 1 -printf '%y\t%T@\t%s\t%P\n'" > original-final.txt
ws ssh ws-03    "find /home/agent -mindepth 1 -printf '%y\t%T@\t%s\t%P\n'" > replay-final.txt
```

For the original's state at the end of the thread rather than today, list a
snapshot taken just after it instead (mount as in step 3).

## 7. report

```sh
node scripts/replay/cli.mts report --thread thread.json --replay replay-<model>/ --out report-<model>/ \
  [--replay-entries entries-replay.json --replay-convs convs.json --replay-conversations lineage-replay.json] \
  [--original-tree original-final.txt --replay-tree replay-final.txt --exclude-chat <id>] \
  [--original-docs original-docs/]
```

Writes `report.md` and `report.json`: totals and per-turn wall time, model
calls, input/cached/output/reasoning tokens, compactions, cost, code cells
(failed, or printed a traceback), failed subagents, MCP errors, error parts
and stream failures, empty answers, answers or reasoning in a different
script from the prompt (CJK or Cyrillic in an answer to an English prompt),
ask_inputs prompts that make no sense (one option, generic question,
identical items), repeated headings or paragraphs in answers and in
`.md`/`.txt` documents, and the file-tree diff (paths only on one side, and
size changes; caches and kernel snapshots ignored). The replay's model calls
come from its own entries export, split by each turn's start and end time.

## Tests

```sh
npm test -- scripts/replay          # from backend/
npx tsc -p scripts/replay           # type-check
```

The tests cover branch extraction, ask_inputs mapping, script detection,
the metrics and report diff, listing parsing, the baseline rule (including
agreement between `files.mts` and `replay-baseline.sh --select`), the SSE
reader, and the runner against a fake API (ask_inputs continuation and a
dropped, resumed stream).
