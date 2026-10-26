import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createComputer,
    listComputers,
    MikeApiError,
    revokeComputer,
} from "./mikeApi";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
const calls = () =>
    (fetchMock.mock.calls as [string, RequestInit | undefined][]).map(
        ([url, init]) => ({
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        }),
    );

const DEVICE = {
    id: "dev/1",
    name: "My Mac",
    created_at: "2026-01-01T00:00:00Z",
    last_seen_at: null,
    online: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
});

describe("computers API", () => {
    it("lists devices", async () => {
        fetchMock.mockResolvedValueOnce(json({ devices: [DEVICE] }));
        await expect(listComputers()).resolves.toEqual([DEVICE]);
        expect(calls()[0].url).toMatch(/\/computers$/);
    });

    it("creates a device and returns its one-time token", async () => {
        fetchMock.mockResolvedValueOnce(
            json({ device: DEVICE, token: "tok" }, 201),
        );
        await expect(createComputer("My Mac")).resolves.toEqual({
            device: DEVICE,
            token: "tok",
        });
        expect(calls()[0]).toMatchObject({
            method: "POST",
            body: { name: "My Mac" },
        });
    });

    it("revokes a device by encoded id", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(revokeComputer("dev/1")).resolves.toBeUndefined();
        expect(calls()[0].url).toMatch(/\/computers\/dev%2F1$/);
        expect(calls()[0].method).toBe("DELETE");
    });

    it("surfaces API errors", async () => {
        fetchMock.mockResolvedValueOnce(json({ detail: "nope" }, 400));
        await expect(listComputers()).rejects.toBeInstanceOf(MikeApiError);
    });
});
