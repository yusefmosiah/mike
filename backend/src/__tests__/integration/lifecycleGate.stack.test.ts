import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { Client } from "pg";

// The document-lifecycle guard exists to stop code from serving requests the
// database cannot back (deletes that orphan storage, uploads that fail on a
// missing column). It only does that if the answer is in BEFORE the API binds
// its port and before any worker claims a job. An earlier version fired the
// probe without awaiting it: `app.listen` and `startAllWorkers` ran while the
// check was still in flight, so a destructive request or a claimed job could
// land in the window between "listening" and "exit(1)".
//
// This spawns the real entrypoints against a scratch database whose probe
// answers 0 ("migration not applied") and asserts that neither process ever
// reports listening or starting its runner before it exits 1.
//
// Gated: it needs a Postgres it may create a database in (DATABASE_TEST_URL,
// set by scripts/test-stack.sh).
const adminUrl = process.env.DATABASE_TEST_URL;
const maybeDescribe = adminUrl ? describe : describe.skip;
const backendRoot = path.resolve(__dirname, "..", "..", "..");

/** A fresh database with only the lifecycle probe, answering "not applied". */
async function scratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
    const name = `mike_gate_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const scratch = new Client({ connectionString: url.toString() });
    await scratch.connect();
    await scratch.query("CREATE FUNCTION public.document_lifecycle_version() RETURNS integer LANGUAGE sql AS 'SELECT 0'");
    await scratch.end();
    return {
        url: url.toString(),
        drop: async () => {
            const cleanup = new Client({ connectionString: adminUrl });
            await cleanup.connect();
            await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            await cleanup.end();
        },
    };
}

async function runEntrypoint(
    file: string,
    env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
    const child: ChildProcess = spawn(
        process.execPath,
        ["--import", path.join(backendRoot, "node_modules/tsx/dist/loader.mjs"), path.join(backendRoot, file)],
        { cwd: backendRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    // Generous: under a full parallel vitest run on a small machine, booting
    // the real entrypoint through tsx can take well over ten seconds.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    const [code] = (await once(child, "exit")) as [number | null];
    clearTimeout(timeout);
    return { code, output };
}

let drop: (() => Promise<void>) | null = null;
afterEach(async () => {
    await drop?.();
    drop = null;
});

maybeDescribe("document-lifecycle boot gate", () => {
    it("API: refuses to listen or start workers when the migration is missing", async () => {
        const database = await scratchDatabase();
        drop = database.drop;
        const { code, output } = await runEntrypoint("src/index.ts", {
            PORT: "0",
            WORKERS_MODE: "inline",
            QUEUE_DRIVER: "postgres",
            DB_JOBS_POLL_MS: "60000",
            AUTH_URL: "http://127.0.0.1:9",
            AUTH_SERVICE_KEY: "not-a-real-key",
            DATABASE_URL: database.url,
        });
        expect(output).toMatch(/document-lifecycle migration is not applied/);
        expect(output).not.toMatch(/Mike backend running on port/);
        expect(output).not.toMatch(/\[dbq\] runner started/);
        expect(code).toBe(1);
    }, 60_000);

    it("worker: refuses to start the runner when the migration is missing", async () => {
        const database = await scratchDatabase();
        drop = database.drop;
        const { code, output } = await runEntrypoint("src/worker.ts", {
            QUEUE_DRIVER: "postgres",
            DB_JOBS_POLL_MS: "60000",
            AUTH_URL: "http://127.0.0.1:9",
            AUTH_SERVICE_KEY: "not-a-real-key",
            DATABASE_URL: database.url,
        });
        expect(output).toMatch(/document-lifecycle migration is not applied/);
        expect(output).not.toMatch(/\[dbq\] runner started/);
        expect(code).toBe(1);
    }, 60_000);
});
