import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublication, getPublishingConfig, listPublications, openPublication, revokePublication, updatePublication } from "./mikeApi";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const calls = () => fetchMock.mock.calls as [string, RequestInit | undefined][];

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
});

describe("publications API", () => {
    it("reads the config and a document's links", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ enabled: true, audiences: ["public"] }))
            .mockResolvedValueOnce(json({ publications: [{ id: "p1" }] }));
        await expect(getPublishingConfig()).resolves.toEqual({ enabled: true, audiences: ["public"] });
        await expect(listPublications("d 1")).resolves.toEqual([{ id: "p1" }]);
        expect(String(calls()[0]![0])).toMatch(/\/publications\/config$/);
        expect(String(calls()[1]![0])).toMatch(/\/publications\?document_id=d%201$/);
    });

    it("creates a link with the chosen audience, password and expiry", async () => {
        fetchMock.mockResolvedValueOnce(json({ publication: { id: "p1" }, missing_files: ["a.css"] }, 201));
        const input = { document_id: "d1", audience: "password" as const, password: "a-b-c-d-e-f-g-h", expires_in_days: null };
        await expect(createPublication(input)).resolves.toEqual({ publication: { id: "p1" }, missing_files: ["a.css"] });
        const [url, init] = calls()[0]!;
        expect(String(url)).toMatch(/\/publications$/);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual(input);
    });

    it("revokes a link", async () => {
        fetchMock.mockResolvedValueOnce(json({ publication: { id: "p1", revoked_at: "x" } }));
        await expect(revokePublication("p 1")).resolves.toEqual({ id: "p1", revoked_at: "x" });
        const [url, init] = calls()[0]!;
        expect(String(url)).toMatch(/\/publications\/p%201\/revoke$/);
        expect(init?.method).toBe("POST");
    });

    it("edits a link's expiry, audience and follow with a PATCH", async () => {
        fetchMock.mockResolvedValueOnce(json({ publication: { id: "p1", follow_document: false } }));
        await expect(
            updatePublication("p 1", { follow_document: false, expires_in_days: null }),
        ).resolves.toEqual({ id: "p1", follow_document: false });
        const [url, init] = calls()[0]!;
        expect(String(url)).toMatch(/\/publications\/p%201$/);
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ follow_document: false, expires_in_days: null });
    });

    it("asks where a signed-in visitor reads a signed-in-only link, with or without a path", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ url: "https://c.example/a/b" }))
            .mockResolvedValueOnce(json({ url: "https://c.example/a" }));
        await expect(openPublication("p 1", "/img/a.png")).resolves.toEqual({ url: "https://c.example/a/b" });
        await expect(openPublication("p1")).resolves.toEqual({ url: "https://c.example/a" });
        const [url, init] = calls()[0]!;
        expect(String(url)).toMatch(/\/publications\/p%201\/open$/);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ path: "/img/a.png" });
        expect(JSON.parse(String(calls()[1]![1]?.body))).toEqual({});
    });
});
