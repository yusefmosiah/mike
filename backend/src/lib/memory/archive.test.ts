import { describe, expect, it, vi } from "vitest";

const { checkProjectAccess, getMemoryCurrent, listAccessibleProjectIds } =
  vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    getMemoryCurrent: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
  }));

vi.mock("../access", () => ({
  checkProjectAccess,
  listAccessibleProjectIds,
}));

vi.mock("./files", () => ({ getMemoryCurrent }));

import JSZip from "jszip";
import { buildMemoryArchive } from "./archive";

describe("buildMemoryArchive", () => {
  it("includes app and currently accessible project Markdown without unsafe paths", async () => {
    listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
    checkProjectAccess.mockImplementation(async (projectId: string) => ({
      ok: projectId === "p1",
    }));
    getMemoryCurrent.mockImplementation(
      async (_db: unknown, scope: string, ownerId: string) => ({
        current: {
          content:
            scope === "user" ? "# App memory" : `# Project ${ownerId}`,
        },
        file: { id: `file-${ownerId}` },
      }),
    );
    const versions = (fileId: string) =>
      fileId === "file-u1"
        ? [
            { version_number: 1, source: "manual", content: "# First" },
            { version_number: 2, source: "curator", content: "# App memory" },
          ]
        : [];
    const db = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() =>
          table === "memory_file_versions"
            ? {
                eq: vi.fn((_column: string, fileId: string) => ({
                  order: vi.fn(async () => ({ data: versions(fileId), error: null })),
                })),
              }
            : {
                in: vi.fn(async () => ({
                  data: [
                    { id: "p2", name: "Revoked" },
                    { id: "p1", name: "../Matter/Alpha" },
                  ],
                  error: null,
                })),
              },
        ),
      })),
    };

    const buffer = await buildMemoryArchive(
      db as never,
      "u1",
      "u1@example.test",
    );
    const zip = await JSZip.loadAsync(buffer);
    const fileNames = Object.keys(zip.files).filter(
      (name) => !zip.files[name].dir,
    );
    const projectFile = fileNames.find((name) => name.includes("--p1/") && name.endsWith("/memory.md"));

    expect(await zip.file("app/memory.md")?.async("string")).toBe(
      "# App memory",
    );
    expect(await zip.file("app/versions/0001-manual.md")?.async("string")).toBe("# First");
    expect(await zip.file("app/versions/0002-curator.md")?.async("string")).toBe("# App memory");
    expect(projectFile).toBeTruthy();
    expect(projectFile).not.toContain("..");
    expect(projectFile).not.toContain("\\");
    expect(await zip.file(projectFile!)?.async("string")).toBe("# Project p1");
    expect(fileNames.some((name) => name.includes("--p2/"))).toBe(false);
    expect(getMemoryCurrent).not.toHaveBeenCalledWith(
      db,
      "project",
      "p2",
      true,
    );
  });
});
