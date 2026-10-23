import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getMemoryVersion,
    listMemoryVersions,
    restoreMemoryVersion,
} from "./mikeApi";

const fetchMock = vi.fn();
const VERSION = { id: "v 1", revision: 3, created_at: "2026-10-22T00:00:00Z" };

const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
});

const calls = () => fetchMock.mock.calls as [string, RequestInit | undefined][];

describe("memory version API", () => {
    it("lists and reads the versions of the caller's own memory", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ versions: [VERSION] }))
            .mockResolvedValueOnce(json({ ...VERSION, content: "Prefers short answers." }));

        await expect(listMemoryVersions({ scope: "user" })).resolves.toEqual([VERSION]);
        await expect(getMemoryVersion({ scope: "user" }, "v 1")).resolves.toMatchObject({
            content: "Prefers short answers.",
        });
        expect(String(calls()[0][0])).toMatch(/\/user\/memory\/versions$/);
        expect(String(calls()[1][0])).toMatch(/\/user\/memory\/versions\/v%201$/);
    });

    it("restores a project's earlier version against the revision it was read at", async () => {
        fetchMock.mockResolvedValueOnce(json({ content: "Old", revision: 4 }));

        await restoreMemoryVersion({ scope: "project", projectId: "p/1" }, "v 1", 3);
        const [url, init] = calls()[0];
        expect(String(url)).toMatch(/\/projects\/p%2F1\/memory\/versions\/v%201\/restore$/);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ expected_revision: 3 });
    });
});
