/**
 * A small HTTP client for Mike's API, as the web app talks to it: cookie
 * session from POST /auth/login (or a bearer token), the browser's Origin on
 * writes, SSE for chat turns, upload sessions for documents. Credentials are
 * read from the environment by the caller and never logged.
 */
import { randomUUID } from "node:crypto";
import { request } from "node:http";

/** A presigned PUT sent to `base` with the URL's own Host, which fetch cannot set. */
function putVia(base: string, url: URL, headers: Record<string, string>, data: Uint8Array): Promise<number> {
    const target = new URL(base);
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: target.hostname,
                port: target.port || 80,
                method: "PUT",
                path: `${url.pathname}${url.search}`,
                headers: { ...headers, Host: url.host, "Content-Length": String(data.byteLength) },
            },
            (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
            },
        );
        req.on("error", reject);
        req.end(data);
    });
}

/** How long a rate-limited request keeps waiting for the limiter, in all. */
const RATE_LIMIT_PATIENCE_MS = 60 * 60_000;

/** The wait a 429 asks for (Retry-After or RateLimit-Reset, in seconds), 5 s to 15 min. */
export function retryAfterMs(res: Pick<Response, "headers">): number {
    const seconds = Number(res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset") ?? "60");
    const ms = Number.isFinite(seconds) ? seconds * 1000 + 1000 : 60_000;
    return Math.min(15 * 60_000, Math.max(5_000, ms));
}

export class ApiError extends Error {
    readonly status: number;
    readonly code: string | null;
    constructor(status: number, code: string | null, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

export type ClientOptions = {
    /** The web app's origin, e.g. https://mike.example.com. */
    origin: string;
    /** API base; defaults to `${origin}/api`, the web app's gateway. */
    apiBase?: string;
    /** A token, or a function read before each request (a token file a refresher rewrites). */
    bearerToken?: string | (() => string);
    fetchImpl?: typeof fetch;
    /**
     * Where presigned storage uploads go instead of their URL's origin, keeping
     * the signed Host header (on the deployment host, behind its gate:
     * http://127.0.0.1:9000).
     */
    storageBase?: string;
};

export class MikeClient {
    readonly origin: string;
    readonly apiBase: string;
    private readonly cookies = new Map<string, string>();
    private readonly bearer: string | (() => string) | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly storageBase: string | undefined;

    constructor(opts: ClientOptions) {
        this.origin = new URL(opts.origin).origin;
        this.apiBase = (opts.apiBase ?? `${this.origin}/api`).replace(/\/$/, "");
        this.bearer = opts.bearerToken;
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.storageBase = opts.storageBase;
    }

    private storeCookies(res: Response) {
        const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        for (const header of list) {
            const [pair, ...attrs] = header.split(";");
            const eq = pair!.indexOf("=");
            if (eq <= 0) continue;
            const name = pair!.slice(0, eq).trim();
            const value = pair!.slice(eq + 1).trim();
            const expired = attrs.some((a) => {
                const [k, v] = a.split("=").map((s) => s.trim());
                if (k?.toLowerCase() === "max-age") return Number(v) <= 0;
                if (k?.toLowerCase() === "expires") return Date.parse(v ?? "") < Date.now();
                return false;
            });
            if (expired || value === "") this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }

    private headers(extra?: Record<string, string>): Record<string, string> {
        const h: Record<string, string> = { Origin: this.origin, ...extra };
        const bearer = typeof this.bearer === "function" ? this.bearer() : this.bearer;
        if (bearer) h.Authorization = `Bearer ${bearer}`;
        if (this.cookies.size > 0) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        return h;
    }

    /**
     * A raw request against the API; the caller reads the body. A rate-limited
     * request (429) is sent again once the limiter's window allows, as a person
     * would after waiting, for up to `RATE_LIMIT_PATIENCE_MS` in all.
     */
    async raw(method: string, path: string, init?: { body?: unknown; accept?: string; signal?: AbortSignal }): Promise<Response> {
        const started = Date.now();
        for (;;) {
            const res = await this.rawOnce(method, path, init);
            if (res.status !== 429 || Date.now() - started > RATE_LIMIT_PATIENCE_MS) return res;
            await res.body?.cancel();
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res)));
        }
    }

    private async rawOnce(method: string, path: string, init?: { body?: unknown; accept?: string; signal?: AbortSignal }): Promise<Response> {
        const hasBody = init?.body !== undefined;
        const res = await this.fetchImpl(`${this.apiBase}${path}`, {
            method,
            headers: this.headers({
                Accept: init?.accept ?? "application/json",
                ...(hasBody ? { "Content-Type": "application/json" } : {}),
            }),
            body: hasBody ? JSON.stringify(init!.body) : undefined,
            signal: init?.signal,
            redirect: "manual",
        });
        this.storeCookies(res);
        return res;
    }

    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await this.raw(method, path, { body });
        const text = await res.text();
        if (!res.ok) {
            let code: string | null = null;
            let detail = `HTTP ${res.status}`;
            try {
                const parsed = JSON.parse(text) as { code?: unknown; detail?: unknown };
                if (typeof parsed.code === "string") code = parsed.code;
                if (typeof parsed.detail === "string") detail = `HTTP ${res.status}: ${parsed.detail}`;
            } catch {
                /* not JSON */
            }
            throw new ApiError(res.status, code, `${method} ${path} -> ${detail}`);
        }
        return (text ? JSON.parse(text) : undefined) as T;
    }

    async login(email: string, password: string): Promise<{ id: string; email?: string }> {
        const out = await this.json<{ user: { id: string; email?: string } }>("POST", "/auth/login", { email, password });
        return out.user;
    }

    /** Binary GET (document bytes). */
    async bytes(path: string): Promise<{ data: Uint8Array<ArrayBuffer>; filename: string | null }> {
        const res = await this.raw("GET", path, { accept: "*/*" });
        if (!res.ok) throw new ApiError(res.status, null, `GET ${path} -> HTTP ${res.status}`);
        const disposition = res.headers.get("content-disposition") ?? "";
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
        return {
            data: new Uint8Array(await res.arrayBuffer()),
            filename: match ? decodeURIComponent(match[1]!) : null,
        };
    }

    /**
     * Upload one file as a new standalone document through an upload session,
     * the way the web app's chat attachment picker does, and wait for it to be
     * processed. Returns the created document row.
     */
    async uploadDocument(
        filename: string,
        data: Uint8Array<ArrayBuffer>,
        opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
    ): Promise<Record<string, unknown> & { id: string }> {
        const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        type FileRow = {
            id: string;
            client_id: string;
            status: string;
            error_code: string | null;
            result: unknown;
            upload?: { method: "PUT"; url: string; headers: Record<string, string> };
        };
        type SessionResponse = { session: { id: string; status: string }; files: FileRow[] };
        const clientId = randomUUID();
        const created = await this.json<SessionResponse>("POST", "/upload-sessions", {
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ client_id: clientId, filename, size_bytes: data.byteLength }],
        });
        const file = created.files.find((f) => f.client_id === clientId);
        if (!file?.upload) throw new Error(`upload session gave no upload URL for ${filename}`);
        const url = new URL(file.upload.url, this.origin);
        const status = this.storageBase
            ? await putVia(this.storageBase, url, file.upload.headers, data)
            : (await this.fetchImpl(url.toString(), { method: "PUT", headers: file.upload.headers, body: data })).status;
        if (status < 200 || status >= 300) throw new Error(`storage PUT for ${filename} -> HTTP ${status}`);
        await this.json("POST", `/upload-sessions/${created.session.id}/files/${file.id}/complete`, {});
        const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
        for (let poll = 0; Date.now() < deadline; poll++) {
            const state = await this.json<SessionResponse>("GET", `/upload-sessions/${created.session.id}`);
            const row = state.files.find((f) => f.client_id === clientId);
            if (row?.status === "completed" && row.result && typeof row.result === "object") {
                return row.result as Record<string, unknown> & { id: string };
            }
            if (row?.status === "error") throw new Error(`upload of ${filename} failed: ${row.error_code ?? "unknown"}`);
            await sleep(Math.min(750 * 2 ** poll, 5_000));
        }
        throw new Error(`upload of ${filename} did not finish in time`);
    }
}

export type SseFrame = { id: string | null; data: Record<string, unknown> | "[DONE]" };

/**
 * The `data:` records of an SSE body, with the `id:` that preceded each.
 * Stops after `[DONE]`. Malformed JSON records are yielded as
 * `{type: "unparsed", raw}` so nothing the server sent is lost.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id: string | null = null;
    let data: string[] = [];
    const flush = (): SseFrame | null => {
        if (data.length === 0) return null;
        const raw = data.join("\n");
        data = [];
        const frameId = id;
        id = null;
        if (raw === "[DONE]") return { id: frameId, data: "[DONE]" };
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return { id: frameId, data: parsed as Record<string, unknown> };
            }
        } catch {
            /* fall through */
        }
        return { id: frameId, data: { type: "unparsed", raw } };
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, "");
                buffer = buffer.slice(nl + 1);
                if (line === "") {
                    const frame = flush();
                    if (frame) {
                        yield frame;
                        if (frame.data === "[DONE]") return;
                    }
                } else if (line.startsWith("data:")) {
                    data.push(line.slice(5).replace(/^ /, ""));
                } else if (line.startsWith("id:")) {
                    id = line.slice(3).trim();
                }
                // `event:`, `retry:` and `:` comments carry nothing the runner needs.
            }
            if (done) {
                if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
                const frame = flush();
                if (frame) yield frame;
                return;
            }
        }
    } finally {
        reader.releaseLock();
    }
}
