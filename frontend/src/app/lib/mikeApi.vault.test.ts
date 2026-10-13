import { beforeEach, describe, expect, it, vi } from "vitest";

const seal = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/vault/seal", () => ({ sealSecret: seal }));

import {
    allowVaultWorkstation,
    deleteVaultSecret,
    getVaultWorkstation,
    getVaultStatus,
    listVaultActivity,
    listVaultSecrets,
    storeVaultSecret,
    updateVaultSecret,
} from "./mikeApi";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const calls = () =>
    (fetchMock.mock.calls as [string, RequestInit | undefined][]).map(([url, init]) => ({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));

const SECRET = { id: "sec_1", name: "deploy", hosts: ["example.com"] };

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
});

describe("vault API", () => {
    it("reads status, secrets and activity", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ enabled: true }))
            .mockResolvedValueOnce(json({ secrets: [SECRET] }))
            .mockResolvedValueOnce(json({ events: [{ event: "created" }] }))
            .mockResolvedValueOnce(json({ events: [] }));
        await expect(getVaultStatus()).resolves.toEqual({ enabled: true });
        await expect(listVaultSecrets()).resolves.toEqual([SECRET]);
        await expect(listVaultActivity(5)).resolves.toEqual([{ event: "created" }]);
        await expect(listVaultActivity()).resolves.toEqual([]);
        expect(calls().map((c) => c.url)).toEqual([
            expect.stringMatching(/\/vault\/status$/),
            expect.stringMatching(/\/vault\/secrets$/),
            expect.stringMatching(/\/vault\/activity\?limit=5$/),
            expect.stringMatching(/\/vault\/activity\?limit=50$/),
        ]);
    });

    it("seals the value before storing it and never sends it", async () => {
        const sealed = { kid: "k", epk: "e", iv: "i", ct: "c" };
        seal.mockResolvedValueOnce(sealed);
        fetchMock
            .mockResolvedValueOnce(json({ kid: "k", public_key: "pub", epoch: "e1" }))
            .mockResolvedValueOnce(json({ secret: SECRET }, 201));
        const input = {
            name: "deploy",
            hosts: ["example.com"],
            injection: { type: "bearer" as const },
            writes: "ask" as const,
        };
        vi.stubEnv("NEXT_PUBLIC_VAULT_SEAL_KEY_SHA256", "ab".repeat(32));
        await expect(storeVaultSecret(input, "the-plain-value", "user-1")).resolves.toEqual(SECRET);
        expect(seal).toHaveBeenCalledWith(
            { kid: "k", public_key: "pub", epoch: "e1" },
            { ...input, value: "the-plain-value", user: "user-1" },
            { pinnedKeySha256: "ab".repeat(32), requirePin: false },
        );
        vi.unstubAllEnvs();
        const [, store] = calls();
        expect(store).toMatchObject({ method: "POST", body: { ...input, sealed } });
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("the-plain-value");
    });

    it("reads and lifts a pause on the user's workstation", async () => {
        const paused = { paused_since: "2026-10-13T00:00:00Z", guest_working: false };
        fetchMock
            .mockResolvedValueOnce(json({ workstation: paused }))
            .mockResolvedValueOnce(json({ workstation: { paused_since: null, guest_working: false } }));
        await expect(getVaultWorkstation()).resolves.toEqual(paused);
        await expect(allowVaultWorkstation()).resolves.toEqual({ paused_since: null, guest_working: false });
        const [read, allow] = calls();
        expect(read.url).toMatch(/\/vault\/workstation$/);
        expect(allow).toMatchObject({ method: "POST" });
        expect(allow.url).toMatch(/\/vault\/workstation\/allow$/);
    });

    it("updates and deletes by an encoded id", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ secret: { ...SECRET, writes: "allow" } }))
            .mockResolvedValueOnce(json({ deleted: true }));
        await expect(updateVaultSecret("sec/1", { writes: "allow" })).resolves.toMatchObject({
            writes: "allow",
        });
        await deleteVaultSecret("sec/1");
        const [update, remove] = calls();
        expect(update).toMatchObject({ method: "PATCH", body: { writes: "allow" } });
        expect(update.url).toMatch(/\/vault\/secrets\/sec%2F1$/);
        expect(remove).toMatchObject({ method: "DELETE" });
        expect(remove.url).toMatch(/\/vault\/secrets\/sec%2F1$/);
    });
});
