/**
 * Workstation file listings: parsing `find -printf` output, choosing the
 * baseline home directory at T0 (the same rule replay-baseline.sh applies
 * with awk; files.test.mts checks the two agree), and diffing two trees.
 *
 * Listing format (one line per entry, tab separated):
 *
 *     find /home/agent -mindepth 1 -printf '%y\t%T@\t%s\t%P\n'
 *
 * i.e. type, mtime (epoch seconds, fractional), size in bytes, path relative
 * to the home directory. Shorter forms are accepted for diffs: `%s\t%P`
 * (size, path) and `%T@\t%s\t%P`; their entries are taken to be files.
 */

export type ListingEntry = { type: string; mtime: number | null; size: number; path: string };
export type Listing = Map<string, ListingEntry>;

export function parseListing(text: string): Listing {
    const out: Listing = new Map();
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line.trim()) continue;
        const fields = line.split("\t");
        let entry: ListingEntry | null = null;
        if (fields.length >= 4 && /^[a-zA-Z]$/.test(fields[0]!)) {
            entry = {
                type: fields[0]!,
                mtime: Number(fields[1]),
                size: Number(fields[2]),
                // A tab inside a file name survives: the path is everything after the third tab.
                path: fields.slice(3).join("\t"),
            };
        } else if (fields.length >= 3 && /^\d+(\.\d+)?$/.test(fields[0]!) && /^\d+$/.test(fields[1]!)) {
            entry = { type: "f", mtime: Number(fields[0]), size: Number(fields[1]), path: fields.slice(2).join("\t") };
        } else if (fields.length >= 2 && /^\d+$/.test(fields[0]!)) {
            entry = { type: "f", mtime: null, size: Number(fields[0]), path: fields.slice(1).join("\t") };
        }
        if (!entry || !entry.path || !Number.isFinite(entry.size)) continue;
        entry.path = entry.path.replace(/^\.\//, "").replace(/^\/home\/agent\//, "");
        out.set(entry.path, entry);
    }
    return out;
}

export type ExcludeOptions = {
    /** Chats being replayed: their kernel snapshots (~/.mike/kernels/<id>*) are left out. */
    excludeChats?: readonly string[];
    allKernels?: boolean;
};

const CACHE_SEGMENTS = new Set([".cache", ".npm", "node_modules"]);

/** Why `path` is left out of the baseline, or null to keep it. */
export function excludedReason(path: string, opts: ExcludeOptions = {}): string | null {
    const segments = path.split("/");
    if (segments.some((s) => CACHE_SEGMENTS.has(s))) return "cache";
    if (path.startsWith(".mike/kernels/")) {
        if (opts.allKernels) return "kernel";
        const name = path.slice(".mike/kernels/".length);
        if ((opts.excludeChats ?? []).some((chat) => chat && name.startsWith(chat))) return "kernel";
    }
    return null;
}

export type BaselineChoice = {
    path: string;
    source: "current" | "snapshot";
    type: string;
    size: number;
    mtime: number | null;
};

export type BaselinePlan = {
    include: BaselineChoice[];
    /** Changed or created at/after T0 with no snapshot copy: absent in the baseline. */
    absent: string[];
    excluded: { path: string; reason: string }[];
};

/**
 * The home directory as it stood at T0, per path: the current file if it has
 * not been modified since T0, else the copy in the newest snapshot taken
 * before T0, else nothing. Regular files and symlinks only; directories are
 * recreated from the paths. Known blind spot: a file created after the
 * snapshot and deleted after T0 cannot be recovered.
 */
export function planBaseline(
    current: Listing,
    snapshot: Listing | null,
    t0Seconds: number,
    opts: ExcludeOptions = {},
): BaselinePlan {
    const plan: BaselinePlan = { include: [], absent: [], excluded: [] };
    const paths = new Set<string>();
    for (const [path, e] of current) if (e.type === "f" || e.type === "l") paths.add(path);
    for (const [path, e] of snapshot ?? []) if (e.type === "f" || e.type === "l") paths.add(path);
    for (const path of [...paths].sort()) {
        const reason = excludedReason(path, opts);
        if (reason) {
            plan.excluded.push({ path, reason });
            continue;
        }
        const cur = current.get(path);
        const snap = snapshot?.get(path);
        if (cur && (cur.type === "f" || cur.type === "l") && cur.mtime !== null && cur.mtime < t0Seconds) {
            plan.include.push({ path, source: "current", type: cur.type, size: cur.size, mtime: cur.mtime });
        } else if (snap && (snap.type === "f" || snap.type === "l")) {
            plan.include.push({ path, source: "snapshot", type: snap.type, size: snap.size, mtime: snap.mtime });
        } else {
            plan.absent.push(path);
        }
    }
    return plan;
}

/** `<source>\t<path>` lines, the format replay-baseline.sh --select prints. */
export function planLines(plan: BaselinePlan): string[] {
    return plan.include.map((c) => `${c.source}\t${c.path}`);
}

export type TreeDiff = {
    onlyOriginal: { path: string; size: number }[];
    onlyReplay: { path: string; size: number }[];
    sizeChanged: { path: string; original: number; replay: number }[];
    same: number;
    totals: { originalFiles: number; replayFiles: number; originalBytes: number; replayBytes: number };
};

/** Files (and symlinks) present in one tree only, or in both with different sizes. */
export function diffTrees(original: Listing, replay: Listing, opts: ExcludeOptions = {}): TreeDiff {
    const files = (l: Listing) =>
        new Map([...l].filter(([p, e]) => (e.type === "f" || e.type === "l") && !excludedReason(p, opts)));
    const a = files(original);
    const b = files(replay);
    const diff: TreeDiff = {
        onlyOriginal: [],
        onlyReplay: [],
        sizeChanged: [],
        same: 0,
        totals: {
            originalFiles: a.size,
            replayFiles: b.size,
            originalBytes: [...a.values()].reduce((s, e) => s + e.size, 0),
            replayBytes: [...b.values()].reduce((s, e) => s + e.size, 0),
        },
    };
    for (const [path, e] of [...a].sort(([x], [y]) => x.localeCompare(y))) {
        const other = b.get(path);
        if (!other) diff.onlyOriginal.push({ path, size: e.size });
        else if (other.size !== e.size) diff.sizeChanged.push({ path, original: e.size, replay: other.size });
        else diff.same += 1;
    }
    for (const [path, e] of [...b].sort(([x], [y]) => x.localeCompare(y))) {
        if (!a.has(path)) diff.onlyReplay.push({ path, size: e.size });
    }
    return diff;
}
