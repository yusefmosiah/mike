import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    SILERO_SHA256,
    SILERO_URL,
    VOICE_CACHE,
    VoiceModelError,
    downloadSilero,
    estimatedBytesPerSecond,
    loadSilero,
    removeVoiceModels,
    requestPersistentStorage,
    sha256Hex,
    sileroCached,
    type ModelDeps,
} from "./models";

const bytesOf = (...values: number[]) => Uint8Array.from(values).buffer as ArrayBuffer;
const goodDigest = async () => SILERO_SHA256;
const badDigest = async () => "deadbeef";

function fakeCache(initial?: ArrayBuffer) {
    const store = new Map<string, Response>();
    if (initial) store.set(SILERO_URL, new Response(initial));
    return {
        store,
        match: vi.fn(async (url: string) => store.get(url)),
        put: vi.fn(async (url: string, response: Response) => void store.set(url, response)),
    };
}

function streamResponse(chunks: Uint8Array[], contentLength: string | null) {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
    const headers = new Headers();
    if (contentLength !== null) headers.set("content-length", contentLength);
    return new Response(body, { headers });
}

// Clear the module's in-memory fallback between tests.
beforeEach(async () => {
    await removeVoiceModels({ deleteCache: async () => true });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("sha256Hex", () => {
    it("hex-encodes the subtle digest", async () => {
        const digest = vi.fn(async () => Uint8Array.of(0, 15, 255).buffer);
        vi.stubGlobal("crypto", { subtle: { digest } });
        expect(await sha256Hex(bytesOf(1))).toBe("000fff");
        expect(digest).toHaveBeenCalledWith("SHA-256", expect.anything());
    });
});

describe("downloadSilero", () => {
    it("streams with progress, verifies, and stores in the cache", async () => {
        const cache = fakeCache();
        const progress = vi.fn();
        const fetchMock = vi.fn(async () => streamResponse([Uint8Array.of(1, 2), Uint8Array.of(3, 4)], "4"));
        const result = await downloadSilero(progress, {
            fetch: fetchMock as never,
            openCache: async () => cache,
            digest: goodDigest,
        });
        expect(fetchMock).toHaveBeenCalledWith(SILERO_URL);
        expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4]);
        expect(progress.mock.calls.map((c) => c[0])).toEqual([0.5, 1, 1]);
        expect(cache.put).toHaveBeenCalledWith(SILERO_URL, expect.any(Response));
    });

    it("reads the whole body when there is no length, and works without a progress callback", async () => {
        const cache = fakeCache();
        const deps: ModelDeps = {
            fetch: (async () => new Response(bytesOf(9, 8))) as never,
            openCache: async () => cache,
            digest: goodDigest,
        };
        const result = await downloadSilero(undefined, deps);
        expect(Array.from(new Uint8Array(result))).toEqual([9, 8]);
        // A stream with a length but no progress callback also works.
        await downloadSilero(undefined, { ...deps, fetch: (async () => streamResponse([Uint8Array.of(1)], "1")) as never });
    });

    it("rejects an HTTP failure", async () => {
        const fetchMock = (async () => new Response("no", { status: 404 })) as never;
        await expect(downloadSilero(undefined, { fetch: fetchMock })).rejects.toThrow("download failed");
    });

    it("rejects a checksum mismatch without caching", async () => {
        const cache = fakeCache();
        await expect(
            downloadSilero(undefined, {
                fetch: (async () => new Response(bytesOf(1))) as never,
                openCache: async () => cache,
                digest: badDigest,
            }),
        ).rejects.toBeInstanceOf(VoiceModelError);
        expect(cache.put).not.toHaveBeenCalled();
    });

    it("tolerates a failing cache write", async () => {
        const cache = fakeCache();
        cache.put.mockRejectedValueOnce(new Error("quota"));
        const result = await downloadSilero(undefined, {
            fetch: (async () => new Response(bytesOf(5))) as never,
            openCache: async () => cache,
            digest: goodDigest,
        });
        expect(result.byteLength).toBe(1);
    });

    it("keeps the model in memory when there is no cache, and uses global fetch and digest by default", async () => {
        const data = bytesOf(7, 7);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(data)));
        vi.stubGlobal("caches", undefined);
        vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(0)) } });
        // Real digest path: empty hash never matches, so stub the dep for the success case.
        await expect(downloadSilero()).rejects.toThrow("checksum mismatch");

        await downloadSilero(undefined, { openCache: async () => null, digest: goodDigest });
        expect(await sileroCached({ openCache: async () => null })).toBe(true);
        const loaded = await loadSilero({ openCache: async () => null });
        expect(Array.from(new Uint8Array(loaded))).toEqual([7, 7]);
        // A copy, so the caller cannot corrupt the stored one.
        expect(loaded).not.toBe(await loadSilero());
    });
});

describe("sileroCached and loadSilero", () => {
    it("reports and loads a cached model", async () => {
        const cache = fakeCache(bytesOf(1, 2));
        expect(await sileroCached({ openCache: async () => cache })).toBe(true);
        const loaded = await loadSilero({ openCache: async () => cache, digest: goodDigest });
        expect(Array.from(new Uint8Array(loaded))).toEqual([1, 2]);
    });

    it("reports not cached when empty, absent, or the cache throws", async () => {
        expect(await sileroCached({ openCache: async () => fakeCache() })).toBe(false);
        expect(await sileroCached({ openCache: async () => null })).toBe(false);
        const broken = { match: async () => Promise.reject(new Error("x")), put: async () => undefined };
        expect(await sileroCached({ openCache: async () => broken })).toBe(false);
        await expect(loadSilero({ openCache: async () => broken })).rejects.toThrow("not downloaded");
        await expect(loadSilero({ openCache: async () => null })).rejects.toThrow("not downloaded");
    });

    it("rechecks the checksum when loading", async () => {
        const cache = fakeCache(bytesOf(1));
        await expect(loadSilero({ openCache: async () => cache, digest: badDigest })).rejects.toThrow("checksum mismatch");
    });

    it("opens Cache Storage by default, and treats a throwing or missing one as absent", async () => {
        const cache = fakeCache(bytesOf(1));
        const open = vi.fn(async () => cache);
        vi.stubGlobal("caches", { open });
        expect(await sileroCached()).toBe(true);
        expect(open).toHaveBeenCalledWith(VOICE_CACHE);

        vi.stubGlobal("caches", { open: async () => Promise.reject(new Error("blocked")) });
        expect(await sileroCached()).toBe(false);

        vi.stubGlobal("caches", undefined);
        expect(await sileroCached()).toBe(false);
    });
});

describe("defaults", () => {
    it("downloads into Cache Storage and loads it back with the global digest", async () => {
        const cache = fakeCache();
        vi.stubGlobal("caches", { open: async () => cache });
        const hash = Uint8Array.from(SILERO_SHA256.match(/../g)!.map((h) => parseInt(h, 16))).buffer;
        vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => hash) } });
        await downloadSilero(undefined, { fetch: (async () => new Response(bytesOf(3))) as never });
        expect(cache.put).toHaveBeenCalled();
        const loaded = await loadSilero();
        expect(Array.from(new Uint8Array(loaded))).toEqual([3]);
    });
});

describe("removeVoiceModels", () => {
    it("deletes the cache, never rejects, and forgets the in-memory copy", async () => {
        await downloadSilero(undefined, {
            fetch: (async () => new Response(bytesOf(1))) as never,
            openCache: async () => null,
            digest: goodDigest,
        });
        const deleteCache = vi.fn(async () => true);
        await removeVoiceModels({ deleteCache });
        expect(deleteCache).toHaveBeenCalled();
        expect(await sileroCached({ openCache: async () => null })).toBe(false);
        await removeVoiceModels({ deleteCache: async () => Promise.reject(new Error("x")) });
    });

    it("uses caches.delete by default, or does nothing without Cache Storage", async () => {
        const del = vi.fn(async () => true);
        vi.stubGlobal("caches", { delete: del });
        await removeVoiceModels();
        expect(del).toHaveBeenCalledWith(VOICE_CACHE);
        vi.stubGlobal("caches", undefined);
        await expect(removeVoiceModels()).resolves.toBeUndefined();
    });
});

describe("requestPersistentStorage", () => {
    it("asks the browser to persist", async () => {
        const persist = vi.fn(async () => true);
        vi.stubGlobal("navigator", { storage: { persist } });
        await requestPersistentStorage();
        expect(persist).toHaveBeenCalled();
    });

    it("never rejects, and copes with missing storage", async () => {
        vi.stubGlobal("navigator", { storage: { persist: async () => Promise.reject(new Error("no")) } });
        await expect(requestPersistentStorage()).resolves.toBeUndefined();
        vi.stubGlobal("navigator", {});
        await expect(requestPersistentStorage()).resolves.toBeUndefined();
        vi.stubGlobal("navigator", { storage: {} });
        await expect(requestPersistentStorage()).resolves.toBeUndefined();
    });
});

describe("estimatedBytesPerSecond", () => {
    it("converts downlink megabits to bytes per second", () => {
        expect(estimatedBytesPerSecond({ connection: { downlink: 4 } })).toBe(500_000);
    });

    it("assumes 10 megabits without a usable downlink", () => {
        expect(estimatedBytesPerSecond({})).toBe(1_250_000);
        expect(estimatedBytesPerSecond({ connection: { downlink: 0 } })).toBe(1_250_000);
        expect(estimatedBytesPerSecond(undefined)).toBe(1_250_000);
    });

    it("reads navigator by default", () => {
        vi.stubGlobal("navigator", { connection: { downlink: 2 } });
        expect(estimatedBytesPerSecond()).toBe(250_000);
        vi.stubGlobal("navigator", undefined);
        expect(estimatedBytesPerSecond()).toBe(1_250_000);
    });
});
