# Code mode, deep research: performance, memory, security, RLM and overnight runs (2026-10-10)

This is a reference document for the owner. It follows the earlier note
[`code-mode-research-2026-10-10.md`](code-mode-research-2026-10-10.md) and the
VM work in [`../../goals/mission-13-workstation-vms.md`](../../goals/mission-13-workstation-vms.md).
The design is settled: code mode is required, each employee has a persistent
Cloud Hypervisor microVM, the harness stays outside, and a persistent CPython
kernel per conversation speaks a JSON-lines protocol with `host_request` /
`host_reply` frames. This report does not reopen those decisions. It tests them
against what is known, and lists what to build now.

Labels used below: **[vendor]** means the number comes from the people selling
the thing. **[unverified]** means I could not confirm it from a primary source.
**[estimate]** means it is my own reasoning, not a measurement. Dates are as
published.

## Summary of the most important conclusions

1. **The microVM design is sound, but two things need action this week.** Cloud
   Hypervisor had two serious virtio-block bugs in 2026. CVE-2026-27211 lets a
   guest read arbitrary host files when it can write its own raw disk image
   (affects v34.0 to v50.0). CVE-2026-45782 is a guest-triggered use-after-free
   in async block I/O (affects v21.0 to v51.1, async I/O is the default). Mike's
   employee VMs use a guest-writable raw home disk. Confirm that node-a runs
   Cloud Hypervisor v52.0 or later (or v51.2 / v50.1 as minimum), run the VMM
   as an unprivileged user per VM, and turn on Landlock.
2. **The lethal trifecta is real here and cannot be filtered away.** Code mode
   with private data, web content and email sending has all three legs. Defences
   that rely on a model to detect injection fail against adaptive attackers (the
   "Attacker Moves Second" paper broke 12 published defences, most above 90%).
   What holds is architectural: remove a leg, or gate it deterministically. For
   Mike the cheapest strong measures are (a) an outbox with human approval for all
   email, (b) an egress mode that follows the data (open web while no private data
   is loaded; allowlist only after), (c) a run-level taint bit set by any untrusted
   fetch, which forces approval on outbound tools, and (d) treating every frame
   and file from the VM as hostile input.
3. **Code mode needs no heavy transport engineering.** A persistent ssh session
   over vsock plus JSON-lines frames will add well under a few milliseconds per
   `host_request` [estimate, to be measured]. Tool work, model calls and imports
   dominate. Keep bytes out of frames: pass references, and move files on a
   separate channel.
4. **Memory is the real operational risk.** A long-lived kernel plus pandas will
   grow and glibc will not give memory back. Put each kernel in its own cgroup
   with `MemoryHigh` below `MemoryMax`, protect sshd and the supervisor, and
   expect OOM kills as a normal event that the supervisor reports and recovers
   from. Use DuckDB (not pandas) for anything over a few GB; it has the strongest
   independent record for larger-than-memory work. Do not oversubscribe VM RAM in
   the demo.
5. **Harvey's RLM work is real but is research, not a confirmed product.** Harvey
   published "Post-Training RLM Agents for End-to-End M&A Diligence" on
   2026-09-08 (with Baseten). Primary source read. An RLM harness took seven base
   models from 23.3% to 62.4% of rubric criteria on 50 synthetic data rooms
   (self-reported). The post does not say this is deployed to customers. It also
   shows the limits: cost rose for six of seven models, depth-2 recursion cut the
   pass rate by 19 points, and the best open-model results came after
   fine-tuning or RL on the harness.
6. **Prepare for RLM now with a small set of APIs.** Context as variables on
   disk, `llm()` / `llm_batch()` that run tool-less sub-completions in the
   harness, a hard depth of 1, a harness-side budget ledger, a `SUBMIT` protocol,
   and a trace tree. Mike already has Pi Durable, subagents (Mission 9) and
   per-turn spend rows, so most of this is wiring.
7. **Long overnight runs fail quietly.** Plan for compaction that drops
   constraints, retry loops, premature "done" claims, and half-written outputs.
   Use a progress file plus a structured task list the agent cannot edit freely,
   idempotency keys on every side-effecting `host_request`, heartbeats, and a
   morning report that includes an undo path (the pre-run snapshot).
8. **Verification without shadow mode is feasible.** Build three layers: a
   deterministic replay of recorded model output through the real harness
   (tests the plumbing), scripted tasks with checkers run four times each (report
   pass^k, not just pass@1), and fault and attack injection (kill the kernel, OOM,
   plant canary secrets and injected instructions).
9. **One thing the earlier note assumed is not evidenced.** "Every model we use
   writes Python well" has no data for the flash models. The one study of
   programmatic tool calling tested 14 closed models and no open-weight model.
   Three older or smaller closed models collapsed for a mechanical reason
   (literal `\n` in code). The eval should include a code-mode smoke test per
   model before any model is enabled.

---

## 1. Performance

### 1.1 What is known

**Kernel start and per-cell overhead.** I found no published benchmark that
compares a JSON-lines CPython runner with ipykernel. The mechanics are clear:

- Interpreter start is tens of milliseconds for bare CPython [estimate]. One
  paper quotes "600 ms up to multiple seconds" for Python start in a notebook
  context, which includes imports ([paper](https://git.odin.cse.buffalo.edu/ODIn/paper-ParallelPython-Short/blame/commit/8b30a85a7e5c0be222afdc3384cf5989af5302a2/sections/experiments.tex),
  indirect source).
- Library imports dominate. `import pandas` or `pyarrow` costs hundreds of
  milliseconds on a normal machine [estimate]; the cost is paid once per process.
  `python -X importtime` gives exact numbers on the real guest.
- ipykernel adds IPython, ZeroMQ and Tornado, a connection file and a handshake.
  OMP and Prime Agent both dropped Jupyter for a small JSON-lines runner for this
  reason ([OMP](https://github.com/can1357/oh-my-pi),
  [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent); details in the
  earlier note).
- Per-cell overhead in a persistent runner is compile plus exec plus one JSON
  frame: well under a millisecond [estimate].

**Protocol facts worth copying.** Prime Agent's `repl.md`
([raw](https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/prime-agent-runtime/src/rlm/repl.md))
is the best written spec I found:

- One JSON object per line, UTF-8, no other framing.
- Events go out on a private duplicate of the original stdout. Raw fd 1 and 2
  output becomes `stdout` / `stderr` events with `id: null`, so stray prints
  cannot break framing.
- Requests: `execute`, `interrupt`, `host_reply`, `snapshot`, `restore`,
  `list_names`, `shutdown` and a few others. Events: `ready` (carries
  `"protocol":3`), `stdout`/`stderr`, `result`, `display`, `host_request`,
  `error`, `done`. Each request gets exactly one `done`, sent last.
- `host_reply` is routed on the reader thread, not the request queue, so a cell
  that is blocked awaiting a reply can still receive it. Replies for unknown or
  cancelled ids are dropped.
- Caps: 64 Ki chars per stdout frame (split into ordered events), 1 Mi chars for
  a `result` repr, and 16 Mi chars of JSON for `display` and `host_request`
  payloads. Oversized payloads raise `ValueError` in the cell.
- Interrupt is SIGINT; the runtime survives it. Closing stdin equals `shutdown`.

**`host_request` round trip over ssh over vsock.** No measured number exists for
this stack. The parts are:

- virtio-vsock itself: a 2024 kernel patch reports per-message latency of about
  10 to 41 microseconds before/after an optimisation, on a nested QEMU setup
  ([kernel commit](https://gitlab.freedesktop.org/drm/misc/kernel/-/commit/efcd71af38be403fa52223092f79ada446e121ba)).
  Throughput there was 29 to 39 Gb/s at 64K buffers. Bare metal should be no worse.
- Cloud Hypervisor's vsock is stream-only and goes through a host UNIX socket
  (`CONNECT <port>` handshake once per connection)
  ([vsock docs](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/vsock.md)).
  Mike's `vsockProxy.js` already does this.
- ssh adds encryption and channel framing. A fresh ssh connection costs 150 to 500
  ms on a fast network ([TechRepublic summary](https://www.techrepublic.com/article/how-to-use-multiplexing-to-speed-up-the-ssh/);
  one test: 0.66 s plain vs 0.03 s multiplexed,
  [Wikibooks](https://en.wikibooks.org/wiki/OpenSSH/Cookbook/Multiplexing)). A
  frame over an already open session pays none of that.
- **Design consequence:** the harness should hold one long-lived ssh channel per
  kernel (stdin/stdout of the supervisor) rather than spawning an ssh process per
  cell. Then a `host_request` is: Python writes a line, sshd forwards bytes, the
  harness parses JSON, runs the tool, and writes a reply. My estimate is 0.2 to
  2 ms of transport overhead [estimate]. Everything else (DB queries, document
  reads, model calls) is larger by one to four orders of magnitude.

**JSON vs msgpack.** I found no rigorous msgpack-vs-orjson benchmark on large
payloads. What exists:

- On a 77 MiB JSON file, orjson decoded in about 692 ms, stdlib `json` 869 ms,
  and msgspec (typed) 177 ms ([msgspec benchmarks](https://jcristharif.com/msgspec/benchmarks.html),
  author's own).
- Vendor blogs claim msgpack is 3 to 5 times faster than stdlib json, and that
  orjson narrows the gap to 1.2 to 1.5 times
  ([MessagePack vs JSON](https://abacktools.com/blog/messagepack-vs-json), [unverified]).
- The harness is Node/TypeScript. `JSON.parse` in V8 is heavily optimised; msgpack
  libraries for JS are usually not faster for small objects [unverified, general
  knowledge].
- The real fix for large payloads is not a format. Prime caps `host_request`
  payloads at 16 Mi chars and caps `display` the same way. Base64 inflates binary
  by 33% and doubles memory in the JSON parser. **Do not put file bytes in frames.**

**Moving large files and documents (harness, VM, object storage).**

- Frames carry references: `{"document_id": ..., "path": "~/in/doc.pdf"}`.
- Bytes go over a separate ssh/vsock stream (for example `ssh vm 'cat > file'` or
  tar over a second channel) with a size limit, a sha256 check and an atomic rename.
  A plain OpenSSH channel is limited by its channel window and cipher cost, not by
  vsock. A 2017 FreeBSD study found that on fast LANs, ssh throughput is bounded by
  the MAC/cipher, with AES-GCM and AES-NI best
  ([paper](https://papers.FreeBSD.org/2017/bsdcan/jude-ssh_performance.files/Paper_-_SSH_Performance.pdf)).
  A 2026 openssh-dev thread shows large window sizes can hurt some receivers
  ([thread](https://lists.mindrot.org/pipermail/openssh-unix-dev/2026-April/042440.html)).
  Expect hundreds of MB/s at best; measure it.
- Object storage in Mike is private. The proxy blocks private ranges, so the VM
  cannot fetch a presigned URL. Either allow one named internal object-storage
  endpoint in the proxy for the VM (Mission 13 already lists "allowlisted internal
  services"), or push/pull through the harness. For the demo, push/pull through
  the harness is simpler and keeps the VM unable to reach any internal service.

**Cloud Hypervisor boot and overhead.** The sources conflict and come from one
vendor. Firecracker's paper reports under 5 MB overhead and about 125 ms boot;
a vTPM paper puts Cloud Hypervisor around 13 MB overhead against Firecracker's 3
MB; Northflank's own pages give Cloud Hypervisor boots from under 100 ms to about
200 ms ([Northflank](https://northflank.com/blog/firecracker-vs-cloud-hypervisor),
[Putting a Padlock on Lambda](https://arxiv.org/pdf/2310.03522), vendor/mixed).
Mike's own receipt is more useful: a restore including VM restart took 17.6 s
(Mission 13). For persistent employee VMs, boot time matters only after a restore
or crash. It does not matter per turn.

**virtio-blk vs virtio-fs for working data.**

- virtio-blk is a thin device. A virtio-fs developer wrote that "virtio-blk is
  generally much faster than virtiofs" ([mailing list](https://listman.redhat.com/archives/virtio-fs/2022-July/005068.html)).
  virtio-fs is a full file server on the host and pays a per-request cost.
- Cloud Hypervisor's virtio-fs needs the `virtiofsd` daemon (needs `cap_sys_admin`),
  requires `--memory shared=on`, defaults to `cache=never`, and **DAX is not
  available** ([fs.md](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/fs.md)).
  The DAX gains in the original virtio-fs patch series (162 to 894 MiB/s sequential
  read) therefore do not apply ([LKML](https://lkml.iu.edu/hypermail/linux/kernel/1908.2/05325.html), QEMU-era numbers).
- **Use virtio-blk for home and scratch.** Use virtio-fs only for a read-only
  share the host must control (see 1.2).
- Snapshot caveat: Mike snapshots a raw image with btrfs. Disks with `nodatacow`
  lose checksums and compression, and a snapshot forces COW on the first write to
  each shared block, which fragments the image over time
  ([libvirt thread](https://listman.redhat.com/archives/libvir-list/2020-July/205116.html),
  [Rockstor](https://forum.rockstor.com/t/vm-storage-nodatacow/556), practitioner reports).
  Keep scratch (DuckDB spill, downloads, caches) on a **separate disk that is not
  snapshotted**, so per-turn snapshots stay small and fast.

### 1.2 How VMs should read a NAS of terabytes

Options, from the least to the most capable:

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Harness-mediated | `tools.read_file(nas_path)` via host_request | No new attack surface; permissions enforced per call | Too slow and heavy for TB-scale scans |
| B. Host mounts NAS (NFS, read-only), shares a per-VM subtree by virtio-fs read-only | Host decides what each VM sees | Permission boundary is host-side; guest has no network path to the NAS | virtiofsd per VM; no DAX; virtio-fs per-request cost; extra daemon with `cap_sys_admin` |
| C. Guest mounts NFS directly, read-only, with an nftables pinhole to the NAS IP:2049 only | Fast, simple, standard tools | Guest needs a network path to the NAS; NFS (AUTH_SYS) trusts the client's uid; a compromised guest can claim any uid | Must export read-only, to that guest IP only, a subtree it may see |
| D. Pre-process on the host side | Indexer job (harness side) converts files to Parquet and embeddings; the VM reads results | Heavy work stays out of the VM | More code |

Key points:

- **Permissions are a legal issue, not only a technical one.** A law firm has
  ethical walls and conflict screens. If every VM can see the whole NAS, a prompt
  injection or a careless agent in one employee's VM can read a walled matter. The
  NAS view per VM must match what that employee may see in Mike. This favours B or
  A+D, or C with per-employee exports (which depends on what the NAS can do).
- **Read-only is the supported case for DuckDB.** The DuckDB docs say NAS can
  serve read-only workloads and warn against read-write on NAS
  ([DuckDB environment guide](https://duckdb.org/docs/current/guides/performance/environment)).
  Row groups of 100K to 1M rows parallelise best; several Parquet files help on a
  network mount; heavy gzip adds decode CPU
  ([DuckDB file formats](https://duckdb.org/docs/lts/guides/performance/file_formats.html)).
- **NFS vs SMB.** Only an old, informal test exists (2014 kernel list: SMB3 about
  199 MB/s vs NFS 110 to 116 MB/s on one setup, [LKML](https://lkml.rescloud.iu.edu/1407.2/00001.html))
  and it is not about guests. NFS is the natural fit for Linux guests. Mount
  options to try: `ro,nosuid,nodev,noexec,noatime`, NFSv4.1, `nconnect=8`; note
  `nconnect` and Kerberos do not mix on some servers
  ([Google NetApp guide](https://docs.cloud.google.com/netapp/volumes/docs/connect-clients/linux-nfs-mount-options)).
  Use `hard` mounts so a NAS blip cannot return short reads silently.
- **Consistency over a night.** Files change while a run reads them. Export a
  read-only NAS snapshot per run if the NAS supports it, and record its id in the
  run trace.
- **Network path for C breaks the "no route out except proxy" rule.** The pinhole
  must be NAS:2049 (and mountd/portmap if NFSv3) only. NFSv4 needs one port.

### 1.3 Vector database access from the VM

- The VM should not hold database credentials or have a route to the harness
  Postgres or a vector server. Expose `tools.vector_search(collection, query,
  filters, k)` as a `host_request`. The harness applies the user's matter ACL as a
  filter, embeds the query, and returns text, ids and scores.
- Results are small (k times a few KB). If a task needs to scan millions of
  vectors, run it in the harness as a job, not in the VM.

### 1.4 CPU and IO contention with several overnight jobs

- **CPU:** give each VM a fixed vCPU count (Mike uses 4). Put each Cloud
  Hypervisor process in its own systemd unit with `CPUWeight` so a busy VM cannot
  starve the harness, Postgres or the proxy. Inside the VM, tell DuckDB and
  Polars the thread count to match vCPUs.
- **Disk:** Cloud Hypervisor has a token-bucket disk rate limiter. Two caveats
  from its docs: a drained bucket triggers a fixed 100 ms cool-down, so keep
  `refill_time` above 100 ms; and limits can be applied to a group of disks
  ([io_throttling.md](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/io_throttling.md)).
  I could not confirm how well cgroup io weights work with btrfs on md RAID1
  [unverified]. Test with two simultaneous DuckDB spills.
- **Scheduling:** the simplest real control is a concurrency cap in the job queue
  (dbq): for example at most two heavy overnight runs per host. Stagger starts.
- **Question to answer:** the md RAID1 devices on node-a: HDD or SSD? Spill
  directories and snapshots behave very differently on each. I could not tell from
  the repo.

### 1.5 Python 3.13 / 3.14 free-threading and subinterpreters

- Python 3.14 supports the free-threaded build officially but as opt-in. Reported
  single-thread cost is about 5 to 10% (down from about 40% in 3.13), and
  15 to 20% more memory
  ([Cloudsmith summary](https://cloudsmith.com/blog/python-3-14-what-you-need-to-know.md);
  figures vary by source). Importing a C extension that does not declare thread
  safety silently re-enables the GIL
  ([Register](https://theregister.com/software/2025/10/08/python-314-released-with-cautious-free-threaded-support/349336)).
- `InterpreterPoolExecutor` exists in 3.14. One practitioner report found a
  subinterpreter workload slower than expected, citing "sharp edges"
  ([blog](https://scour.ing/@blake.rain/p/https://blog.changs.co.uk/i-was-wrong-about-subinterpreters.html), anecdote).
- **Neither helps Mike.** The data stack (DuckDB, Polars, pyarrow, numpy) already
  uses native threads and releases the GIL. For isolation use processes. Note
  that 3.14 changed the default multiprocessing start method on Linux to
  `forkserver`; code that relied on `fork` with unpicklable callables now fails
  ([docs](https://docs.python.org/3.14/library/multiprocessing.html)). The model's
  code should expect this. Stay on the standard build.
- **One useful 3.14 feature:** `sys.remote_exec(pid, script)` / `python -m pdb -p
  PID` lets the supervisor inspect or interrupt a stuck kernel
  ([PEP 768](https://peps.python.org/pep-0768)). It needs ptrace permission
  (Yama), so the supervisor would run as the same user.

### Recommendation for Mike (performance)

**Now (functional demo)**
- Hold one long-lived ssh channel per kernel; do not spawn ssh per cell.
- JSON-lines with Prime's framing, 16 Mi cap per frame, and no file bytes in frames.
- Write a 100-line micro-benchmark and record numbers on node-a: kernel cold start
  (bare and with pandas/duckdb/pyarrow imported), no-op cell, echo `host_request`
  at 1 KB / 1 MB / 16 MB p50 and p99, and a 1 GB file push and pull.
- Put scratch on its own disk, excluded from snapshots.
- Update Cloud Hypervisor (see section 3.6).

**Soon**
- NAS read-only: start with option C on a per-employee read-only export or B if
  the host can mount NFS; add the "NAS snapshot id" to the run trace.
- Concurrency cap for heavy runs; `CPUWeight` per VM unit.
- `tools.vector_search` as a host request; no DB credentials in the VM.

**Later (NFR pass / RLM)**
- Disk rate limits and io weights tuned from measurements.
- A dedicated indexer VM (read-only NAS, no egress) for embedding and Parquet
  conversion.
- Revisit msgpack only if profiling shows frame parse cost.

---

## 2. Memory

### 2.1 Long-lived kernels grow

- **glibc does not return all freed memory.** Mid-sized blocks stay in the heap;
  fragmentation pins pages; per-thread arenas add more
  ([Python bug tracker](https://bugs.python.org/msg316359),
  [discuss.python.org](https://discuss.python.org/t/using-malloc-trim-to-help-with-memory-management/107682)).
  Reported mitigations, all anecdotal: `MALLOC_ARENA_MAX=1` (with a speed cost),
  `malloc_trim(0)` after big jobs, `LD_PRELOAD` jemalloc, lower `MALLOC_MMAP_THRESHOLD_`
  and `MALLOC_TRIM_THRESHOLD_`. `malloc_trim` does nothing for memory held by Rust
  allocators (Polars) and must not be combined with jemalloc.
- **The practical answer is cheap restarts, not tuning.** With dill snapshots and
  big data held on disk (Parquet/Arrow), a kernel restart loses little. Restart
  the kernel when RSS passes a threshold between cells, or at the start of each
  overnight "phase".
- Measure before tuning: `tracemalloc` / `memray` for Python objects, and
  `malloc_info` for the C heap.

### 2.2 pandas vs Polars vs DuckDB vs Arrow for data larger than RAM

- **DuckDB** supports larger-than-memory by spilling blocking operators
  (large GROUP BY, joins, sorts, windows) to `temp_directory`. Default
  `memory_limit` is 80% of RAM. It is a soft limit, not a cap on process RSS.
  Some aggregates (`list()`, `string_agg()`) cannot spill. `preserve_insertion_order=false`
  helps large imports. Spill can write far more than the input size
  ([DuckDB memory management](https://duckdb.org/2024/07/09/memory-management.html),
  [tuning guide](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)).
  Put the spill directory on fast local scratch, not on the NAS, and set
  `max_temp_directory_size`.
- **Polars** has a streaming engine. Its own PDS-H benchmarks show it similar to
  DuckDB at SF10 and better than its in-memory engine at larger scale
  ([Polars benchmarks](https://www.pola.rs/posts/benchmarks/), vendor). Independent
  tests favour DuckDB on peak memory: one author's test had DuckDB group 300M rows
  in 440 MB RSS where Polars needed 10.5 GB and streaming was OOM-killed on a
  distinct count ([article](https://python.plainenglish.io/i-gave-a-16-gb-mac-a-26-gb-dataset-duckdb-answered-in-440-mb-of-ram-58db5f5acd4b),
  single author); Coiled found DuckDB faster on single-machine TPC-H and more so as
  scale grew ([Coiled](https://docs.coiled.io/blog/tpch)). One source claims Polars
  2.0 shipped on 2026-10-06 with streaming as default; I could not confirm it
  ([article](https://ecosistemastartup.com/polars-2-0-streaming-por-defecto-y-sql-nativo/), [unverified]).
- **pandas** holds everything in RAM, typically several times the file size.
  Acceptable for under a few hundred MB; wrong default for filings-scale data.
- **Arrow / Parquet** are the interchange. Convert CSV to Parquet once, with row
  groups of 100K to 1M rows.
- **Rule for the system prompt:** "Use DuckDB for anything over 500 MB or any
  data on the NAS; load results into pandas only after aggregation."

### 2.3 cgroup limits inside the VM, OOM behaviour and recovery

- `MemoryMax` is a hard ceiling; breaching it makes the kernel OOM killer act
  within that cgroup. `MemoryHigh` throttles and applies reclaim pressure but never
  kills, and "under extreme conditions the limit may be breached". Set `MemoryHigh`
  at 80 to 90% of `MemoryMax`. With no swap, `memory.high` may fail to contain
  growth ([kernel throttling patch](https://android-kvm.googlesource.com/linux/+/0e4b01df865935007bd712cbc8e7299005b28894);
  [summary of systemd settings](https://stackharbor.com/en/knowledge-base/systemd-oomd-memory-pressure-tuning/)).
- `systemd-oomd` kills by memory pressure (PSI), which catches thrashing the kernel
  OOM killer misses. It acts only on cgroups with `ManagedOOMMemoryPressure=kill`.
  Kubernetes mostly avoids `memory.high` because of throttling behaviour [secondary].
- **Recommended guest layout:** run the kernel as a systemd service in its own
  slice (`MemoryHigh`, `MemoryMax`, `MemorySwapMax` not zero if zram exists,
  `OOMPolicy=kill`), and `sshd` and the supervisor in a protected slice with
  `OOMScoreAdjust=-900` or lower. Give the guest a small zram swap.
- **Supervisor behaviour on kernel death:** report a `kernel_exit` event with the
  reason (OOM-killed, signal, timeout), then restart, restore the last dill
  snapshot and tell the model plainly: "The kernel was killed for memory. Variables
  restored from the snapshot at cell N. Cell N+1 was not applied." Log the
  `memory.events` counters (`high`, `oom_kill`).
- A runaway cell must not take the VM down. The host-side boundary is the VM's RAM
  size; set `MemoryMax` for the kernel to about 70% of VM RAM.

### 2.4 dill snapshot sizes and pitfalls

From Prime's protocol: names are serialised one by one; names starting with `_` and
system names are skipped; oversized names are skipped or pruned; the write is
atomic with a JSON manifest; restore revives names independently and lists
failures. Pitfalls to expect:

- **dill cannot pickle live OS resources** (open files, sockets, DB connections,
  threads, locks) and some frames/generators ([dill notes](https://sources.debian.org/src/dill/0.2.9-1/README.md/),
  old README). The model will hold DuckDB connections and HTTP sessions; after a
  restore they are gone. Teach the model: "keep handles in functions, keep data in
  files."
- **Size.** A DataFrame variable can be gigabytes and take tens of seconds to
  dump. Snapshot at turn boundaries only, with a per-name cap (Prime has one), and
  encourage writing large frames to Parquet instead. Arrow/Parquet on disk is a
  better "variable" for RLM anyway.
- **By-value functions and classes from `__main__`** are pickled by value, which is
  an advantage but ties the snapshot to the same dill and Python version. Pin both
  in the Nix image. A snapshot made by one image may not restore in the next.
- **Restoring a pickle executes code.** Only the VM that made it should read it.
  The harness must never unpickle anything from the VM.
- Never snapshot anything that holds a secret. There should be none in the VM, but
  the model may paste keys into variables (for example a user's API key from a
  document). Scan snapshots for secrets at the harness boundary if they are ever
  exported.

### 2.5 Sizing many VMs on one host

Known facts for Cloud Hypervisor:

- **Balloon:** `size`, `deflate_on_oom` (off by default; lets the guest shrink the
  balloon to zero to survive OOM), and `free_page_reporting` (off by default; the
  guest reports freed pages, works with `size=0`)
  ([balloon.md](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/balloon.md)).
- **Memory options:** `mergeable` (KSM, off by default, needs host KSM), `hugepages`
  (needs pre-allocation, overrides `shared` and `thp`), `shared`, `prefault`, `thp`
  (default), `reserve` (fail at creation if over-committed, instead of a `SIGBUS`
  later), and virtio-mem hotplug
  ([memory.md](https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/memory.md)).
  By default an over-committed host can kill a guest with `SIGBUS`.
- v52.0 (2026-05-14) adds per-zone `mergeable`, userfaultfd lazy restore
  (`memory_restore_mode`), sparse memory snapshots, and balloon size validation
  ([release notes](https://www.cloudhypervisor.org/blog/cloud-hypervisor-v52.0-released/)).

Judgements:

- **Start with no overcommit.** A boutique firm may have 5 to 15 employees. At 6
  GiB each that is 30 to 90 GiB. One host can carry that without tricks. Set
  `reserve=on`. This avoids the whole class of surprises in a demo.
- **Free page reporting:** turn it on. It returns idle guest page cache to the host
  at little cost [estimate], and does not require a balloon size. Test that it
  works with your host kernel and Cloud Hypervisor build, because I found no
  independent report of it on microvm.nix [unverified].
- **Hugepages:** useful for speed, but they pre-allocate and I found no source on how
  they interact with the balloon [unverified]. Skip in the demo.
- **KSM:** the guests share a kernel and a read-only Nix store, so KSM might save a
  lot. But KSM is a known cross-VM side channel (CAIN attack, CVE-2015-2877;
  severity disputed). Proxmox documents it and recommends turning KSM off for
  hosting ([Proxmox](https://pve.proxmox.com/wiki/Kernel_Samepage_Merging_(KSM)),
  [CVE](https://www.opencve.io/cve/CVE-2015-2877)). Mike's VMs belong to one firm
  but run model-written code under possible injection. Keep KSM off until memory is
  actually short.
- **Swap/zram:** zram inside the guest gives a bounded burst buffer. It can fill like
  any swap, so keep `MemoryMax` as the backstop.
- **Disk-backed memory pressure:** the host page cache for the raw image files
  competes with guest memory. Use `O_DIRECT` / `cache=none` for the VM disks if the
  host shows cache thrash [estimate]; Cloud Hypervisor v52 reads DIO alignment from
  the file.

### Recommendation for Mike (memory)

**Now (functional demo)**
- Kernel in its own cgroup slice (`MemoryHigh` ~85% of `MemoryMax`, `MemoryMax` ~70%
  of VM RAM); sshd and supervisor protected; zram on.
- Supervisor emits `kernel_exit` with a reason; harness tells the model what
  happened and restores from the last snapshot.
- Prompt rule: DuckDB for big data; write results to Parquet; no live handles
  across cells.
- No overcommit; `reserve=on`; free page reporting on after a quick test.
- Dill snapshot at turn end with per-name cap (copy Prime's).

**Soon**
- Kernel restart when RSS passes a threshold between cells; `malloc_trim` test.
- Memory and spill-size telemetry per run (RSS peak, DuckDB temp bytes).
- Test ballooning with `deflate_on_oom` under real load.

**Later (NFR pass / RLM)**
- Tune overcommit, KSM and hugepages from measured density.
- Per-run memory budgets surfaced in the morning report.

---

## 3. Security (most important)

### 3.1 The lethal trifecta in this system

Simon Willison's definition: an agent that has (1) access to private data, (2)
exposure to untrusted content, and (3) a way to communicate externally can be
tricked into stealing the data. His advice: avoid the combination; guardrail
products that claim to catch "95% of attacks" are "very much a failing grade"
([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). Meta's
"Agents Rule of Two" (2025-10-31) says an agent should have at most two of: process
untrusted input, access sensitive data, change state or communicate externally,
within one session ([summary](https://simonw.substack.com/p/new-prompt-injection-papers-agents)).

How Mike maps onto it:

| Leg | Where it comes from in Mike |
|---|---|
| Private data | NAS, matter documents via `read_document`, Gmail/Drive connectors, client emails |
| Untrusted content | Web pages, SEC filings' free text, uploaded documents from counterparties, inbound email, search results, tool outputs |
| External communication | `send_email`, any HTTP(S) via the proxy (including to allowed hosts with data in the URL), git push, connector writes |

All three legs live in one Python process. Code mode makes it worse than JSON
tools in one way: the model can chain private reads and outbound calls in a single
cell without a human-visible step between them. It also makes it better in another:
the harness sees every `host_request` and can gate them deterministically.

Real incidents show the pattern is not theoretical: EchoLeak (CVE-2025-32711,
zero-click, Microsoft 365 Copilot, hidden prompt in an email), a malicious
`postmark-mcp` package that BCC'd every sent email to the attacker (Sept 2025), and
Microsoft's June 2026 write-up on poisoned MCP tool descriptions
([coverage](https://thehackernews.com/2026/06/microsoft-warns-poisoned-mcp-tool.html),
[roundup](https://beam.ai/agentic-insights/ai-agent-security-breaches-2026-lessons);
secondary sources, I did not open the primary reports).

### 3.2 Prompt-injection defences that hold up, and ones that do not

- **Detection and training are not enough.** "The Attacker Moves Second" (Nasr,
  Carlini et al., 14 authors from OpenAI, Anthropic, Google DeepMind and others)
  tuned gradient, RL, search and human-guided attacks and broke 12 recent defences;
  attack success was above 90% for most, and a human red team (500 participants,
  $20k prize) beat all of them ([arXiv 2510.09023](https://arxiv.org/abs/2510.09023)).
- **Frontier labs say the same.** OpenAI: prompt injection "is unlikely to ever be
  fully solved" ([TechCrunch](https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/),
  quote via press). Anthropic reported 1% attack success for Claude Opus 4.5 in
  browser use against a Best-of-N adaptive attacker with 100 attempts, and called it
  "meaningful risk" ([Anthropic](https://www.anthropic.com/news/prompt-injection-defenses)).
  Later system-card figures for newer models are reported only second-hand
  ([VentureBeat](https://venturebeat.com/security/anthropic-browser-agent-hijacked-31-percent-before-safeguards-engaged));
  they use different test setups and I could not check the primary cards.
  The relevant point: Mike's models are open-weight flash models, which have not
  had this kind of hardening. Assume they follow injected instructions.
- **Mike's current flagger** (`guardrails/injection.ts`) is a deterministic first
  layer that labels text addressed to an AI. It is useful as a cheap signal and for
  the morning report. It is not a defence against an adaptive attacker.
- **What holds up is structure:**
  - Remove or gate a leg (rule of two).
  - Control flow decided before untrusted data is read (plan-then-execute).
  - Untrusted data processed by a model that cannot act (dual LLM / quarantined LLM).
  - Deterministic policy on every outbound action (capabilities, taint).

### 3.3 Architectural patterns, honestly assessed

**Design Patterns for Securing LLM Agents** (Beurer-Kellner et al., six patterns;
[arXiv 2506.08837](https://arxiv.org/pdf/2506.08837)):

- *Plan-then-execute:* fix the action sequence before reading untrusted data.
  Attacker text cannot add steps, but can change the inputs of planned steps (a
  calendar entry can change the email body but not the recipient).
- *Dual LLM:* a quarantined model reads untrusted data and returns a variable the
  main model handles symbolically. The quarantined model can itself be injected and
  can still emit attacker-controlled output.

**CaMeL** (Google and Google DeepMind, [arXiv 2503.18813](https://arxiv.org/abs/2503.18813)):
a privileged model writes a program from the trusted query; a custom interpreter
tracks data provenance ("capabilities") and checks a policy at every tool call; a
quarantined model parses untrusted data. On AgentDojo it solves 77% of tasks with
provable security vs 84% undefended. Willison's reservations: users must write and
maintain policies, and constant approval prompts lead to blind "yes"
([post](https://simonwillison.net/2025/Apr/11/camel/)). He also notes that
prompt injection is not fully solved.

**FIDES** (Microsoft, [arXiv 2505.23643](https://arxiv.org/abs/2505.23643),
[code](https://github.com/microsoft/fides)): a planner attaches confidentiality and
integrity labels to data, a policy engine checks each consequential action, and
there are mechanisms to hide and selectively reveal data. Also evaluated on
AgentDojo.

**Fit with code mode.** The match is closer than it looks:

- The model already writes a program. CaMeL's key idea (the program, not the data,
  decides control flow) is the code-mode shape.
- RLM's sub-LM call, if implemented as a **tool-less completion** (as in Harvey's
  main experiments, where depth-1 sub-agents were plain LLM completions with no
  tools, [Harvey](https://www.harvey.ai/blog/post-training-rlm-agents-for-m-and-a-diligence)),
  is a dual-LLM quarantined call. It reads untrusted pages and returns a string. It
  cannot send mail.
- The gap: the root model prints sub-LM output and reasons over it, so injected text
  still reaches a model with tools. Full CaMeL stops that with value-level taint in
  a custom interpreter. Retrofitting that onto CPython is a research project.
  [estimate] Not for the demo.
- **A coarse, deterministic version is cheap and worth building:** a **run-level
  taint bit.** The harness sets `tainted=true` when the run (a) calls any web or
  fetch tool, (b) makes any proxy request to a host not on a trusted list, (c)
  reads a document from an untrusted source (uploaded by a counterparty, inbound
  email), or (d) receives a flagged tool result. Once tainted, outbound-capable tools
  (`send_email`, uploads, connector writes, `git push`) require human approval, and
  the approval card shows the recipient, body, attachments and the provenance of
  each attachment. Clean runs can send to allowlisted recipients without approval.
  This is "Rule of Two with a dial" and needs no model judgement.

### 3.4 Concrete mitigations for Mike

**Egress: allowlist vs logging, and TLS interception.**

- The current proxy logs host and port only for HTTPS (tinyproxy CONNECT). That is a
  record, not a control. Domain fronting and shared CDNs (github.com, S3, any
  user-content host) are channels that look allowed. Encrypted Client Hello can
  hide destinations from SNI filters
  ([overview of allowlist/MITM trade-offs](https://www.agentpatterns.ai/security/hostname-allowlist-tls-blind-spot/),
  [Blaxel egress guide](https://blaxel.ai/blog/sandbox-egress-control-outbound-allow-listing),
  vendor-adjacent).
- TLS interception trade-offs (from those sources): you can see paths, bodies and
  inject credentials, and you can run PII checks. Costs: a CA in the guest, a
  high-value CA key on the host, breakage with pinned clients, and legal and privacy
  concerns for decrypting traffic.
- **Recommendation:** do not intercept TLS for the demo. Instead **make the egress
  mode follow the data** (Rule of Two applied to the network):
  - *Open mode* (default): no firm data has been loaded in this run; web access with
    a blocklist and logging.
  - *Closed mode:* after the run reads private data, the VM's proxy ACL switches to
    an allowlist of public-data hosts that cannot be read by attackers (for example
    `www.sec.gov`, `data.sec.gov`, a PyPI mirror). Requests to anything else fail
    with a message that tells the model it is in closed mode and asks it to queue a
    request for the human.
  - The switch is a harness decision keyed on the VM's address and the run state,
    not something the model controls. Tinyproxy can do per-source allow rules with
    `Filter`, but a per-VM dynamic rule set is easier with Squid or a small custom
    proxy. [estimate]
- Smokescreen-style guards: resolve names at the proxy, reject private, loopback,
  link-local and CGNAT results on every connection, and test trailing dots, case and
  bracketed hosts. Stripe's Smokescreen had bypasses of exactly these kinds
  (CVE-2022-24825, CVE-2022-29188). Mike's tinyproxy had a CVE in 2025 as well:
  CVE-2025-63938 (integer overflow in `strip_return_port`, through 1.11.2, CVSS 6.5;
  patch status varies by distribution)
  ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-63938)). Check the tinyproxy
  version on node-a.
- The nftables rules in Mission 13 (proxy user cannot connect to private ranges)
  are the right second layer. Keep them.

**Email-sending guardrails.**

- `tools.send_email` never sends. It writes to an **outbox** table.
- Send rules, in order: (1) tainted run -> human approval; (2) recipient not on the
  firm's allowlist -> human approval; (3) attachments must come from documents the
  user owns and be listed on the approval card; (4) rate limits per user and per
  recipient (for example 5 per hour auto-approved, a daily cap); (5) never allow
  BCC/CC added by the model without showing it; (6) log the full message with the
  run and cell id.
- Overnight runs: sending is **off**. The run produces drafts and the morning review
  approves them.
- Microsoft's guidance as summarised by a vendor is the same: any action that moves
  data outside the organisation should need approval
  ([The Hacker News coverage](https://thehackernews.com/2026/06/microsoft-warns-poisoned-mcp-tool.html)).
- Gmail's `gmail.compose`-style drafts scope vs `gmail.send` is a useful distinction
  if the Gmail connector is used: give drafts only [general knowledge, check the
  current Google scopes].
- Approval fatigue is a known failure (Willison on CaMeL). Keep approvals rare by
  making the rules deterministic and the cards precise.

**PII tokenization (Anthropic).** Anthropic's code-execution-with-MCP article
describes a harness that intercepts data and tokenizes PII, so the model sees
placeholders like `[EMAIL_1]`, and real values are swapped back only when data goes
into another tool call. It says this lets you "define deterministic security rules
about where data can flow" and it states the cost plainly: a secure sandbox,
resource limits and monitoring ([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)).
For Mike:

- Useful for **third-party model providers**. OpenCode Go and OpenRouter see every
  prompt. Tokenizing client names, SSNs, account numbers and emails before they leave
  the harness cuts what a provider sees. It also leaves the model unable to leak the
  real value in an outbound email, because the detokenize step can enforce
  "only detokenize into tools whose recipient is allowed".
- Cost: the model cannot reason about the real values; legal text is full of names;
  detection (for example Microsoft Presidio, whose reversible mode is a wrapper that
  stores a mapping, [LangChain doc](https://python.langchain.com/docs/guides/privacy/presidio_data_anonymization/reversible))
  misses things. The mapping table is itself sensitive personal data.
- Verdict: **not for the demo.** It is a later feature; design `host_request`
  results so a tokenizing layer can be added at the harness boundary.

### 3.5 Treat everything from the VM as untrusted input

The model's code can write anything to its own stdout, including forged
`host_request` frames. Prime's private-stdout trick protects against stray prints,
not against an adversary in the same process. So the harness must treat every frame
and file from the VM as hostile:

- **Frames:** parse with a strict schema (zod or similar); reject unknown types;
  cap line length (16 Mi chars is the protocol ceiling; use a much lower default
  such as 1 Mi for requests); cap frames per second per kernel; reject duplicate or
  non-monotonic ids; time out a request that has no matching cell.
- **Authority comes from the session, not the frame.** A frame names a tool and
  arguments. The harness resolves the user, conversation, turn and permissions from
  the ssh session it holds, then runs the same dispatcher, Auto Mode checks and
  audit as a direct tool call. The frame never carries a user id, token or path
  scope.
- **Arguments are validated as for any model tool call** (they are model output).
  The VM cannot name a document it cannot read through Mike. File paths in
  `host_request` args are validated against the VM's allowed roots; no `..`, no
  symlink escapes. Reading a file back from the VM: copy it with a size limit,
  never follow symlinks (open with `O_NOFOLLOW`, `tar` with
  `--no-same-owner`/`--no-same-permissions`), scan for type.
- **Resource limits:** per-run caps on number of host requests, bytes returned,
  concurrent requests (`asyncio.gather` over 1,000 `read_document` calls is exactly
  what the bench showed code mode is good at, and also a denial-of-service vector),
  total LLM spend, and output size per cell (truncate and tell the model).
- **Replies are untrusted-content too:** results from web, documents and email go to
  the model as they do today, inside `<untrusted-content>` fences with injection
  flags.
- **Idempotency:** every side-effecting request carries a harness-minted idempotency
  key stored in Postgres. If a kernel dies and the cell is re-run, the second
  `send`/`create_document` returns the first result.
- **No ambient channels back:** the ssh server in the guest must forward no ports,
  agents or X11; the harness ssh options should set `-a -x -o
  ClearAllForwardings=yes` and use a restricted command (supervisor entry point).

### 3.6 VM escape and VMM CVEs (2024 to 2026)

I could only search for 2025 and 2026 items effectively.

**Cloud Hypervisor**
- **CVE-2026-27211 / GHSA-jmr4-g2hv-mjj6.** A malicious guest overwrites the header
  of its virtio-block disk image with a crafted QCOW2 structure that points to a
  host file; on the next boot or disk scan, auto-detection serves that file's
  contents to the guest. A guest reboot is enough. Affects v34.0 to v50.0; fixed in
  v50.1 and v51.0. Requires that the backing image be writable by the guest or from
  an untrusted source; "deployments that use only trusted, read-only images are not
  affected". Severity: GitHub says High (CVSS v4 7.2); OpenCVE lists CVSS v3.1 10.0.
  A window from 2026-01-15 to 2026-02-10 made it worse (raw backing file support,
  small files like SSH keys). Mitigations from the advisory: upgrade, `--landlock`,
  run unprivileged, strict permissions
  ([advisory](https://github.com/cloud-hypervisor/cloud-hypervisor/security/advisories/GHSA-jmr4-g2hv-mjj6)).
  **This is Mike's exact configuration**: a guest-writable raw `/home` disk.
  Specify `image_type=raw` explicitly on every disk (the advisory's hardening adds
  explicit typing; check the exact option name on your version).
- **CVE-2026-45782 / GHSA-f47p-p25q-83rh** (published 2026-05-14). A guest submits
  two virtio-block descriptor chains with the same `head_index` while async I/O
  (io_uring/aio, the default) is on; a use-after-free follows, which "could be
  escalated to arbitrary code execution and a guest-to-host escape". Affects v21.0
  to v51.1; fixed in v52.0 and v51.2. CVSS v4 8.9. Workaround: `disable_io_uring=on`
  and `disable_aio=on` on each virtio-block device, at a performance cost
  ([advisory](https://github.com/cloud-hypervisor/cloud-hypervisor/security/advisories/GHSA-f47p-p25q-83rh)).
- Both bugs are in the **virtio-block device code** the guest talks to. That is the
  device Mike exposes for the home disk. A minimal-device guest (fewer virtio
  devices) means a smaller attack surface.

**Firecracker** (for comparison, if the VMM is ever changed)
- **CVE-2026-5747** (published 2026-04-07): out-of-bounds write in the virtio PCI
  transport's queue configuration after device activation. Affects 1.13.0 to 1.14.3
  and 1.15.0; fixed in 1.14.4 and 1.15.1. Needs root in the guest; most direct
  effect is crashing the VMM; host code execution needs extra preconditions. CVSS
  3.1 7.5 / 4.0 8.7 ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-5747)). Whether
  Cloud Hypervisor's virtio-PCI code has an equivalent flaw, I could not confirm
  [unverified]. I did not find other 2025/2026 Firecracker escape CVEs in this search;
  the list may be incomplete.

**Lessons**
- Patch cadence is a real cost: the VMM must be updated within days. In Nix this is
  `nixos-rebuild` plus restarting each VM; plan a rolling restart with the
  snapshot-before-restart already built.
- Defence in depth for a VMM escape: run each VM's Cloud Hypervisor process as its
  **own unprivileged uid** with a systemd sandbox (`ProtectSystem=strict`,
  `NoNewPrivileges`, `PrivateTmp`, `ReadWritePaths` only for that VM's state),
  Landlock on, seccomp (Cloud Hypervisor enables it by default), no access to other
  VMs' state directories or the host's Postgres. An escape then lands as an
  unprivileged, confined user, not root.
- The harness runs outside the VM and holds no keys in it, which is the main
  defence if a VM is fully compromised: the attacker gets one employee's working
  files and nothing else, provided the NAS view (1.2) is scoped per employee.

### 3.7 Supply chain: pip install, Nix, pinned images

- `pip install` in the VM is both a feature and the largest practical risk.
  Slopsquatting is documented: a 2025 study of 576,000 code samples found 19.7% of
  suggested packages did not exist, with open-weight models hallucinating more than
  commercial ones; a harmless `huggingface-cli` placeholder was downloaded over
  30,000 times in three months
  ([DZone](https://dzone.com/articles/Slopsquatting-supply-chain-attack),
  [Nesbitt](https://nesbitt.io/2025/12/10/slopsquatting-meets-dependency-confusion);
  secondary reporting of the study, I did not open the paper).
  Flash models are exactly the "open-weight models" in that finding.
- **Mitigation, in order of cost:**
  1. Pre-bake a broad base environment in the Nix image (pandas, polars, duckdb,
     pyarrow, python-docx, openpyxl, docling, edgartools, pdfplumber, beautifulsoup,
     lxml, scipy, statsmodels, matplotlib). Most tasks then never need `pip`.
  2. Route PyPI through a **mirror or allowlist at the proxy**. The tinyproxy can
     allow only `pypi.org` and `files.pythonhosted.org` now; later, a mirror (devpi
     or a pinned wheelhouse) with an approved-package list.
  3. `pip install` from the VM is allowed only as `pip install --require-hashes -r`
     or `uv pip install` with a lock file that the harness generated, and every
     install is logged as an event the morning report lists.
  4. Packages installed in the VM run as the agent user in a throwaway venv under
     `~`; nothing installed can touch `/nix/store`.
  5. Block new package names in closed egress mode (3.4).
- The Nix image is declarative and read-only for the store; updates are a new
  generation. Keep the flake lock file committed and review `flake.lock` changes.
  The guest has no root (`sudo` refused in the receipts); keep it so.

### 3.8 Secrets never in the VM

- Keep the current rule. Things to double check: the git credential helper (no
  tokens in `~/.git-credentials`; a `host_request` such as `tools.git_push` that the
  harness performs with its own key), SSH agent forwarding off, environment
  variables in the kernel (scrub), `pip` config with index credentials (none),
  and anything the model writes (documents may contain keys, which the model can
  paste; scanning with a secret detector on files exported from the VM is cheap).
- Connector tokens (Gmail, Drive) stay in the harness; the model uses tools.
- If the VM ever needs a credential for a service (an internal DB), use short-lived,
  scoped, read-only credentials issued per run, and do not store them in snapshots.

### 3.9 Auditability of what code did

- **Store every cell** (code, hash, start/end, exit state, stdout truncated and
  stored in full out of band), **every host_request** (tool, args, result size,
  duration, caller cell), **every proxy line** (VM address, host, port, bytes), and
  **every file written** (a diff of the home snapshot per turn).
- Link them with ids: run -> turn -> cell -> host_request -> proxy rows by timestamp.
  The btrfs snapshot name goes into the turn row.
- Make logs **append-only** at the harness (separate Postgres role with `INSERT`
  only; hash chain per run). Mike already has `docs/tamper-evident-exports.md`.
  Off-host immutable storage is "later".
- Render a human trace: collapsible cell list with code, output, tool calls and
  egress.
- Because the VM can lie, the harness-side record of `host_request` and the proxy
  log are the trusted record. A cell's stdout is not.

### 3.10 What is needed for the demo and what is later

| Item | Demo | Soon | Later |
|---|---|---|---|
| Cloud Hypervisor >= v52.0, unprivileged per-VM uid, `--landlock`, explicit `image_type=raw` | Yes | | |
| Outbox for email with approval, overnight sends off | Yes | | |
| Frame validation, caps, per-run budgets, idempotency keys | Yes | | |
| Run-level taint bit gating outbound tools | Yes | | |
| Egress mode that follows data (open/closed) | Simple version (manual toggle per run) | Automatic | |
| Pre-baked Python environment, PyPI allowlist | Yes | Mirror | |
| Injection flags on tool results (exists) | Keep | | |
| Append-only harness logs, trace UI | Basic logs | UI | Off-host immutable |
| PII tokenization | | | Yes |
| TLS interception | | Only if a need appears | |
| Value-level taint / CaMeL-style interpreter | | | Research |
| Auth hardening, off-machine backups | | | Later pass (owner) |

### Recommendation for Mike (security)

**Now (functional demo)**
1. Verify and upgrade Cloud Hypervisor (>= 52.0, or 51.2 / 50.1 minimum); if you
   cannot upgrade today, set `disable_io_uring=on,disable_aio=on` and
   `--landlock`. Run each VM's VMM as its own unprivileged uid.
2. Email through an outbox with human approval; sends off in unattended runs.
3. Harness-side frame validation, request caps and idempotency keys.
4. Run-level taint bit; tainted runs need approval for any outbound tool.
5. Manual egress modes (open / closed) per run; a short allowlist for closed mode
   (SEC, PyPI).
6. Pre-baked Python environment; log every `pip install`.
7. Plant canary secrets in test documents and fail the build if any appears in the
   proxy log or outbox (see section 8).

**Soon**
- Automatic egress switching keyed on run state; per-VM dynamic ACL (Squid or custom).
- A quarantined `llm()` (tool-less) as the default way to read untrusted pages.
- Tool-argument provenance labels in the approval card.
- Tinyproxy upgrade or replacement; adversarial tests of the proxy (trailing dots,
  case, brackets, raw IPs, IPv6, redirect-to-private).

**Later (NFR pass / RLM)**
- PII tokenization at the model boundary.
- Off-host immutable logs and snapshots; auth hardening.
- CaMeL-style value-level taint in the kernel (research).
- TLS interception only if a concrete policy needs path-level rules.

---

## 4. Other approaches worth knowing

### 4.1 RLM (Recursive Language Models)

**The paper.** Zhang, Kraska and Khattab, MIT CSAIL,
[arXiv 2512.24601](https://arxiv.org/abs/2512.24601) (v1 2025-12-31, v3 2026-05-11).
The long prompt lives in an external environment (a Python REPL) as a variable; the
model inspects it with code and calls itself (sub-LMs) on pieces. Reported results
(authors): handles inputs up to two orders of magnitude beyond the context window;
against GPT-5 baselines, median gains of +26% over compaction, +130% over CodeAct
with sub-calls and +13% over Claude Code, at comparable cost; a post-trained
RLM-Qwen3-8B beats Qwen3-8B by 28.3% on average. The original blog post was October
2025. The reference library is [alexzhang13/rlm](https://github.com/alexzhang13/rlm):
local, IPython, Docker, Modal, Prime, Daytona and E2B environments; `llm_query` /
`llm_query_batched` for one-shot sub-LM calls; `rlm_query` for recursive sub-RLMs;
`max_concurrent_subcalls`; an `RLMLogger` that stores trajectories as JSONL with a
local visualizer. Its README says the local `exec` REPL "should not be used in
production".

**An independent reproduction** (Wang, "Think, But Don't Overthink",
[arXiv 2603.02615](https://arxiv.org/abs/2603.02615)) is described in secondary
snippets as finding that depth-1 helps on complex reasoning, and that deeper
recursion or RLM on simple retrieval can degrade accuracy and inflate cost. I could
not read the PDF text, so treat this as [unverified].

**Prime Intellect** ([blog](https://www.primeintellect.ai/blog/rlm)): calls the RLM
"the simplest and most flexible method for context folding". Setup: persistent
Python REPL, tools available only to sub-LLMs (so bulky tool output stays out of
the root context), `llm_batch` for parallel sub-calls, an `answer` dict with
`content` and `ready`, output capped at 8,192 characters by default and each REPL
call at 120 s. Results with GPT-5-mini over four environments with 50 rollouts per
setting: RLM generally better, with exceptions (math-python worse; DeepDive worse
without tips). On the "real" Oolong subset at about 1.5M characters, RLM beat the
plain LLM by a large margin. Open models via OpenRouter: GLM 4.6 nearly doubled on
DeepDive with RLM, but with tips it stopped using sub-LLMs and fell to just above
half the LLM score; GLM 4.6 scored zero on Oolong without RLM and above zero up to
about 1.75M characters with it; INTELLECT-3 needed tips; DeepSeek-v3.2 was dropped
because it used the wrong function-calling format. Recursion depth fixed at 1;
results are prompting, not training. **This is the most relevant evidence for
affordable models: it works unevenly and is sensitive to prompt tips.** Prime Agent
(MIT licence, [GitHub](https://github.com/PrimeIntellect-ai/prime-agent)) is the
product built on it: persistent Python REPL as the built-in model tool, subagents
via `rlm.spawn(...)`, and a README warning that the kernel "is not a security
sandbox".

**DSPy's `dspy.RLM`** exists ([docs](https://dspy.ai/api/modules/RLM/)): a module
that keeps the context in a REPL as variables and shows the model only metadata
(name, type, length, short preview); injects `llm_query` and `llm_query_batched`;
loops through code-execute-observe until `SUBMIT(output)`; has limits on
iterations and sub-LM calls (the docs I could reach list defaults of 20 iterations,
50 LLM calls, and 10,000 output characters; parameter names changed across
versions); accepts `tools=` and a separate `sub_lm`. The default sandbox is
Pyodide in Deno. Marked experimental; instances are not thread-safe with a custom
interpreter. Useful as a design reference, not as a dependency (TypeScript
harness, different sandbox).

**Harvey.** Primary source read:
[Post-Training RLM Agents for End-to-End M&A Diligence](https://www.harvey.ai/blog/post-training-rlm-agents-for-m-and-a-diligence)
(2026-09-08, with Baseten). All numbers below are Harvey's, self-reported, on
synthetic data rooms ("LAB Diligence", an extension of its open
[Legal Agent Benchmark](https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark))
scored by an LLM judge against rubrics:

- Data rooms up to 5,000 documents and 80M tokens. The whole room is loaded into a
  Python REPL as variables; a root agent plans, searches in code, and dispatches
  bounded reading tasks to parallel sub-agents in their own contexts; only what the
  root prints enters its context. Main experiments used depth-1 sub-agents (plain
  completions, no tools).
- Tool-loop baseline: 23.3% average rubric pass rate over 50 rooms. RLM harness
  (seven models, open-weight among them): 62.4% average, +39.1 points. Claude Code
  and Codex in their own harnesses: 24.6% and 12.0%.
- Tool-loop runs read under 1% of the data room; RLM runs mostly read over 10%.
- Training: Qwen3.5-122B-A10B root with RL: 29.9% to 63.0% (50 rooms), 40 steps.
  GLM-5.2 root with rejection-sampling SFT: 46.1% to 60.1% (20 rooms).
- Cost: moving to the RLM harness raised cost for six of seven baseline models; for
  Opus 5 it fell from about $18 to about $7 per room with a 35-point higher score
  (list-price estimates).
- Depth-2 recursion (14 rooms): mean pass rate fell 19 points; improved 4 rooms,
  hurt 10; in 4 regressions the agent read the data room but never wrote a report;
  many GLM-5.2 depth-2 runs timed out.
- Root choice moved scores about 38 points on average; sub-agent choice about 8.
  **Spend the strong model on the root, use cheap models for sub-agents.**
- Rollouts can take over an hour.
- The post does **not** say this is deployed to customers. The earlier "Harvey Tenet"
  post describes a Kimi K3-based post-trained model; I did not read it.

So the owner's understanding is partly right: Harvey published successful RLM
research with strong numbers. Production use is not confirmed in anything I could
read [unverified]. The result also supports the owner's plan: the harness matters
more than the sub-model, and the root's behaviour is learnable from few traces.

### 4.2 CodeAct and smolagents

- CodeAct (ICLR 2024) reported up to 20% higher success on multi-tool tasks with
  fewer turns on 2024 models ([ICLR](https://www.iclr.cc/virtual/2024/22224)).
  smolagents' `CodeAgent` implements the idea. Its `LocalPythonExecutor` rebuilt the
  interpreter with import allowlists, but had a sandbox escape (CVE-2025-5120,
  fixed in 1.17.0) and its docs say no solution is 100% safe
  ([smolagents docs](https://huggingface.co/docs/smolagents/main/tutorials/secure_code_execution.md),
  [NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-5120)).
- Fit: it confirms the pattern; its language-level sandboxes are the wrong model for
  Mike, which uses a VM boundary.
- The RLM paper reports a median gain of +130% for RLM over CodeAct with sub-calls
  on its long-context benchmarks (authors' figure). For Mike this means: plain code mode is
  right for tool work, and RLM-style context handling is a different feature that
  can be added on top.

### 4.3 Anthropic programmatic tool calling and Skills

- Programmatic tool calling (GA): the model writes Python in a container; tools are
  async functions; execution pauses at each call and resumes with the client's
  result; containers last up to 30 days, idle ones are released after about 5
  minutes; a pending call expires after about 4 minutes; each `tool_use` has a
  `caller` field; `allowed_callers` "should not be relied on as a security
  boundary" ([docs](https://platform.claude.com/docs/agents-and-tools/tool-use/programmatic-tool-calling),
  details from localised copies). This is the same pause/resume shape as
  `host_request`. **Lesson:** a pending call needs a timeout and a clear failure
  (`TimeoutError` in the cell), and the harness must handle "container gone while a
  tool call was pending".
- "Code execution with MCP" ([article](https://www.anthropic.com/engineering/code-execution-with-mcp)):
  tools as files read on demand; filter results in code; keep intermediate data out
  of context; a Drive-to-Salesforce flow dropped from about 150,000 to 2,000 tokens
  [vendor]. It also describes saving working code as reusable functions and adding a
  `SKILL.md` to make them skills.
- **Skills** (folders with `SKILL.md`, progressive disclosure: name and description
  at startup, body when relevant, scripts run rather than read)
  ([overview](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure),
  secondary). Fit for Mike: very good. Store firm workflows (an SEC 10-K
  comparison, a memo template) as skills in the VM home or a shared read-only skills
  dir; they are code the firm can review, version and test, which is how code mode
  grows without re-prompting. Treat skills the agent wrote as untrusted until a human
  approves promotion to the shared set.

### 4.4 Cloudflare Code Mode and Pydantic Monty

- Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) runs TypeScript
  in V8 isolates with no internet; only bindings to MCP servers get through. It is
  the opposite trade to Mike's.
- [Pydantic Monty](https://pydantic.dev/articles/pydantic-monty): a Rust Python
  subset interpreter; deny-by-default; the host declares `external_functions`;
  execution pauses at each call and can be serialised and resumed; vendor-reported
  cold start 4.5 ms vs 195 ms for Docker. Experimental, no classes or most of the
  standard library in the versions described (moving fast). **Not a fit for the
  main kernel** (no pandas, no real filesystem). It might suit a future "untrusted
  expression evaluator" for user-supplied formulas. Its pause/serialise/resume
  design is worth reading, because it solves the same problem as `host_request` plus
  dill.

### 4.5 OMP

OMP (oh-my-pi) moved from a Jupyter gateway to `python -u runner.py` with NDJSON on
stdin/stdout in May 2026 (details in the earlier note). Lessons already adopted:
top-level `await`, SIGINT with a 5 s kill fallback, cell timeout paused while
waiting on subagents or `%pip`. The loopback HTTP bridge for tools is the thing Mike
deliberately does not copy; the same-channel `host_request` is the better design
here because the VM gets no URL or token.

### 4.6 Durable execution for overnight runs

Options: Temporal (mature, own server), Restate (own log-based server) and DBOS
(library, Postgres is the orchestrator)
([comparison](https://alatirok.com/durable-execution-ai-agents-compared/),
[DBOS and Temporal](https://respan.ai/market-map/compare/dbos-vs-temporal); these
are vendor-adjacent pages).

**Mike already has the pieces and should not add a second engine.**
- Pi Durable on Postgres: measured 24/24 storage conformance, ~150 to 160 commits/s,
  reopen in 75 ms after `SIGKILL`, unsafe tools are not rerun and the model is told
  the call was interrupted (`goals/pi-durable-decision-2026-10-08.md`).
- `dbq` durable jobs for queued work, subagents (Mission 9) with spend rows.
- The gap code mode adds: **a kernel and a VM that survive the harness restart, and
  host requests in flight.** The supervisor design in the earlier note (re-deliver
  pending host requests on reconnect) is the right answer. Pair it with an
  idempotency table so a replayed request does not repeat a side effect.
- Add Temporal or DBOS only if you later need cross-service sagas (for example
  mail server, billing and VMs on different hosts). Not now.

### 4.7 Agent checkpointing and resumability

Three levels, from the cheapest:
1. **Conversation state** (Pi Durable). Exists.
2. **Files** (btrfs snapshot per turn; add a snapshot every N minutes during a
   long run). Exists for turns.
3. **Kernel state** (dill snapshot at turn end). To build.
Plus an agent-visible **progress file** and **task list** (see 6). Anthropic's long-running
harness note makes the same split: git history, a progress log and a JSON feature
list that coding agents can only flip from failing to passing, because models tamper
less with JSON than Markdown
([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
Cloud Hypervisor's own VM snapshot/restore (memory included) exists (v52 added sparse
snapshots and lazy restore) but resets vsock connections on restore; Mike's
disk-snapshot approach is simpler and was tested.

### 4.8 Dagger / containers inside the VM

Containers inside the VM (rootless Podman or bubblewrap) can sandbox a single
dangerous cell (a build, `pip install`, a third-party binary) and give per-command
overlay-and-commit like Pi's capsules. The VM is already the boundary; a nested
container adds a second layer and complexity. Dagger (pipelines as code in
containers) solves reproducible builds, which is not Mike's problem. Use bubblewrap
for `pip install` and untrusted-document conversion first; leave Dagger. Later.

### 4.9 Jupyter vs a JSON-lines runner

Jupyter gives rich display, widely known protocol and tooling, and `nbformat` for
saving transcripts. It costs a server or ZeroMQ ports, a token, a heavier start,
and awkward interruption. OMP and Prime both dropped it. For Mike, the runner's
event log (cells, outputs) can be exported to `.ipynb` for humans at the end of a
run; that gives the notebook view without Jupyter in the loop. Recommended.

### 4.10 E2B-style hosted sandboxes (contrast)

E2B, Daytona, Modal and Vercel Sandbox sell per-sandbox microVMs or gVisor
containers. They solve boot, snapshot and fleet management, and cost data
residency: client documents would leave the firm. For a private-stack firm the owner
has chosen the opposite. They are worth knowing as a reference for features (fast
snapshot/restore, per-sandbox egress policy, credential-injecting proxies such as
Blaxel and Hermes's iron-proxy) and as the escape hatch if the firm ever wants
managed hosting.

### 4.11 Other things a careful architect would want to know

- **A tool-less sub-completion is the safe default for reading untrusted text**
  (dual LLM) and cheap for flash models.
- **`pass^k`, not `pass@1`.** MCPMark reports pass@1, pass@4 and pass^4; the best
  model had about 52.6 to 57.5% pass@1 and 33.9 to 36.7% pass^4 (versions differ)
  ([MCPMark](https://arxiv.org/pdf/2509.24002)). tau-bench introduced pass^k and
  found GPT-4o below 25% at pass^8 in retail
  ([tau-bench](https://arxiv.org/pdf/2406.12045)). An overnight run is one sample, so
  consistency matters more than the best case.
- **Free-form code means free-form failures.** Syntax errors from escaped newlines
  were the dominant failure of older closed models in the Bitter Lesson study; no
  open-weight model was tested there ([arXiv 2608.06370](https://arxiv.org/html/2608.06370v1)).
  Keep the repair step, and add Prime's lesson that "wrong function-calling format"
  can disqualify a model outright.
- **Cost transparency.** Harvey's data shows RLM can raise cost; with a cheap
  sub-model this is acceptable, but budgets must be hard.

### Recommendation for Mike (other approaches)

**Now (functional demo)**
- Plain Python code mode on the Prime-style protocol. Export a run as `.ipynb`.
- Keep Pi Durable and `dbq`; add idempotency keys; no new workflow engine.
- Make Skills the growth mechanism: a shared, reviewed, read-only skills directory.

**Soon**
- A run viewer that renders cells, host requests and egress as a tree.
- bubblewrap for `pip install` and document conversion.
- Add `pass^k` reporting to the eval harness.

**Later (NFR pass / RLM)**
- RLM features (section 5).
- Temporal or DBOS only if cross-host workflows appear.
- Monty-like evaluator for user-supplied formulas.

---

## 5. The RLM migration path

### 5.1 What to build now so RLM is cheap later

The RLM pattern is: context in variables, a persistent REPL, sub-LM calls from code,
a clear submit step. Mike's design already has the REPL. Add:

1. **Context as variables, kept on disk.** A `Corpus` object returned by
   `tools.open_corpus(project_id | path_glob)`: lazy, backed by files in the VM
   (text and Parquet), with `len(c)`, `c.meta(i)`, `c.text(i, start, end)`,
   `c.search(regex)`. The prompt shows only a **namespace summary** (name, type,
   size, short preview), like DSPy and Prime's `list_names`, refreshed each step.
   Document text never enters the root context unless printed.
2. **`llm(prompt, *, model="sub", schema=None, max_tokens=...)` and
   `llm_batch(prompts, ...)`** as `host_request`s. Harness-side they are
   **tool-less completions** on the configured sub-model, with JSON-schema
   validation and retry. Default sub-model: the cheapest flash model. Returns a
   string or validated JSON.
3. **`agent(task, tools=[...], model=...)`** as a `host_request` that starts a Mike
   subagent (Mission 9). Disabled by default.
4. **Depth limit 1 by default.** Evidence: Prime fixed depth at 1; Harvey's depth-2
   test lost 19 points and caused timeouts and missing reports. Make depth a
   server-side per-run setting, not a model parameter.
5. **A budget ledger the VM cannot touch.** Per run: max iterations (DSPy default
   20), max sub-calls (DSPy default 50; raise for corpus work), max concurrent
   sub-calls, max tokens and dollars per model, wall-clock, max output chars per
   cell (Prime: 8,192 for the root's view), per-cell timeout (Prime default 120 s;
   OMP pauses the timer while waiting on subagents and user). On exceeding: return a
   structured `BudgetExceeded` to the cell and, at the hard stop, end the run with
   a partial-result report.
6. **Cost accounting** on every `llm`/`agent` request: model, input/output/cache
   tokens, cost, parent cell id, depth. Mike already writes `subagent.run` rows and
   `turn_usage` events; add `code.llm_call` rows. Show "root X, sub-calls Y" in the
   run summary (Harvey reports root vs sub-agent token shares).
7. **A submit protocol.** `SUBMIT(content)` (DSPy) or an `answer` dict with `ready`
   (Prime). The run is not done until it is called; this removes "the model stopped
   talking, so it must be done" ambiguity, and it lets the harness check the output
   (for example "must reference at least N sources", "must write the file").
8. **Traces.** Every cell, `host_request`, sub-call prompt and response as an
   append-only tree with ids. The RLM reference visualizer reads the same shape.
9. **Prompt packs per model.** Prime's results moved a lot with "tips" (one model's
   RLM score fell below half the LLM's after tips stopped it using sub-LLMs).
   Version prompts in the repo, keyed by model, with the eval deciding defaults.
10. **Keep the Python API stable.** Name things as they appear in RLM literature
    (`llm_query`, `llm_query_batched`, `SUBMIT`) or provide aliases, so published
    prompts and future fine-tunes transfer.

### 5.2 Signals that affordable models are ready

Measure on your own tasks, with the flash models in the plan:

- **Spontaneous decomposition.** On a 200-document question, does the model write
  code that fans out `llm_batch` over documents without being told? Prime's tips
  changed this; Harvey saw base models under-dispatch (call volume correlated 0.17
  with data-room size before SFT, 0.84 after).
- **Coverage.** Fraction of the corpus actually read. Harvey: tool loops read under
  1%; RLM runs over 10%, trained roots about 96%.
- **Termination.** Rate of runs that end with a valid `SUBMIT`. Harvey's failed
  depth-2 runs read everything and never wrote the report.
- **Format reliability.** Fraction of cells that parse and run; fraction of sub-call
  JSON that validates. DeepSeek-v3.2 was dropped by Prime for format errors.
- **Cost per solved task** (with root and sub split). If RLM costs more than 2x plain
  code mode for the same score, do not switch.
- **Stability.** pass^4 on the same task, not best of four.
- **Long-input behaviour.** Prime's GLM 4.6 on Oolong: zero without RLM, above zero up
  to 1.75M characters with RLM, zero beyond. Find where each model's cliff is.
- **External signals to watch:** open-weight releases fine-tuned for RLM (Harvey's
  GLM-5.3 RL run is in progress; Prime states plans to train small models;
  RLM-Qwen3-8B exists), and the RLM reference library adding more open-model
  results.

### 5.3 How to evaluate RLM against plain code mode on our tasks

- **Two arms, same harness, same tools.** Plain: no `Corpus`, no `llm_batch` in the
  prompt. RLM: both, plus the RLM prompt pack. Same models, same checkers.
- **Task families** (about 10 each):
  1. *Short-context tool tasks* (to catch regressions: reports say RLM can hurt
     simple tasks).
  2. *Needle across a corpus* (find the clause in 200 contracts).
  3. *Aggregation across a corpus* (count/classify each document, then total),
     Oolong-style.
  4. *Verbatim extraction* (copy a long table exactly).
  5. *Diligence-style memo*: a small data room (50 to 200 docs) with a rubric.
  6. *SEC + proprietary*: pull three filings, join with a firm spreadsheet,
     produce a .docx with citations.
- **Checkers:** programmatic first (counts, exact matches, file structure, citation
  resolves to the right accession number), rubric LLM judge second, with the judge
  being a different model family than the contestant and a human spot-check of 10%.
  Harvey uses an LLM judge on rubrics; its numbers are only as good as that judge.
- **Runs:** 4 per task, arm and model; report pass@1, pass^4, cost, wall time and
  coverage; paired differences with bootstrap intervals (the repo's earlier plan).
- **Decision rule written in advance:** adopt RLM for a model and task family only
  if pass^4 improves by a set margin and cost per solved task rises by less than a
  set factor.
- Harvey's open [Legal Agent Benchmark](https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark)
  (1,200+ tasks across 24 practice areas per Harvey; a third party reports 1,671, so
  the count is inconsistent) can supply task shapes and rubrics. I did not verify
  its licence or how well it fits the firm's work.

### Recommendation for Mike (RLM)

**Now (functional demo)**
- Implement `llm()`/`llm_batch()` as tool-less host requests with a budget ledger and
  cost rows, and a `SUBMIT` protocol. They are small and they serve plain code mode
  too (parallel extraction across documents).
- Depth fixed at 1. Namespace summary in the prompt each step.

**Soon**
- `Corpus` lazy objects; prompt packs per model; the two-arm eval above with the
  three flash models.
- Trace tree viewer.

**Later (NFR pass / RLM)**
- `agent()` recursion beyond depth 1 only if the eval shows gains.
- Fine-tuning or RL on firm traces (Harvey's SFT and RL on a small number of
  traces is the model for this; expensive and out of scope now).

---

## 6. Long-running overnight work

### 6.1 Known failure modes

From the sources I could read ([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
plus practitioner and arXiv items I only saw as search results):

- **Overreach:** trying to do too much at once and running out of context mid-task,
  leaving half-finished, undocumented work.
- **Premature completion:** a later session sees progress and declares victory.
- **Weak verification:** marking work done after a unit test or `curl`, without an
  end-to-end check (Anthropic found explicit "test like a user" prompting and browser
  tools helped a lot).
- **Compaction drops constraints:** a summary loses a permission error or a rule, and
  the agent retries the failed action later. Compaction usually runs between turns,
  not mid-turn, so a single turn can balloon first. Graduated compaction beats a
  single 95% emergency threshold ([OpenDev paper](https://arxiv.org/html/2603.05344v1),
  [Compaction traps](https://tianpan.co/blog/2026/04/19/compaction-traps-long-running-agents);
  practitioner and arXiv sources I did not read in full) [unverified].
- **Retry loops and silent drift:** the same tool call repeated; goal drift without
  an error; an early wrong argument corrupting later steps.
- **Environment decay:** disk full, a stale kernel with a huge namespace, rate limits
  (SEC), an API key expiring at 3 a.m.
- **Cost run-away:** a loop of 1,000 sub-calls.

(One blog claims agents "failed on 84% of multi-step tasks over 15 loops". I could not
trace it to a primary source, so I do not rely on it.)

### 6.2 Design for Mike

**Context management and compaction.** Mike's compaction work (Station 4) keeps
original transcripts and uses byte-stable prefixes. For code mode:
- Prefer **offloading** to files over summarising: old cell outputs replaced by
  pointers ("output saved to `~/runs/42/cell-17.txt`, 3.1 MB") with the full text on
  disk. The RLM pattern does this by construction.
- Pin invariants in a short block that is re-injected after every compaction: the
  task, hard constraints (no sending email, closed egress mode), the budget, and the
  current plan with statuses.
- Keep a **progress file** (`~/runs/<id>/PROGRESS.md`) and a **task list**
  (`~/runs/<id>/tasks.json`, items with `status`, `evidence`, `notes`). Agents may
  change `status` and add notes; they may not delete items. Use JSON, not Markdown
  (Anthropic's reason: less tampering).

**Resumability after crashes.** Cases:
- Backend restarts: Pi Durable resumes the turn; the supervisor keeps the kernel;
  pending host requests are re-delivered (earlier note). Idempotency keys prevent
  double effects.
- Kernel dies: restore the last dill snapshot; tell the model; the task file tells it
  where it was.
- VM dies or is restored: roll back to the last snapshot; the harness replays nothing
  automatically; the model re-reads the task file and continues from the last
  `done` item whose evidence still exists on disk.
- Host reboots: a startup reconciliation job lists runs marked `running`, restarts
  VMs, and resumes or fails them with a reason.

**Progress reporting.** A heartbeat every N minutes: items done / total, last cell
time, spend so far, last egress host, current RSS. Stored in Postgres and shown in
the web app. A **watchdog** in the harness (not the VM) marks a run `stalled` if
there is no cell or request for M minutes, or the same cell hash repeats K times,
or spend per minute exceeds a threshold.

**Budget and time limits.** Hard limits in the harness: dollars, tokens per model,
wall-clock (a run cannot exceed, say, 10 hours), number of cells, number of host
requests, and egress bytes. The model sees remaining budget in its namespace
summary. At 80%, the harness injects "wrap up and write the report"; at 100% it ends
the run and produces the partial report itself.

**Stopping safely.** A kill switch (UI button, API) that: sets a flag the supervisor
checks, interrupts the running cell with SIGINT, takes a final snapshot, switches
the VM to closed egress, and produces a stop report. Tools called by the stopped run
return `RunStopped`. No new outbox sends. Unattended runs have **sending disabled**
and **no ask-and-wait**: `tools.ask_user()` in an unattended run records the
question in the morning report, returns a configured default or `None`, and lets the
agent continue on other items. (Station 9's old constraint "no ask/pause surface" was
for the old design; this keeps it true.)

**Human review in the morning.**
- A report: what was asked, what was done per task item, artifacts with links,
  every claim with source (accession number, page), decisions the agent made and
  assumptions, questions it could not ask, spend, errors, egress summary by host,
  `pip` installs, and any injection flags.
- **Pending actions:** drafted emails in the outbox, documents proposed as new
  versions. Nothing external happens until approved.
- **Diff of what changed in the VM** since the pre-run snapshot (list of files,
  sizes), with a one-click restore of the whole night.
- An automatic **verifier pass**: a second, cheaper model plus programmatic checks
  re-open each cited source and check the quoted figure (Mike's Mission 6
  citation-verification subagents apply).

### Recommendation for Mike (overnight)

**Now (functional demo)**
- Progress file and JSON task list; heartbeats; hard budgets; kill switch.
- Idempotency keys; kernel-exit handling; pre-run snapshot and a snapshot every
  15 to 30 minutes.
- Unattended mode: sends off, asks queued.
- Morning report with outbox and diff.

**Soon**
- Watchdog for loops and stalls; graduated compaction with pinned invariants.
- Host-reboot reconciliation; stale-run reaper.

**Later (NFR pass / RLM)**
- Off-host snapshots and logs; alerting (pager/email) on stalled or failed runs.
- Learned stopping and budget policies from past traces.

---

## 7. The data stack inside the VM

### 7.1 SEC EDGAR

- The official fair access rules: **maximum 10 requests per second**, scripts must
  declare a User-Agent with company name and contact email, download only what you
  need, and the SEC "does not allow botnets or automated tools to crawl the site"
  ([SEC](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)).
  The page names no specific penalty beyond limiting or managing flagged traffic.
- `data.sec.gov` APIs need no key. For bulk: nightly recompiled ZIPs
  (`submissions.zip`, `companyfacts.zip`), updated around 3:00 a.m. ET; per-company
  JSON is updated through the day ([SEC API docs](https://www.sec.gov/edgar/sec-api-documentation)).
- **Important for Mike: the limit is per client, and all VMs egress through one IP.**
  Several overnight runs at once will exceed 10 req/s together. Put a
  **shared rate limiter and cache** in front of `sec.gov` (a caching proxy
  or a harness `tools.sec_fetch`), and set the User-Agent in the proxy so the
  model cannot omit it. Consider mirroring bulk files to the NAS nightly.
- **Library: edgartools** (MIT, v5.30.0 per PyPI snapshot): `Company(...).get_financials()`,
  statements, Form 4, 8-K; set identity with `set_identity()` or `EDGAR_IDENTITY`
  ([docs](https://edgartools.readthedocs.io/)). Claims of "10 to 30 times faster" are
  the project's and I did not verify them. XBRL tagging varies by company, so check
  key figures against the filing text. Respect its compliance page
  ([SEC compliance](https://edgartools.readthedocs.io/en/latest/resources/sec-compliance/)).

### 7.2 Document parsing (PDF / DOCX / HTML)

No rigorous benchmark exists across the three tools; sources are blogs and one
vendor run ([comparison](https://www.ertas.ai/blog/pdf-parsing-accuracy-benchmark-docling-unstructured),
[dev.to](https://dev.to/vtempest/pdf-gec), [Docling paper](https://hyper.ai/en/papers/2408.09869)).
- **Docling** (IBM, layout model trained on DocLayNet): strongest on tables and
  complex layouts; IBM claims 97.9% table accuracy [vendor]; slower. The pypdfium
  backend is about 40% faster and uses under half the memory but is worse on tables.
- **PyMuPDF / PyMuPDF4LLM:** fastest (blog claims 15 to 35x, [unverified]); weak on
  tables in informal tests. **Licence: PyMuPDF is AGPL-3.0 or commercial** (general
  knowledge; check before bundling in a firm product).
- **Unstructured:** broad, heavier, mid-quality tables in the sources.
- **Others:** `pdfplumber` / `pypdfium2` (permissive), `python-docx` for DOCX,
  LibreOffice headless to convert legacy formats (in the image), `selectolax` /
  `lxml` / `trafilatura` for HTML. SEC filings are HTML/iXBRL; use edgartools for
  structured parts and HTML parsing for narrative sections.
- **Method:** pick 30 to 50 pages from the firm's real documents, score table cell
  accuracy, speed and memory, and decide. Run OCR (Tesseract or a model) only for
  scanned pages; cache parsed output as Parquet or Markdown on the NAS "derived"
  area keyed by content hash.

### 7.3 DuckDB / Polars

See 2.2. DuckDB is the default; Polars for in-VM dataframe manipulation under a few
GB; both with fixed thread counts and spill on scratch.

### 7.4 Local embeddings

- Candidates (open weights): Qwen3-Embedding (0.6B / 4B / 8B, Apache 2.0, the 8B
  scored 70.58 on MTEB Multilingual in mid-2025 per a third-party blog) and BGE-M3
  (dense, sparse and multi-vector in one model)
  ([PremAI ranking](https://blog.premai.io/best-embedding-models-for-rag-2026-ranked-by-mteb-score-cost-and-self-hosting)).
  For CPU-only hosts, the small variants are the realistic choice.
- No source I found ranks them on **legal** retrieval. The Massive Legal Embedding
  Benchmark (MLEB, [arXiv 2510.19365](https://arxiv.org/html/2510.19365v1)) exists,
  from Isaacus, whose own Kanon 2 Embedder tops it [vendor]; it is not confirmed as
  open-weight.
- **Run MLEB-style tests on a sample of the firm's own documents** (recall@10,
  latency, CPU throughput). Pair with a cross-encoder reranker. Embeddings run in a
  harness-side service or an indexer VM, never in an employee's VM.

### 7.5 Vector databases: pgvector, LanceDB, Qdrant

Evidence is practitioner-level; no rigorous 2026 head-to-head
([encore.dev](https://encore.dev/articles/best-vector-databases),
[alexcloudstar](https://alexcloudstar.com/blog/vector-database-comparison-2026/),
[Instaclustr](https://www.instaclustr.com/education/vector-database/pgvector-vs-qdrant-5-key-differences-and-how-to-choose/.md)).
- **pgvector:** already in the stack (Postgres). Described as production grade under
  about 10M vectors [unverified]. Performance depends on the HNSW index fitting in
  `shared_buffers`/RAM. Keep it on local disk. Easiest to enforce matter-level ACLs
  with SQL.
- **Qdrant:** strongest for heavy metadata filtering at low latency. A 2026 HPC paper
  found its insert throughput fell on Lustre because of its bounded update queue
  ([arXiv 2606.08950](https://arxiv.org/pdf/2606.08950)); keep its storage on local
  NVMe, not NFS.
- **LanceDB:** disk-first, designed to run on object stores and network file
  systems; weaker evidence and ecosystem ([LanceDB storage](https://docs.lancedb.com/storage)).
  The most plausible fit if the vector data must live on the NAS or in object
  storage.
- **For a firm-scale NAS:** firms of this size have perhaps 1 to 20 million chunks
  [estimate]. Start with pgvector in the harness Postgres. If it outgrows RAM, move to
  Qdrant on local NVMe, or LanceDB if the index must sit on the NAS. Decide with a
  bake-off on real data (VectorDBBench).
- Whichever is used, the VM reaches it only through `tools.vector_search`.

### 7.6 Legal-specific considerations

- **Confidentiality and consent.** ABA Formal Opinion 512 (2024-07-29) says a lawyer
  should obtain informed consent before putting client information into a
  "self-learning" generative AI tool, with a real explanation, not boilerplate
  ([summary](https://www.americanbar.org/groups/litigation/resources/newsletters/ethics-professionalism/generative-ai-lawyers-part-2-maintaining-confidentiality/)).
  Mike uses third-party model providers (OpenCode Go, OpenRouter) for prompts that
  contain client data. I did not verify their retention or training terms
  [unverified]. Write them down per provider before client data goes out.
- **Ethical walls and conflicts** (see 1.2): the VM's data view must match Mike's
  permissions.
- **Privilege and work-product** labelling: mark generated documents as drafts for
  attorney review; do not auto-file.
- **Citation integrity:** every figure from a filing carries accession number,
  document, section and, where possible, page or XBRL tag. A checker re-fetches and
  compares. Hallucinated case citations are a known professional-risk problem; Mike's
  verification subagents are the right place.
- **Retention and legal hold:** run traces and generated files can become records.
  Decide retention and whether snapshots count (later).
- **SEC data is public; derived joins with client data are not.** The report is
  confidential even if its inputs are not.

### Recommendation for Mike (data stack)

**Now (functional demo)**
- Pre-bake in the image: edgartools, duckdb, polars, pyarrow, pandas, docling,
  pdfplumber, python-docx, openpyxl, lxml, selectolax.
- SEC User-Agent set at the proxy; a shared cache and rate limit for `sec.gov`;
  respect 10 req/s globally.
- DuckDB-first prompt guidance; Parquet for derived data.
- Vector search: `tools.vector_search` over pgvector, even if it starts small.

**Soon**
- Parser bake-off on firm documents; OCR path.
- Embedding bake-off (Qwen3-Embedding-0.6B vs BGE-M3 vs others) on a legal sample.
- Mirror `submissions.zip` and `companyfacts.zip` to the NAS nightly.

**Later (NFR pass / RLM)**
- Dedicated indexer VM; vector DB scale-out decision (Qdrant or LanceDB).
- Provider data-policy review and client consent language.

---

## 8. Verifying code mode without a shadow mode

Prime Agent shows how a serious team verifies an agent rewrite
([Rust rewrite post](https://www.primeintellect.ai/blog/prime-agent-rust)): a
differential test suite runs old and new binaries against the **same scripted model**
and diffs terminal frames, session transcripts and the requests sent to the model
provider; each daemon protocol message type is checked against the original; a
feature audit marks components matching, partial or missing; reviewers use a
different model in a separate context; verification runs in fresh sandboxes; and the
team dogfooded daily and used agents to review beta users' traces. The post does not
describe tests of the REPL or kernels specifically, and does not use the terms
"golden traces" or "parity tests".

For Mike, with no shadow mode, use four layers:

### 8.1 Deterministic harness tests (no real model)

- **Scripted model:** a fake LLM that returns pre-recorded cells and answers. Run the
  real kernel, supervisor, ssh/vsock path, dispatcher, proxy and DB. Assert on the
  exact event stream and DB rows. This is where protocol bugs, ordering bugs and
  interruption bugs die.
- **Golden transcripts:** record a real run (model outputs, tool results). Replay
  with the model replaced by the recording. Any harness change that alters the
  event stream must be reviewed and the golden updated deliberately.
- **Protocol conformance:** a test suite for the runner against Prime's
  `repl.md` rules: exactly one `done` per request; `host_reply` for a cancelled cell
  is dropped; oversized payload raises `ValueError`; interrupt survives; malformed
  line gives `ProtocolError`; stdin close shuts down.
- **Fuzzing the frame parser** with malformed, huge, nested and duplicate-id frames.

### 8.2 Scenario tasks with checkers

- About 40 tasks (the earlier note's list), each with a programmatic checker (the
  MCPMark pattern: a verification script on the final state,
  [MCPMark](https://arxiv.org/pdf/2509.24002)). Add the code-mode-specific ones from
  this report: SEC pull and join, 200-document fan-out, a crash in the middle, a
  budget stop, and a morning report check.
- Run each task four times per model; report **pass@1 and pass^4** (tau-bench,
  [arXiv](https://arxiv.org/pdf/2406.12045)).
- Framework option: Inspect AI from the UK AI Security Institute has datasets,
  solvers, scorers and a log viewer, and supports sandboxed tool execution
  ([Inspect](https://inspect.aisi.org.uk)). Mike's own TypeScript harness script is
  fine; Inspect is worth reading for scorer and log design.

### 8.3 Fault and attack injection

- **Faults:** kill the kernel mid-cell; OOM the kernel; kill sshd; restart the
  backend with a request in flight; stop the proxy; fill the scratch disk; delay a
  `host_reply` past the cell timeout; restore the VM from a snapshot mid-run.
  Assert: no duplicated side effects, no lost user data, the model gets a truthful
  message, the run ends in a defined state.
- **Attacks:** a corpus of injected instructions in web pages, PDFs, spreadsheet
  cells and email (AgentDojo-style tasks;
  [CaMeL paper](https://arxiv.org/abs/2503.18813) describes the benchmark).
  **Canary secrets:** plant unique strings in private documents; fail if any appears
  in proxy logs, the outbox or an artifact sent out. Because adaptive attackers beat
  fixed corpora ([arXiv 2510.09023](https://arxiv.org/abs/2510.09023)), treat this
  as a regression suite for the deterministic controls, not as proof of safety.
- **Proxy adversarial tests:** trailing dot, case, bracketed IPv6, decimal IP,
  redirect to private, DNS rebinding, CONNECT to non-443 ports.

### 8.4 Trace review and regression

- Store every run's trace tree (5.1). Review 5% of runs weekly plus all failures and
  all runs with injection flags; a different-model triage pass can summarise, but a
  person reads the flagged ones.
- Every bug becomes a recorded scenario in the regression suite.
- Track weekly: success rate by task family, cost per success, kernel restarts per
  100 runs, OOM kills, budget stops, approval rates, and the share of cells that fail
  to parse.

### Recommendation for Mike (verification)

**Now (functional demo)**
- Scripted-model harness tests plus protocol conformance and frame fuzz tests.
- 15 to 20 scenario tasks with checkers, including three canary and three fault
  tests. Four runs each on one flash model.
- A per-model code-mode smoke test (parsing, `\n` repair, `host_request` use) gating
  model enablement.

**Soon**
- Full 40-task set across the three flash models; pass^4 reporting; golden
  transcripts for the demo flows.
- Weekly trace review routine.

**Later (NFR pass / RLM)**
- RLM two-arm eval; an automated nightly regression run; adaptive red-teaming.

---

## 9. Consolidated recommendations

Effort: S = about a day or less, M = two to five days, L = more than a week
[all estimates].

| # | Item | Why | When | Effort |
|---|---|---|---|---|
| 1 | Upgrade Cloud Hypervisor to >= 52.0; explicit `image_type=raw`; `--landlock`; per-VM unprivileged uid and systemd sandbox | CVE-2026-27211 and CVE-2026-45782 hit guest-writable raw block disks | Now | S |
| 2 | Long-lived ssh channel per kernel; JSON-lines frames; no bytes in frames | Avoids 150 to 500 ms per fresh ssh and 33% base64 inflation | Now | S |
| 3 | Micro-benchmark script (start, cell, RTT, file transfer) on node-a | No measured numbers exist; decisions depend on them | Now | S |
| 4 | Separate scratch disk, not snapshotted | Keeps per-turn snapshots small; DuckDB spill is heavy | Now | S |
| 5 | Kernel in own cgroup slice; protected sshd; zram; `kernel_exit` event and restore | A runaway cell must not take the VM down | Now | M |
| 6 | Dill snapshot at turn end with caps | Kernel recovery; prerequisite for overnight resume | Now | M |
| 7 | Email outbox with human approval; sends off overnight | Breaks the exfiltration leg for email | Now | M |
| 8 | Run-level taint bit gating outbound tools | Cheap, deterministic Rule of Two | Now | M |
| 9 | Frame validation, request caps, idempotency keys, per-run budgets | VM output is untrusted; crash-safe side effects | Now | M |
| 10 | Egress modes open/closed (manual toggle) and a short allowlist | Removes the network leg once private data is loaded | Now | M |
| 11 | Pre-baked Python image; PyPI allowlist; log installs | Slopsquatting and supply chain | Now | S |
| 12 | `llm()`/`llm_batch()` as tool-less host requests; budget ledger; cost rows; `SUBMIT` | Keeps the door open for RLM; useful for fan-out now | Now | M |
| 13 | Progress file and JSON task list; heartbeats; kill switch; morning report | Overnight reliability and review | Now | M |
| 14 | Scripted-model tests, protocol conformance, frame fuzz | Verification without shadow mode | Now | M |
| 15 | 15 to 20 scenario tasks with checkers; canaries; pass^4 | Behaviour regression | Now | M |
| 16 | Per-model code-mode smoke test | No open-weight data on the `\n` failure | Now | S |
| 17 | SEC shared cache + rate limiter + User-Agent at the proxy | 10 req/s limit is per client; all VMs share one IP | Soon | M |
| 18 | NAS read-only mount per employee (NFS pinhole or virtio-fs) with NAS snapshot id in the trace | Terabytes of data; ethical walls | Soon | M |
| 19 | `tools.vector_search` over pgvector; embedding bake-off | VM never touches the DB | Soon | M |
| 20 | Automatic egress switching; per-VM dynamic ACL | Removes manual step | Soon | M |
| 21 | Watchdog, graduated compaction, host-reboot reconciliation | Long-run failure modes | Soon | M |
| 22 | `Corpus` lazy objects; prompt packs; RLM two-arm eval | Decide RLM per model with data | Soon | L |
| 23 | Trace tree viewer; `.ipynb` export | Review and trust | Soon | M |
| 24 | Document parser bake-off; OCR path | Table fidelity and cost | Soon | M |
| 25 | Skills directory (reviewed, read-only shared) | How code mode grows safely | Soon | S |
| 26 | Disk rate limits, io weights, CPUWeight tuning from measurements | Contention with several overnight jobs | Soon | M |
| 27 | Memory overcommit, balloon, KSM, hugepages tuning | Density once more firms/VMs exist | Later | M |
| 28 | PII tokenization at the model boundary | Provider exposure; outbound leak control | Later | L |
| 29 | Off-host immutable logs and snapshots; auth hardening | Owner's NFR pass | Later | L |
| 30 | `agent()` recursion beyond depth 1; fine-tuning on traces | Only if the eval shows gains | Later | L |
| 31 | CaMeL-style value-level taint | Research-grade | Later | L |
| 32 | Dedicated indexer VM; vector DB scale-out | Terabyte-scale NAS and a large vector DB | Later | L |
| 33 | TLS interception | Only if a path-level policy is required | Later | M |
| 34 | Temporal or DBOS | Only for cross-host workflows | Later | L |

---

## 10. Claims I could not verify, and open questions

Not verified or secondary only:
- **Harvey in production.** The Harvey post is a primary source for RLM research with
  published numbers. It does not say the RLM harness is deployed to customers. No
  other source I found confirms production use.
- **Open-weight performance in code mode.** The one large programmatic tool calling
  study tested no open-weight model. The claim that the flash models write Python
  code mode reliably is untested.
- **"Think, But Don't Overthink"** findings (depth and simple tasks) come from search
  summaries; the PDF text was unreadable.
- **Polars 2.0 (2026-10-06)** appears in one Spanish-language article only.
- **Opus 4.8 / Opus 5 injection rates** are second-hand from system-card coverage.
- **Whether Cloud Hypervisor has an equivalent of Firecracker's CVE-2026-5747.**
- **The Cloud Hypervisor version running on node-a** and its exact option names for
  explicit image typing.
- **Hugepages with balloon** and **free page reporting** behaviour on this stack.
- **cgroup io weights on btrfs over md RAID1.**
- **All latency figures for `host_request`, kernel start and ssh over vsock** are
  estimates; none were measured here.
- **OpenCode Go and OpenRouter data policies** (retention, training, regions).
- **Model names** (DeepSeek V4.1 Flash, GLM-5.3-Flash, Muse Spark) are as given by the
  owner; I did not verify them or their code ability.
- **PyMuPDF licence** (AGPL or commercial) is from general knowledge.
- **Harvey LAB task count** differs by source (1,200+ vs 1,671).

Open questions for the owner:
1. How should the NAS view be scoped per employee (ethical walls)? Does the NAS
   support per-user exports or snapshots?
2. Is node-a's md RAID1 made of SSDs or HDDs?
3. Should unattended runs be allowed any outbound action other than drafting?
4. How many employees and concurrent overnight runs should the demo plan for?
5. Which provider terms have been reviewed for client data?

---

## Sources

Repo documents
- [code-mode-research-2026-10-10.md](code-mode-research-2026-10-10.md)
- [goals/mission-13-workstation-vms.md](../../goals/mission-13-workstation-vms.md)
- [goals/pi-durable-decision-2026-10-08.md](../../goals/pi-durable-decision-2026-10-08.md)
- [goals/station-9-code-execution-and-rlm.md](../../goals/station-9-code-execution-and-rlm.md)
- [docs/backend-architecture.md](../backend-architecture.md)

RLM and related
- Zhang, Kraska, Khattab, Recursive Language Models: https://arxiv.org/abs/2512.24601
- Prime Intellect, Recursive Language Models: the paradigm of 2026: https://www.primeintellect.ai/blog/rlm
- Prime Agent: https://github.com/PrimeIntellect-ai/prime-agent
- Prime Agent REPL protocol: https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/prime-agent-runtime/src/rlm/repl.md
- Prime Intellect, Rewriting Prime Agent in Rust: https://www.primeintellect.ai/blog/prime-agent-rust
- alexzhang13/rlm: https://github.com/alexzhang13/rlm
- DSPy RLM: https://dspy.ai/api/modules/RLM/ and https://dspy.ai/diving-deeper/rlm/
- Harvey, Post-Training RLM Agents for End-to-End M&A Diligence: https://www.harvey.ai/blog/post-training-rlm-agents-for-m-and-a-diligence
- Harvey Legal Agent Benchmark: https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark
- Think, But Don't Overthink: https://arxiv.org/abs/2603.02615
- oh-my-pi: https://github.com/can1357/oh-my-pi
- The Bitter Lesson of Tool Calling: https://arxiv.org/html/2608.06370v1
- Anthropic, programmatic tool calling: https://platform.claude.com/docs/agents-and-tools/tool-use/programmatic-tool-calling
- Anthropic, code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Agent Skills overview: https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure
- Cloudflare Code Mode: https://blog.cloudflare.com/code-mode/
- Pydantic Monty: https://pydantic.dev/articles/pydantic-monty
- CodeAct (ICLR 2024): https://www.iclr.cc/virtual/2024/22224
- smolagents secure execution: https://huggingface.co/docs/smolagents/main/tutorials/secure_code_execution.md
- smolagents CVE-2025-5120: https://nvd.nist.gov/vuln/detail/CVE-2025-5120
- Durable execution comparisons: https://alatirok.com/durable-execution-ai-agents-compared/ and https://respan.ai/market-map/compare/dbos-vs-temporal

Security
- Willison, the lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Willison on Agents Rule of Two and Attacker Moves Second: https://simonw.substack.com/p/new-prompt-injection-papers-agents
- The Attacker Moves Second: https://arxiv.org/abs/2510.09023
- CaMeL: https://arxiv.org/abs/2503.18813 and https://simonwillison.net/2025/Apr/11/camel/
- FIDES: https://arxiv.org/abs/2505.23643 and https://github.com/microsoft/fides
- Design Patterns for Securing LLM Agents: https://arxiv.org/pdf/2506.08837
- Anthropic, prompt injection defenses: https://www.anthropic.com/news/prompt-injection-defenses
- VentureBeat on later Anthropic figures: https://venturebeat.com/security/anthropic-browser-agent-hijacked-31-percent-before-safeguards-engaged
- OpenAI on Atlas (via TechCrunch): https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/
- Poisoned MCP tool descriptions: https://thehackernews.com/2026/06/microsoft-warns-poisoned-mcp-tool.html
- AI agent security breaches 2026 roundup: https://beam.ai/agentic-insights/ai-agent-security-breaches-2026-lessons
- Cloud Hypervisor GHSA-jmr4-g2hv-mjj6 (CVE-2026-27211): https://github.com/cloud-hypervisor/cloud-hypervisor/security/advisories/GHSA-jmr4-g2hv-mjj6
- Cloud Hypervisor GHSA-f47p-p25q-83rh (CVE-2026-45782): https://github.com/cloud-hypervisor/cloud-hypervisor/security/advisories/GHSA-f47p-p25q-83rh
- Cloud Hypervisor v52.0 release: https://www.cloudhypervisor.org/blog/cloud-hypervisor-v52.0-released/
- Firecracker CVE-2026-5747: https://nvd.nist.gov/vuln/detail/CVE-2026-5747
- tinyproxy CVE-2025-63938: https://nvd.nist.gov/vuln/detail/CVE-2025-63938
- Egress allowlist vs TLS interception: https://www.agentpatterns.ai/security/hostname-allowlist-tls-blind-spot/ and https://blaxel.ai/blog/sandbox-egress-control-outbound-allow-listing
- Smokescreen bypass CVEs: https://www.wiz.io/vulnerability-database/cve/cve-2022-24825 and https://osv.dev/vulnerability/CVE-2022-29188
- KSM side channel: https://www.opencve.io/cve/CVE-2015-2877 and https://pve.proxmox.com/wiki/Kernel_Samepage_Merging_(KSM)
- Slopsquatting: https://dzone.com/articles/Slopsquatting-supply-chain-attack and https://nesbitt.io/2025/12/10/slopsquatting-meets-dependency-confusion
- Presidio reversible anonymization: https://python.langchain.com/docs/guides/privacy/presidio_data_anonymization/reversible

Performance and memory
- Cloud Hypervisor docs: https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/main/docs/vsock.md, /fs.md, /balloon.md, /memory.md, /io_throttling.md (same base URL)
- virtio-vsock latency patch: https://gitlab.freedesktop.org/drm/misc/kernel/-/commit/efcd71af38be403fa52223092f79ada446e121ba
- virtio-blk vs virtio-fs thread: https://listman.redhat.com/archives/virtio-fs/2022-July/005068.html
- virtio-fs DAX patch series: https://lkml.iu.edu/hypermail/linux/kernel/1908.2/05325.html
- Firecracker vs Cloud Hypervisor: https://northflank.com/blog/firecracker-vs-cloud-hypervisor and https://arxiv.org/pdf/2310.03522
- SSH multiplexing: https://www.techrepublic.com/article/how-to-use-multiplexing-to-speed-up-the-ssh/ and https://en.wikibooks.org/wiki/OpenSSH/Cookbook/Multiplexing
- SSH performance: https://papers.FreeBSD.org/2017/bsdcan/jude-ssh_performance.files/Paper_-_SSH_Performance.pdf and https://lists.mindrot.org/pipermail/openssh-unix-dev/2026-April/042440.html
- msgspec benchmarks: https://jcristharif.com/msgspec/benchmarks.html
- MessagePack vs JSON: https://abacktools.com/blog/messagepack-vs-json
- Python startup in notebooks: https://git.odin.cse.buffalo.edu/ODIn/paper-ParallelPython-Short/blame/commit/8b30a85a7e5c0be222afdc3384cf5989af5302a2/sections/experiments.tex
- Python 3.14 free-threading and subinterpreters: https://cloudsmith.com/blog/python-3-14-what-you-need-to-know.md, https://theregister.com/software/2025/10/08/python-314-released-with-cautious-free-threaded-support/349336, https://scour.ing/@blake.rain/p/https://blog.changs.co.uk/i-was-wrong-about-subinterpreters.html
- Python 3.14 multiprocessing: https://docs.python.org/3.14/library/multiprocessing.html
- PEP 768: https://peps.python.org/pep-0768
- glibc memory behaviour: https://bugs.python.org/msg316359 and https://discuss.python.org/t/using-malloc-trim-to-help-with-memory-management/107682
- cgroup memory.high: https://android-kvm.googlesource.com/linux/+/0e4b01df865935007bd712cbc8e7299005b28894 and https://stackharbor.com/en/knowledge-base/systemd-oomd-memory-pressure-tuning/
- btrfs and VM images: https://listman.redhat.com/archives/libvir-list/2020-July/205116.html and https://forum.rockstor.com/t/vm-storage-nodatacow/556
- dill notes: https://sources.debian.org/src/dill/0.2.9-1/README.md/

Data stack
- DuckDB memory management: https://duckdb.org/2024/07/09/memory-management.html
- DuckDB tuning guide: https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads
- DuckDB environment (NAS): https://duckdb.org/docs/current/guides/performance/environment
- DuckDB file formats: https://duckdb.org/docs/lts/guides/performance/file_formats.html
- Polars benchmarks: https://www.pola.rs/posts/benchmarks/
- Coiled TPC-H: https://docs.coiled.io/blog/tpch
- DuckDB vs Polars memory test: https://python.plainenglish.io/i-gave-a-16-gb-mac-a-26-gb-dataset-duckdb-answered-in-440-mb-of-ram-58db5f5acd4b
- Polars 2.0 article: https://ecosistemastartup.com/polars-2-0-streaming-por-defecto-y-sql-nativo/
- NFS mount options: https://docs.cloud.google.com/netapp/volumes/docs/connect-clients/linux-nfs-mount-options
- NFS vs SMB (2014): https://lkml.rescloud.iu.edu/1407.2/00001.html
- SEC accessing EDGAR data: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- SEC API documentation: https://www.sec.gov/edgar/sec-api-documentation
- edgartools: https://edgartools.readthedocs.io/ and https://edgartools.readthedocs.io/en/latest/resources/sec-compliance/
- PDF parsing comparisons: https://www.ertas.ai/blog/pdf-parsing-accuracy-benchmark-docling-unstructured, https://dev.to/vtempest/pdf-gec, https://hyper.ai/en/papers/2408.09869
- Embedding models: https://blog.premai.io/best-embedding-models-for-rag-2026-ranked-by-mteb-score-cost-and-self-hosting
- MLEB: https://arxiv.org/html/2510.19365v1
- Vector DB comparisons: https://encore.dev/articles/best-vector-databases, https://alexcloudstar.com/blog/vector-database-comparison-2026/, https://www.instaclustr.com/education/vector-database/pgvector-vs-qdrant-5-key-differences-and-how-to-choose/.md
- Vector DBs on HPC storage: https://arxiv.org/pdf/2606.08950
- LanceDB storage: https://docs.lancedb.com/storage
- ABA Formal Opinion 512 summary: https://www.americanbar.org/groups/litigation/resources/newsletters/ethics-professionalism/generative-ai-lawyers-part-2-maintaining-confidentiality/

Long runs and verification
- OpenDev / terminal agents paper: https://arxiv.org/html/2603.05344v1
- Compaction traps: https://tianpan.co/blog/2026/04/19/compaction-traps-long-running-agents
- MCPMark: https://arxiv.org/pdf/2509.24002
- tau-bench: https://arxiv.org/pdf/2406.12045
- Inspect AI: https://inspect.aisi.org.uk
