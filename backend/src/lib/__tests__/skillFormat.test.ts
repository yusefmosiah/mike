import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  describeFromBody,
  packSkillFiles,
  parseSkillMd,
  renderSkillMd,
  SkillFormatError,
  skillFromFiles,
  skillFromParts,
  skillName,
  unpackSkillZip,
} from "../skillFormat";

const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text, "utf8") });

describe("skillName", () => {
  it("spells names the standard's way", () => {
    expect(skillName("Contract Review")).toBe("contract-review");
    expect(skillName("  NDA: first pass!! ")).toBe("nda-first-pass");
    expect(skillName("Résumé Builder")).toBe("resume-builder");
    expect(skillName("---")).toBe("");
    expect(skillName("a".repeat(80)).length).toBe(64);
  });
});

describe("SKILL.md", () => {
  it("reads frontmatter and body, and tolerates none", () => {
    expect(parseSkillMd("---\nname: pdf\ndescription: Work with PDFs.\nlicense: MIT\n---\n\n# PDF\nSteps.")).toEqual({
      frontmatter: { name: "pdf", description: "Work with PDFs.", license: "MIT" },
      body: "# PDF\nSteps.",
    });
    expect(parseSkillMd("\uFEFF---\r\nname: x\r\n---\r\nBody")).toEqual({ frontmatter: { name: "x" }, body: "Body" });
    expect(parseSkillMd("Just steps.")).toEqual({ frontmatter: null, body: "Just steps." });
    expect(() => parseSkillMd("---\nname: [unclosed\n---\nx")).toThrow(SkillFormatError);
    expect(() => parseSkillMd("---\n- a list\n---\nx")).toThrow(SkillFormatError);
  });

  it("renders name and description first and keeps other fields", () => {
    const text = renderSkillMd({
      name: "nda-review",
      description: "Review an NDA: term, scope, carve-outs.",
      body: "## Steps\n1. Read it.",
      extra: { license: "MIT", metadata: { author: "me" } },
    });
    expect(text.startsWith("---\nname: nda-review\ndescription:")).toBe(true);
    expect(parseSkillMd(text)).toEqual({
      frontmatter: {
        name: "nda-review",
        description: "Review an NDA: term, scope, carve-outs.",
        license: "MIT",
        metadata: { author: "me" },
      },
      body: "## Steps\n1. Read it.",
    });
  });

  it("takes a description from the body when there is none", () => {
    expect(describeFromBody("# Title\n\nSummarize a deposition. Then list issues.")).toBe(
      "Title Summarize a deposition.",
    );
    expect(describeFromBody("no punctuation here")).toBe("no punctuation here");
  });
});

describe("skillFromFiles", () => {
  it("builds a skill from a folder, dropping a shared top folder", () => {
    const skill = skillFromFiles(
      [
        file("pdf/SKILL.md", "---\nname: pdf\ndescription: Work with PDFs.\nlicense: Apache-2.0\n---\nUse scripts/fill.py."),
        file("pdf/scripts/fill.py", "print('fill')"),
        file("pdf/references/forms.md", "# Forms"),
      ],
      "fallback",
    );
    expect(skill).toMatchObject({
      name: "pdf",
      description: "Work with PDFs.",
      body: "Use scripts/fill.py.",
      extra: { license: "Apache-2.0" },
    });
    expect(skill.files.map((f) => f.path)).toEqual(["scripts/fill.py", "references/forms.md"]);
  });

  it("uses the fallback name and the body's first sentence when the frontmatter has neither", () => {
    expect(skillFromFiles([file("SKILL.md", "Draft a demand letter. Ask for the amount.")], "Demand Letter")).toMatchObject({
      name: "demand-letter",
      description: "Draft a demand letter.",
    });
  });

  it("refuses unsafe paths, duplicates, a missing SKILL.md and an empty body", () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "a\\b", "C:/x", "a//b"]) {
      expect(() => skillFromFiles([file("SKILL.md", "x"), file(bad, "x")], "s"), bad).toThrow(SkillFormatError);
    }
    expect(() => skillFromFiles([file("README.md", "x")], "s")).toThrow(/SKILL.md/);
    expect(() => skillFromFiles([file("SKILL.md", "---\nname: s\n---\n")], "s")).toThrow(/instructions/);
    expect(() => skillFromParts({ name: "!!!", body: "x" })).toThrow(/name/);
    expect(() => skillFromFiles([file("SKILL.md", "x"), file("./SKILL.md", "y")], "s")).toThrow(/twice/);
    expect(() => skillFromFiles([{ path: "SKILL.md", bytes: Buffer.from([0xff, 0xfe]) }], "s")).toThrow(/UTF-8/);
  });
});

describe("zip bundles", () => {
  it("packs and unpacks the same files", async () => {
    const packed = await packSkillFiles([file("scripts/b.py", "b"), file("a.md", "aa")]);
    expect(packed!.entries).toEqual([
      { path: "a.md", size: 2 },
      { path: "scripts/b.py", size: 1 },
    ]);
    const files = await unpackSkillZip(packed!.zip);
    expect(files.map((f) => [f.path, f.bytes.toString()])).toEqual([
      ["a.md", "aa"],
      ["scripts/b.py", "b"],
    ]);
    expect(await packSkillFiles([])).toBeNull();
  });

  it("refuses symlinks, unsafe paths, junk and inflated sizes past the limit", async () => {
    const link = new JSZip();
    link.file("SKILL.md", "x");
    link.file("evil", "/etc/passwd", { unixPermissions: 0o120777, platform: "UNIX" } as never);
    await expect(
      unpackSkillZip(await link.generateAsync({ type: "nodebuffer", platform: "UNIX" })),
    ).rejects.toThrow(/symbolic link/);

    const traversal = new JSZip();
    traversal.file("../escape.txt", "x");
    await expect(unpackSkillZip(await traversal.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/unsafe path/);

    const bomb = new JSZip();
    bomb.file("big.txt", Buffer.alloc(6 * 1024 * 1024));
    await expect(
      unpackSkillZip(await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })),
    ).rejects.toThrow(/at most/);

    await expect(unpackSkillZip(Buffer.from("not a zip"))).rejects.toThrow(/not a zip/);

    const mac = new JSZip();
    mac.file("SKILL.md", "x");
    mac.file("__MACOSX/._SKILL.md", "junk");
    mac.file("dir/.DS_Store", "junk");
    expect((await unpackSkillZip(await mac.generateAsync({ type: "nodebuffer" }))).map((f) => f.path)).toEqual([
      "SKILL.md",
    ]);
  });
});
