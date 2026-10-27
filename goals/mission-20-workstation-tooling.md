---
readiness: owner direction 2026-10-27 ("design and implement" the published
workstation-tooling note, all of it, including the machine work); phased
---

# Mission 20: Workstation tooling, and the two things after it

Source: the published note "Workstation tooling, and the two things after it"
(2026-10-26), written against a guest that had spent a day hand-installing
capabilities into `/home/agent/pylibs`. The owner settled the direction on
2026-10-27: the answer is a **standard environment for every user** that can
**check tools out of the Nix store on demand** — not a bigger `guest.nix`
package list.

## Why

The guest as shipped cannot get software. The store is a read-only disk
image, `nix` is not on PATH, and pip reaches only `/home/agent/pylibs`,
invisible to the default interpreter. Four capabilities were installed by
hand that day; each cost an afternoon, none is documented where the next
agent looks, and every one fails silently for anyone who assumes the
interpreter is what it appears to be.

## Decisions (owner, 2026-10-27)

- **Standard env for all users.** Every VM gets the same mechanism; nothing
  special for the VM that wrote the note.
- **Tools are checked out of the Nix store on demand.** The mechanism is a
  writable store overlay plus the `nix` CLI and a `layer` wrapper — not
  baking heavy packages into `guest.nix`. A fetched closure lands once,
  persists on the home disk, and is re-entered by store path afterwards.
- The full ordered list from the note stands (below), with the OCR choice
  made by measurement, not reputation.

## The items, in the note's order

Machine side (`infra/workstation/guest.nix`, `infra/node-a/workstations.nix`):

1. **`nix` back, layer entry a logged event.** `nix.enable = true`,
   `microvm.writableStoreOverlay` pointing at a persistent directory on the
   home disk (fetched closures survive reboot and ride the snapshot story),
   the host's own nixpkgs as the flake registry pin (no eval-time network),
   and `cache.nixos.org` substitutes through the egress proxy (read: already
   unrestricted CONNECT). A `layer` wrapper in the guest:
   `layer use <name> -- <cmd>` resolves the name in `/etc/layers.json`,
   `nix build`s the package through the proxy if it is not already in the
   store, records name + store path + stated reason in a **host-side
   ledger** (vsock relay, same shape as the vault relay, landing in the
   journal on the host), enters via a per-shell PATH, and revokes at exit.
   Fetched closures stay under a GC root so `nix gc` does not eat them.
   Persist `/nix/var` on the home disk so the Nix db knows the fetched
   paths across reboots; `microvm.registerClosure` (already on when
   `nix.enable`) re-loads the base closure each boot regardless.
2. **Python layer.** `python3.withPackages` env as a fetchable layer
   (pip-installed packages on top, into `~/pylibs` on the shared venv —
   kills the invisible-wheels failure class).
3. **OCR layer — chosen by measurement.** Corpus benchmark: ~200 pages
   stratified (digital text layer, clean scan, degraded scan, dense tables,
   two columns, handwriting), 40 hand-transcribed for ground truth; CER,
   table-cell exactness, ms/page, peak RSS, implied escalation rate at a
   fixed quality floor. Candidates: RapidOCR/PP-OCRv6 (in nixpkgs),
   Tesseract (baseline), Indra OCR (pip; licensing unsettled — Apache repo,
   OpenRAIL model card), LightOnOCR-3-1B as an escalation candidate. Policy
   the harness enforces regardless of winner: never OCR a page with a text
   layer; escalate per page on evidence (mean confidence, empty blocks,
   table density, handwriting) budgeted near 5%; mark machine-read text;
   cache by `content_sha256`. Harness + numbers ship with the layer so the
   choice is re-testable.
4. **Browser layer.** Chromium for print-to-PDF and JS pages; never in the
   base image.
5. **Fonts layer.** ~6 text faces (~20 MB), a fontconfig file the layer
   exports.

Repo side:

6. **Publish lifecycle.** Publications point at a document and follow its
   versions; revoke and expiry editable afterwards. (Existing
   `publications.*` already publishes a rendition; this closes the loop.)
7. **Documents shared by default.** De-silo across conversations, with a
   `confidential` flag honoured everywhere. The failure mode to design
   against is cross-client leakage — disqualifying, not inconvenient.
8. **Capability manifest the agent can query.** Name, purpose, size, what
   it unlocks, how to enter it — for layers *and* tools. One source; the
   guest reads it, the backend embeds it in turn context, and the README's
   capability list is generated from it.
9. **Self-describing signatures at the point of use.** The turn context
   states each surface's accepted inputs (the audio/video formats case:
   documented in help text, discovered only after a workaround). A line in
   context, not a hunt.

After the machine work:

10. **Composer queue.** Writing stays enabled during a turn; entries queue
    visibly, send as individual turns in order. Queue state persists per
    chat like drafts; model+effort stamped at queue time; attachments
    upload on queue; stop pauses (surfaces, doesn't discard); failed turn
    pauses; branching clears or rewrites visibly; queued sends go through
    normal turn admission.
11. **Docs audit.** One page per shipped capability (state, not changelog);
    pages describing removed behaviour get deleted; volatile facts carry a
    date and re-read instruction; README capability list generated from the
    manifest; CI fails a route/module/tool with neither a page nor an
    allowlist entry.

## Ordering

Machine items 1–2 first (everything else rides on them), then 8–9 cheap
(they carry the layer manifest to the model), 3–5 as layers land, then the
repo features 6–7 (7 last — authorization blast radius), then 10–11.

## How we know it worked

The note's three numbers, per session on a real VM: time from request to
first working tool; failures caused by a missing capability rather than a
mistake; share of tasks that needed a workaround. Baseline (the day the
note was written): minutes, four, roughly half.

## Verification constraints

`nix build` of the guest runs on the dev lane (aarch64-linux builder or
the Docker lane in the README); `nix eval` of the config runs on the Mac.
Booting the dev VM and exercising `layer` end-to-end happens on node-a
through `ws ssh ws-owner`, after the host module carries the ledger
socket. Deploys to node-a follow the same 10-minute rollback timer
convention as generation 51+ (goals/STATUS.md §5).
