// Docs audit — every shipped surface names the page that documents it.
//
// The docs are only useful if they keep up with the code. This test walks the
// three places a capability becomes reachable and fails when one has neither a
// page nor a reviewed exemption:
//
//   * an HTTP router mount in `app.ts` (`app.use("/x", router)`);
//   * a module directory under `src/modules/`;
//   * a built-in tool in the code-mode index (`toolStubs.ts`).
//
// `docs/capabilities-map.json` maps a key to the Markdown page that documents
// it, so one page may cover several keys (a route and its module, say).
// `docs/capabilities-allowlist.json` exempts internal plumbing with a reason.
// Both files are checked the other way too: an entry that names something the
// code no longer exposes is stale and fails, which is how a page for removed
// behaviour gets deleted instead of lingering.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_STUBS } from "../lib/codemode/toolStubs";

const SRC = resolve(__dirname, "..");
const REPO = resolve(__dirname, "../../..");

const ROUTE_KEYS = [
  // Any mount that names a path counts as a route: app.use("path", router),
  // app.use("path", middleware, router), app.use("path", handler). A tighter
  // regex that demands a single identifier silently lets a route escape the
  // audit the day a middleware gets inserted before the router.
  ...readFileSync(join(SRC, "app.ts"), "utf8").matchAll(
    /^\s*app\.use\(\s*["'](\/[^"']*)["']/gm,
  ),
].map((match) => `route:${match[1]}`);

const MODULES = join(SRC, "modules");
const MODULE_KEYS = readdirSync(MODULES)
  .filter((entry) => statSync(join(MODULES, entry)).isDirectory())
  .map((entry) => `module:${entry}`);

const TOOL_KEYS = Object.keys(TOOL_STUBS).map((name) => `tool:${name}`);

const CAPABILITY_KEYS = [
  ...new Set([...ROUTE_KEYS, ...MODULE_KEYS, ...TOOL_KEYS]),
].sort();

const map = JSON.parse(
  readFileSync(join(REPO, "docs/capabilities-map.json"), "utf8"),
) as Record<string, string>;

type AllowlistEntry = { key: string; reason: string };

const allowlist = JSON.parse(
  readFileSync(join(REPO, "docs/capabilities-allowlist.json"), "utf8"),
) as AllowlistEntry[];

describe("docs audit", () => {
  it("every route, module and tool has a page or an allowlist entry", () => {
    const covered = new Set([...Object.keys(map), ...allowlist.map((e) => e.key)]);
    const missing = CAPABILITY_KEYS.filter((key) => !covered.has(key));
    expect(
      missing,
      "add each key to docs/capabilities-map.json (key -> page) or docs/capabilities-allowlist.json (key + reason)",
    ).toEqual([]);
  });

  it("the map and allowlist only name capabilities that still exist", () => {
    const live = new Set(CAPABILITY_KEYS);
    const stale = [
      ...Object.keys(map).filter((key) => !live.has(key)),
      ...allowlist.map((e) => e.key).filter((key) => !live.has(key)),
    ];
    expect(
      stale,
      "remove the entry (and the page, if the behaviour is gone) so removed capabilities cannot keep a page alive",
    ).toEqual([]);
  });

  it("every mapped page exists and the allowlist entries are reviewed", () => {
    const missingPages = Object.entries(map)
      .filter(([, page]) => !existsSync(join(REPO, page)))
      .map(([key, page]) => `${key} -> ${page}`);
    expect(missingPages).toEqual([]);

    const duplicateKeys = allowlist
      .map((entry) => entry.key)
      .filter((key, index, keys) => keys.indexOf(key) !== index);
    expect(duplicateKeys, "each allowlisted key appears once").toEqual([]);

    const both = allowlist
      .map((entry) => entry.key)
      .filter((key) => Object.hasOwn(map, key));
    expect(both, "a key is documented or allowlisted, not both").toEqual([]);

    const unreviewed = allowlist
      .filter((entry) => !entry.reason?.trim())
      .map((entry) => entry.key);
    expect(unreviewed, "an allowlist entry needs a reason").toEqual([]);
  });
});
