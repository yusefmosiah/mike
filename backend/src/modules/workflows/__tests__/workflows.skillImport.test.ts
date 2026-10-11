import { describe, expect, it } from "vitest";

import { packSkillFiles } from "../../../lib/skillFormat";
import { importSkillFromGithub, importSkillFromZip, parseGithubUrl } from "../workflows.skillImport";

const SHA = "a".repeat(40);

/** A fake GitHub: refs that exist, and a repository tree with file contents. */
function fakeGithub(opts: {
  refs?: Record<string, string>;
  defaultBranch?: string;
  files: Record<string, string>;
  modes?: Record<string, string>;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let match = url.match(/^https:\/\/api\.github\.com\/repos\/acme\/skills\/commits\/(.+)$/);
    if (match) {
      const sha = (opts.refs ?? { main: SHA })[decodeURIComponent(match[1]!)];
      return sha ? json({ sha }) : json({ message: "No commit found" }, 422);
    }
    if (url === "https://api.github.com/repos/acme/skills") return json({ default_branch: opts.defaultBranch ?? "main" });
    match = url.match(/^https:\/\/api\.github\.com\/repos\/acme\/skills\/git\/trees\/([0-9a-f]{40})\?recursive=1$/);
    if (match) {
      return json({
        tree: Object.entries(opts.files).map(([path, content]) => ({
          path,
          mode: opts.modes?.[path] ?? "100644",
          type: "blob",
          size: Buffer.byteLength(content),
        })),
      });
    }
    match = url.match(/^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/([0-9a-f]{40})\/(.+)$/);
    if (match) {
      const path = match[2]!.split("/").map(decodeURIComponent).join("/");
      const content = opts.files[path];
      return content === undefined ? new Response("", { status: 404 }) : new Response(content);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PDF_SKILL = "---\nname: pdf\ndescription: Fill and read PDF forms.\n---\nRun scripts/fill.py.";

describe("parseGithubUrl", () => {
  it("reads github.com and raw links", () => {
    expect(parseGithubUrl("https://github.com/acme/skills/tree/main/skills/pdf")).toEqual({
      owner: "acme",
      repo: "skills",
      rest: ["main", "skills", "pdf"],
      kind: "tree",
    });
    expect(parseGithubUrl("github.com/acme/skills")).toMatchObject({ kind: "root", rest: [] });
    expect(parseGithubUrl("https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md")).toMatchObject({
      kind: "blob",
      rest: ["main", "pdf", "SKILL.md"],
    });
    expect(parseGithubUrl("https://gitlab.com/acme/skills")).toBeNull();
    expect(parseGithubUrl("https://github.com/acme/skills/issues/3")).toBeNull();
    expect(parseGithubUrl("not a url at all ::")).toBeNull();
  });
});

describe("importSkillFromGithub", () => {
  it("imports a folder at the commit its branch names, without a license or mike fields", async () => {
    const github = fakeGithub({
      files: {
        "README.md": "repo readme",
        "skills/pdf/SKILL.md": PDF_SKILL,
        "skills/pdf/scripts/fill.py": "print('fill')",
        "skills/other/SKILL.md": "---\nname: other\n---\nOther.",
      },
    });
    const { skill, sourceUrl } = await importSkillFromGithub("https://github.com/acme/skills/tree/main/skills/pdf", {
      fetchImpl: github.fetchImpl,
    });
    expect(skill).toMatchObject({ name: "pdf", description: "Fill and read PDF forms.", body: "Run scripts/fill.py." });
    expect(skill.files.map((f) => f.path)).toEqual(["scripts/fill.py"]);
    expect(sourceUrl).toBe(`https://github.com/acme/skills/tree/${SHA}/skills/pdf`);
    expect(github.calls.some((url) => url.includes("other"))).toBe(false);
  });

  it("follows a branch with slashes, a link to SKILL.md itself, and a repository root", async () => {
    const files = { "pdf/SKILL.md": PDF_SKILL, "SKILL.md": "---\nname: root-skill\ndescription: At the top.\n---\nTop." };
    const slashed = fakeGithub({ refs: { "feature/x": SHA }, files });
    expect(
      (await importSkillFromGithub("https://github.com/acme/skills/blob/feature/x/pdf/SKILL.md", { fetchImpl: slashed.fetchImpl }))
        .skill.name,
    ).toBe("pdf");
    const root = fakeGithub({ defaultBranch: "trunk", refs: { trunk: SHA }, files });
    expect((await importSkillFromGithub("github.com/acme/skills", { fetchImpl: root.fetchImpl })).skill.name).toBe("root-skill");
  });

  it("points to the skills inside a folder that is not one, and refuses symlinks", async () => {
    const github = fakeGithub({
      files: { "skills/a/SKILL.md": "---\nname: a\n---\nA.", "skills/b/SKILL.md": "---\nname: b\n---\nB." },
    });
    await expect(
      importSkillFromGithub("https://github.com/acme/skills/tree/main/skills", { fetchImpl: github.fetchImpl }),
    ).rejects.toThrow("Skills inside it: skills/a, skills/b");

    const linked = fakeGithub({
      files: { "pdf/SKILL.md": PDF_SKILL, "pdf/secret": "/etc/passwd" },
      modes: { "pdf/secret": "120000" },
    });
    await expect(
      importSkillFromGithub("https://github.com/acme/skills/tree/main/pdf", { fetchImpl: linked.fetchImpl }),
    ).rejects.toThrow(/symbolic link/);
  });

  it("says so when the link or the branch is wrong", async () => {
    const github = fakeGithub({ files: { "SKILL.md": PDF_SKILL } });
    await expect(importSkillFromGithub("https://example.com/x", { fetchImpl: github.fetchImpl })).rejects.toThrow(
      /GitHub link/,
    );
    await expect(
      importSkillFromGithub("https://github.com/acme/skills/tree/nope/pdf", { fetchImpl: github.fetchImpl }),
    ).rejects.toThrow(/could not be found/);
  });
});

describe("importSkillFromZip", () => {
  it("names a skill after its zip when SKILL.md does not", async () => {
    const packed = await packSkillFiles([
      { path: "SKILL.md", bytes: Buffer.from("Summarize a lease. Then flag risks.") },
    ]);
    const { skill, sourceUrl } = await importSkillFromZip(packed!.zip, "Lease Summary.zip");
    expect(skill).toMatchObject({ name: "lease-summary", description: "Summarize a lease." });
    expect(sourceUrl).toBeNull();
  });
});
