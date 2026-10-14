import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffTrees, excludedReason, parseListing, planBaseline, planLines } from "./files.mts";

const T0 = 1_791_748_357; // 2026-10-11T19:52:37Z
const line = (type: string, mtime: number, size: number, p: string) => `${type}\t${mtime}.5000000000\t${size}\t${p}`;

// The owner VM today and the newest snapshot before T0.
const current = [
    line("d", T0 - 100, 4096, "mike"),
    line("f", T0 - 100, 10, "mike/old.md"), // untouched since before T0: current copy
    line("f", T0 + 500, 20, "mike/edited.md"), // edited after T0: snapshot copy
    line("f", T0 + 600, 30, "mike/new.md"), // created after T0: absent
    line("f", T0 - 5000, 40, "skills/tool/node_modules/x.js"),
    line("f", T0 - 5000, 50, ".cache/pip/wheel"),
    line("f", T0 + 10, 60, ".mike/kernels/chat-1.dill"),
    line("f", T0 - 10, 70, ".mike/kernels/chat-2.dill"),
    line("l", T0 - 10, 7, "mike/link"),
    line("f", T0 - 1, 80, "mike/name\twith tab.md"),
].join("\n");
const snapshot = [
    line("f", T0 - 9000, 15, "mike/edited.md"),
    line("f", T0 - 9000, 25, "mike/deleted-later.md"), // gone now: snapshot copy
    line("f", T0 - 9000, 11, "mike/old.md"),
].join("\n");

describe("listings", () => {
    it("parses find -printf output, tabs in names included, and the short forms", () => {
        const l = parseListing(`${current}\n`);
        expect(l.get("mike/old.md")).toEqual({ type: "f", mtime: T0 - 100 + 0.5, size: 10, path: "mike/old.md" });
        expect(l.has("mike/name\twith tab.md")).toBe(true);
        expect(parseListing("123\t./a/b.txt\n").get("a/b.txt")).toEqual({ type: "f", mtime: null, size: 123, path: "a/b.txt" });
        expect(parseListing("1700000000.1\t9\t/home/agent/c").get("c")).toMatchObject({ size: 9, mtime: 1700000000.1 });
    });

    it("excludes caches and the replayed chats' kernel snapshots", () => {
        expect(excludedReason("a/node_modules/b")).toBe("cache");
        expect(excludedReason(".npm/_cacache/x")).toBe("cache");
        expect(excludedReason(".mike/kernels/chat-1.dill", { excludeChats: ["chat-1"] })).toBe("kernel");
        expect(excludedReason(".mike/kernels/chat-2.dill", { excludeChats: ["chat-1"] })).toBeNull();
        expect(excludedReason(".mike/kernels/chat-2.dill", { allKernels: true })).toBe("kernel");
        expect(excludedReason("mike/cache.md")).toBeNull();
    });
});

describe("baseline selection", () => {
    const plan = planBaseline(parseListing(current), parseListing(snapshot), T0, { excludeChats: ["chat-1"] });

    it("takes current files older than T0, else the snapshot's, else nothing", () => {
        expect(planLines(plan)).toEqual([
            "current\t.mike/kernels/chat-2.dill",
            "snapshot\tmike/deleted-later.md",
            "snapshot\tmike/edited.md",
            "current\tmike/link",
            "current\tmike/name\twith tab.md",
            "current\tmike/old.md",
        ]);
        expect(plan.include.find((c) => c.path === "mike/edited.md")?.size).toBe(15);
        expect(plan.absent).toEqual(["mike/new.md"]);
        expect(plan.excluded.map((e) => e.reason).sort()).toEqual(["cache", "cache", "kernel"]);
    });

    it("works without a snapshot", () => {
        const p = planBaseline(parseListing(current), null, T0);
        expect(p.absent).toEqual([".mike/kernels/chat-1.dill", "mike/edited.md", "mike/new.md"]);
    });

    it("agrees with replay-baseline.sh --select", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "replay-baseline-"));
        writeFileSync(path.join(dir, "current.list"), `${current}\n`);
        writeFileSync(path.join(dir, "snapshot.list"), `${snapshot}\n`);
        const script = path.join(import.meta.dirname, "replay-baseline.sh");
        const out = execFileSync("bash", [script, "--select", path.join(dir, "current.list"), path.join(dir, "snapshot.list"), "--t0-epoch", String(T0), "--exclude-chat", "chat-1"], { encoding: "utf8" });
        const rows = out.trimEnd().split("\n");
        const pick = (tags: string[]) => rows.filter((r) => tags.includes(r.split("\t")[0]!)).sort();
        expect(pick(["current", "snapshot"])).toEqual([...planLines(plan)].sort());
        expect(pick(["absent"])).toEqual(plan.absent.map((p) => `absent\t${p}`));
        expect(pick(["excluded"]).length).toBe(plan.excluded.length);
        const empty = execFileSync("bash", [script, "--select", path.join(dir, "current.list"), "/dev/null", "--t0-epoch", String(T0)], { encoding: "utf8" });
        expect(empty.split("\n").filter((r) => r.startsWith("current\t") || r.startsWith("snapshot\t")).sort()).toEqual(
            planLines(planBaseline(parseListing(current), null, T0)).sort(),
        );
    });
});

describe("tree diff", () => {
    it("lists files only on one side and size changes, ignoring caches and kernels", () => {
        const original = parseListing(["f\t1\t10\ta.md", "f\t1\t20\tb.md", "f\t1\t5\tnode_modules/x", "d\t1\t4096\tdir"].join("\n"));
        const replay = parseListing(["f\t1\t10\ta.md", "f\t1\t25\tb.md", "f\t1\t7\tc.md", "f\t1\t9\t.mike/kernels/k.dill"].join("\n"));
        const d = diffTrees(original, replay, { allKernels: true });
        expect(d.same).toBe(1);
        expect(d.sizeChanged).toEqual([{ path: "b.md", original: 20, replay: 25 }]);
        expect(d.onlyOriginal).toEqual([]);
        expect(d.onlyReplay).toEqual([{ path: "c.md", size: 7 }]);
        expect(d.totals).toEqual({ originalFiles: 2, replayFiles: 3, originalBytes: 30, replayBytes: 42 });
    });
});
