# Pi Durable's PostgreSQL storage (vendored)

The `Storage` that chat turns run on (`runtime.mts` opens it in the
`pi_durable` schema). It is
[`j-koester/pi-durable-postgres`](https://github.com/j-koester/pi-durable-postgres)
(npm `@netzlabor/pi-durable-postgres`, MIT, see `LICENSE`), ported to Pi
Durable 1.4.0. The published 0.2.0 supports only Pi 1.1: it imports
`StorageRejected`, which Pi 1.2 removed, and its `tasks` table cannot hold
the `sleeping` status Pi 1.4 stores.

The port is upstream's `main` (`e66d502`) plus one commit, offered back as a
pull request:

- schema version 2 adds `sleeping` to the `tasks` status check, in place;
- invalid read requests throw `StorageRequestError` and a rejected document
  copy a plain `Error`, as in Pi's SQLite storage.

The files here are that commit's `src/` with `.ts` renamed to `.mts` (the
backend is CommonJS; Pi is ESM only), relative imports to `.mjs`, and `<T,>`
on generic arrow functions. `delete.ts` (maintenance deletion) and the index
files are left out; nothing uses them. Keep upstream's formatting so the files
still compare with it.

Schema version 2 is one way: once the backend has opened the schema, a build
on Pi 1.3 or earlier (or the npm 0.2.0 adapter, which refuses a newer schema)
cannot open it.

Once upstream releases a version for Pi 1.4, depend on it again and delete
this directory.

Checks: Pi's storage conformance suite and the crash and sleep spikes in
`src/durable/spike/`; `backend/scripts/test-stack.sh` runs the conformance
suite against the stack's Postgres.
