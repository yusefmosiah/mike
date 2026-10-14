#!/usr/bin/env bash
# Rebuild the owner's workstation home directory as it stood at T0 and,
# optionally, load it into a pool VM for a replay. Runs on node-a as root.
#
#   replay-baseline.sh --t0 2026-10-11T19:52:37Z [--exclude-chat <chat-id>]... --dry-run
#   replay-baseline.sh --t0 2026-10-11T19:52:37Z --exclude-chat <chat-id> --out /root/baseline.tgz
#   replay-baseline.sh --t0 ... --out /root/baseline.tgz --load ws-03 --wipe
#
# For each regular file or symlink under /home/agent it takes:
#   1. the owner VM's current copy, if its mtime is before T0;
#   2. else the copy in the newest host snapshot taken before T0 (its home.img
#      is attached read-only through a loop device);
#   3. else nothing (created or changed after T0 with no earlier copy).
# Caches (.cache, .npm, node_modules) and the code-mode kernel snapshots of
# the replayed chats (~/.mike/kernels/<chat-id>*) are left out.
#
# Options:
#   --t0 <time>            T0, anything `date -d` reads (or --t0-epoch <seconds>)
#   --owner-vm <vm>        source VM (default ws-owner)
#   --snapshot <name>      use this snapshot instead of the newest before T0
#   --snapshot-dir <dir>   host snapshot root (default /var/lib/workstation-snapshots)
#   --exclude-chat <id>    leave out ~/.mike/kernels/<id>* (repeatable)
#   --all-kernels          leave out every kernel snapshot
#   --out <file.tgz>       tarball to write (default ./baseline-<T0>.tgz)
#   --load <pool-vm>       extract the tarball into this pool VM's /home/agent
#   --wipe                 `ws wipe <pool-vm>` before loading
#   --dry-run              list what would be included (source, size, path) and stop
#   --keep-work            keep the staging directory
#
# Test hook (no VM, no root): print the selection for two listings in the
# `find -printf '%y\t%T@\t%s\t%P\n'` format, one "<source>\t<path>" per line.
#   replay-baseline.sh --select <current-listing> <snapshot-listing|/dev/null> --t0-epoch <s> [--exclude-chat <id>]...
#
# Nothing here touches the owner VM except reads (find, tar -c over `ws ssh`).
set -euo pipefail

OWNER_VM=ws-owner
SNAPSHOT_DIR=/var/lib/workstation-snapshots
T0=""
T0_EPOCH=""
SNAPSHOT=""
EXCLUDE_CHATS=""
ALL_KERNELS=0
OUT=""
LOAD_VM=""
WIPE=0
DRY_RUN=0
KEEP_WORK=0
SELECT_CURRENT=""
SELECT_SNAPSHOT=""
LISTING_FORMAT='%y\t%T@\t%s\t%P\n'

die() { echo "replay-baseline: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --t0) T0=${2:?}; shift 2 ;;
    --t0-epoch) T0_EPOCH=${2:?}; shift 2 ;;
    --owner-vm) OWNER_VM=${2:?}; shift 2 ;;
    --snapshot) SNAPSHOT=${2:?}; shift 2 ;;
    --snapshot-dir) SNAPSHOT_DIR=${2:?}; shift 2 ;;
    --exclude-chat) EXCLUDE_CHATS="${EXCLUDE_CHATS:+$EXCLUDE_CHATS,}${2:?}"; shift 2 ;;
    --all-kernels) ALL_KERNELS=1; shift ;;
    --out) OUT=${2:?}; shift 2 ;;
    --load) LOAD_VM=${2:?}; shift 2 ;;
    --wipe) WIPE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --keep-work) KEEP_WORK=1; shift ;;
    --select) SELECT_CURRENT=${2:?}; SELECT_SNAPSHOT=${3:?}; shift 3 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# select_paths CURRENT SNAPSHOT: "<current|snapshot|absent|excluded>\t<path>"
# per path. files.mts planBaseline is the same rule; keep them in step.
select_paths() {
  awk -F'\t' -v t0="$T0_EPOCH" -v curfile="$1" -v chats="$EXCLUDE_CHATS" -v allk="$ALL_KERNELS" '
    function rel(   p, i) { p = $4; for (i = 5; i <= NF; i++) p = p "\t" $i; sub(/^\.\//, "", p); return p }
    function excluded(p,   n, seg, i, name, c, m) {
      n = split(p, seg, "/")
      for (i = 1; i <= n; i++) if (seg[i] == ".cache" || seg[i] == ".npm" || seg[i] == "node_modules") return "cache"
      if (index(p, ".mike/kernels/") == 1) {
        if (allk == 1) return "kernel"
        name = substr(p, length(".mike/kernels/") + 1)
        m = split(chats, c, ",")
        for (i = 1; i <= m; i++) if (c[i] != "" && index(name, c[i]) == 1) return "kernel"
      }
      return ""
    }
    NF >= 4 && ($1 == "f" || $1 == "l") {
      p = rel()
      if (p == "") next
      all[p] = 1
      if (FILENAME == curfile) { cur[p] = 1; curt[p] = $2 } else { snap[p] = 1 }
    }
    END {
      for (p in all) {
        r = excluded(p)
        if (r != "") { print "excluded\t" p; continue }
        if ((p in cur) && (curt[p] + 0) < (t0 + 0)) print "current\t" p
        else if (p in snap) print "snapshot\t" p
        else print "absent\t" p
      }
    }' "$1" "$2" | LC_ALL=C sort -t "$(printf '\t')" -k2
}

if [ -n "$SELECT_CURRENT" ]; then
  [ -n "$T0_EPOCH" ] || die "--select needs --t0-epoch"
  select_paths "$SELECT_CURRENT" "$SELECT_SNAPSHOT"
  exit 0
fi

[ "$(id -u)" = 0 ] || die "run as root on node-a"
command -v ws >/dev/null || die "the ws tool is not on PATH"
if [ -z "$T0_EPOCH" ]; then
  [ -n "$T0" ] || die "--t0 is required"
  T0_EPOCH=$(date -u -d "$T0" +%s) || die "cannot read --t0 $T0"
fi
T0_STAMP=$(date -u -d "@$T0_EPOCH" +%Y%m%dT%H%M%SZ)
case "$OWNER_VM" in ws-0[0-9]) die "--owner-vm must be the owner's VM, not a pool VM" ;; esac
if [ -n "$LOAD_VM" ]; then
  case "$LOAD_VM" in ws-0[0-9]) ;; *) die "--load only takes a pool VM (ws-01..ws-09), never $LOAD_VM" ;; esac
fi
OUT=${OUT:-$PWD/baseline-$T0_STAMP.tgz}

# Newest snapshot strictly before T0; names start with a sortable UTC stamp.
if [ -z "$SNAPSHOT" ]; then
  SNAPSHOT=$(ws snapshots "$OWNER_VM" | awk -v t="$T0_STAMP" 'substr($0, 1, 16) < t' | LC_ALL=C sort | tail -n 1 || true)
fi
echo "T0: $(date -u -d "@$T0_EPOCH" +%FT%TZ) ($T0_EPOCH)" >&2
echo "snapshot: ${SNAPSHOT:-none before T0}" >&2

WORK=$(mktemp -d /tmp/replay-baseline.XXXXXX)
MNT="$WORK/snapshot"
LOOP=""
cleanup() {
  if mountpoint -q "$MNT" 2>/dev/null; then umount "$MNT" || true; fi
  if [ -n "$LOOP" ]; then losetup -d "$LOOP" || true; fi
  if [ "$KEEP_WORK" = 1 ]; then echo "work dir kept: $WORK" >&2; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# Current tree, read in the VM as agent.
ws ssh "$OWNER_VM" "find /home/agent -mindepth 1 -printf '$LISTING_FORMAT'" > "$WORK/current.list" \
  || echo "warning: find in $OWNER_VM reported errors; unreadable paths are left out" >&2
[ -s "$WORK/current.list" ] || die "could not list $OWNER_VM's home directory"

# Snapshot tree, from its disk image attached read-only (noload: never replay
# the journal of a crash-consistent image).
: > "$WORK/snapshot.list"
if [ -n "$SNAPSHOT" ]; then
  IMG="$SNAPSHOT_DIR/$OWNER_VM/$SNAPSHOT/home.img"
  [ -f "$IMG" ] || die "no image at $IMG"
  mkdir -p "$MNT"
  LOOP=$(losetup --find --show --read-only "$IMG")
  mount -t ext4 -o ro,noload "$LOOP" "$MNT"
  [ -d "$MNT/agent" ] || die "the snapshot has no agent home directory"
  find "$MNT/agent" -mindepth 1 -printf "$LISTING_FORMAT" > "$WORK/snapshot.list"
fi

select_paths "$WORK/current.list" "$WORK/snapshot.list" > "$WORK/plan.tsv"
count() { awk -F'\t' -v s="$1" '$1 == s' "$WORK/plan.tsv" | wc -l | tr -d ' '; }
echo "include: $(count current) current + $(count snapshot) from snapshot; absent: $(count absent); excluded: $(count excluded)" >&2

if [ "$DRY_RUN" = 1 ]; then
  # source, size, path for every included file; absent/excluded after.
  awk -F'\t' '
    FILENAME == ARGV[1] { p = $4; for (i = 5; i <= NF; i++) p = p "\t" $i; cs[p] = $3; next }
    FILENAME == ARGV[2] { p = $4; for (i = 5; i <= NF; i++) p = p "\t" $i; ss[p] = $3; next }
    { p = $2; for (i = 3; i <= NF; i++) p = p "\t" $i
      size = ($1 == "current") ? cs[p] : ($1 == "snapshot") ? ss[p] : "-"
      print $1 "\t" size "\t" p }' "$WORK/current.list" "$WORK/snapshot.list" "$WORK/plan.tsv"
  exit 0
fi

STAGE="$WORK/home"
mkdir -p "$STAGE"
awk -F'\t' '$1 == "snapshot" { sub(/^[^\t]*\t/, ""); printf "%s%c", $0, 0 }' "$WORK/plan.tsv" > "$WORK/snapshot.paths"
awk -F'\t' '$1 == "current" { sub(/^[^\t]*\t/, ""); printf "%s%c", $0, 0 }' "$WORK/plan.tsv" > "$WORK/current.paths"
if [ -s "$WORK/snapshot.paths" ]; then
  tar -C "$MNT/agent" --null -T "$WORK/snapshot.paths" -cf - | tar -C "$STAGE" -xf -
fi
if [ -s "$WORK/current.paths" ]; then
  # GNU tar exits 1 when a file changed or vanished while it was read; that
  # file is still listed, so warn and carry on rather than abort.
  rc=0
  ws ssh "$OWNER_VM" "tar -C /home/agent --null -T - -cf -" < "$WORK/current.paths" > "$WORK/current.tar" || rc=$?
  [ "$rc" -le 1 ] || die "reading current files from $OWNER_VM failed (exit $rc)"
  [ "$rc" = 0 ] || echo "warning: some current files changed or vanished while they were copied" >&2
  tar -C "$STAGE" -xf "$WORK/current.tar"
fi
# A current file written between the listing and the copy is newer than T0.
LATE=$(find "$STAGE" -type f -newermt "@$T0_EPOCH" | wc -l | tr -d ' ')
[ "$LATE" = 0 ] || echo "warning: $LATE staged files are newer than T0 (written during the copy?)" >&2

tar -C "$STAGE" --numeric-owner -czf "$OUT" .
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))" >&2

if [ -n "$LOAD_VM" ]; then
  if [ "$WIPE" = 1 ]; then ws wipe "$LOAD_VM"; fi
  EXISTING=$(ws ssh "$LOAD_VM" "find /home/agent -mindepth 1 -not -path '/home/agent/.ssh*' | wc -l")
  [ "$EXISTING" -le 10 ] || echo "warning: $LOAD_VM already holds $EXISTING entries; pass --wipe for a clean start" >&2
  ws ssh "$LOAD_VM" "tar -C /home/agent -xzf -" < "$OUT"
  LOADED=$(ws ssh "$LOAD_VM" "find /home/agent -mindepth 1 -type f | wc -l")
  echo "loaded into $LOAD_VM: $LOADED files under /home/agent" >&2
fi
