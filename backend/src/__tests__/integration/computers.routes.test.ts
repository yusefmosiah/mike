// A person's computer end to end over HTTP: add it in settings, let its
// helper collect a command a chat tool sent, answer it, and revoke it. The
// database is the in-memory store; the bridge is the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "../../lib/db";
import { memoryDb } from "../helpers/memoryDb";

const state = vi.hoisted(() => ({ db: undefined as Db | undefined }));

vi.mock("../../lib/db", () => ({ createDb: () => state.db }));
vi.mock("../../middleware/auth", async () => {
    const { authMock } = await import("../helpers/authMock.js");
    return authMock();
});

import { app } from "../../app";
import {
    resetDeviceBridgeForTests,
    runComputerTool,
    takeComputerScreenshot,
} from "../../modules/computers/computers.service";

let store: ReturnType<typeof memoryDb>;

beforeEach(() => {
    store = memoryDb();
    state.db = store.db;
});

afterEach(() => resetDeviceBridgeForTests());

async function addComputer(name = "Studio Mac") {
    const res = await request(app).post("/computers").send({ name });
    expect(res.status).toBe(201);
    return res.body as { device: { id: string; name: string; online: boolean }; token: string };
}

describe("computers", () => {
    it("adds a computer, shows its token once and stores only its hash", async () => {
        const { device, token } = await addComputer();
        expect(device).toMatchObject({ name: "Studio Mac", online: false });
        expect(token).toMatch(/^cmp_/);
        const row = store.rows("computer_devices")[0];
        expect(row.token_hash).toHaveLength(64);
        expect(JSON.stringify(row)).not.toContain(token);

        const list = await request(app).get("/computers");
        expect(list.status).toBe(200);
        expect(list.body.devices).toHaveLength(1);
        expect(JSON.stringify(list.body)).not.toContain(token);
    });

    it("refuses a missing name", async () => {
        const res = await request(app).post("/computers").send({ name: "  " });
        expect(res.status).toBe(400);
    });

    it("rejects a device request without a recognised token", async () => {
        expect((await request(app).post("/computers/device/heartbeat")).status).toBe(401);
        const res = await request(app)
            .post("/computers/device/heartbeat")
            .set("Authorization", "Bearer cmp_not-a-real-token");
        expect(res.status).toBe(401);
    });

    it("marks a computer online once its helper is heard from", async () => {
        const { token } = await addComputer();
        const beat = await request(app)
            .post("/computers/device/heartbeat")
            .set("Authorization", `Bearer ${token}`);
        expect(beat.status).toBe(200);
        const list = await request(app).get("/computers");
        expect(list.body.devices[0].online).toBe(true);
    });

    it("stores the platform and capabilities a heartbeat reports, and ignores junk", async () => {
        const { token } = await addComputer();
        const beat = (body: unknown) =>
            request(app).post("/computers/device/heartbeat").set("Authorization", `Bearer ${token}`).send(body as object);
        await beat({ platform: "linux", capabilities: { coordinates: "refs_only", takeover: "none", secure_input: "best_effort" } });
        expect((await request(app).get("/computers")).body.devices[0].platform).toBe("linux");
        expect(store.rows("computer_devices")[0].capabilities).toEqual({ coordinates: "refs_only", takeover: "none", secure_input: "best_effort" });
        expect((await beat({ platform: "amiga", capabilities: { coordinates: "everywhere" } })).status).toBe(200);
        expect(store.rows("computer_devices")[0].platform).toBe("linux");
    });

    it("sends a call to the computer it names, and says which are connected", async () => {
        const mac = await addComputer("Studio Mac");
        const pc = await addComputer("Office PC");
        for (const { token } of [mac, pc]) {
            await request(app).post("/computers/device/heartbeat").set("Authorization", `Bearer ${token}`);
        }
        const call = runComputerTool({ db: store.db, userId: "u1", callId: "c", name: "computer_observe", args: { computer: "office pc" } });
        const poll = await request(app).get("/computers/device/next?wait=5").set("Authorization", `Bearer ${pc.token}`);
        expect(poll.body.type).toBe("observe");
        await request(app)
            .post(`/computers/device/results/${poll.body.id}`)
            .set("Authorization", `Bearer ${pc.token}`)
            .send({ ok: false, error: "no screen" });
        expect(JSON.parse(await call).error).toBe("no screen");

        const unknown = JSON.parse(
            await runComputerTool({ db: store.db, userId: "u1", callId: "c", name: "computer_observe", args: { computer: "Laptop" } }),
        );
        expect(unknown.error).toMatch(/No connected computer is named 'Laptop'\. Connected: .*Studio Mac/);
    });

    it("refuses a coordinate click on a computer that takes refs only", async () => {
        const { token } = await addComputer();
        await request(app)
            .post("/computers/device/heartbeat")
            .set("Authorization", `Bearer ${token}`)
            .send({ platform: "linux", capabilities: { coordinates: "refs_only", takeover: "none", secure_input: "best_effort" } });
        const result = JSON.parse(
            await runComputerTool({
                db: store.db,
                userId: "u1",
                callId: "c",
                name: "computer_act",
                args: { frame_id: "f", actions: [{ type: "click", ref: "e1" }, { type: "click", x: 10, y: 10 }] },
            }),
        );
        expect(result.error).toMatch(/action 1: .* listed elements only/);
    });

    it("answers a poll with 204 when nothing is waiting", async () => {
        const { token } = await addComputer();
        const res = await request(app)
            .get("/computers/device/next?wait=0")
            .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(204);
    });

    it("carries a tool call to the helper and its observation back, screenshot apart", async () => {
        const { token } = await addComputer();
        await request(app).post("/computers/device/heartbeat").set("Authorization", `Bearer ${token}`);

        const call = runComputerTool({
            db: store.db,
            userId: "u1",
            callId: "cell-1.1",
            name: "computer_observe",
            args: { screenshot: true },
        });
        const poll = await request(app)
            .get("/computers/device/next?wait=5")
            .set("Authorization", `Bearer ${token}`);
        expect(poll.status).toBe(200);
        expect(poll.body).toMatchObject({ type: "observe", screenshot: true, max_elements: 80 });

        const posted = await request(app)
            .post(`/computers/device/results/${poll.body.id}`)
            .set("Authorization", `Bearer ${token}`)
            .send({
                ok: true,
                observation: {
                    frame_id: "f1",
                    app: { name: "TextEdit", bundle_id: "com.apple.TextEdit" },
                    window_title: "Untitled",
                    elements: [{ ref: "e1", role: "AXTextArea", frame: { x: 10, y: 20, w: 300, h: 200 } }],
                    screenshot: { data: "AAAA", mime_type: "image/jpeg", width: 1280, height: 800 },
                },
            });
        expect(posted.status).toBe(204);

        const text = JSON.parse(await call);
        expect(text).toMatchObject({ ok: true, frame_id: "f1", has_screenshot: true });
        expect(JSON.stringify(text)).not.toContain("AAAA");
        expect(takeComputerScreenshot("cell-1.1")).toEqual({ data: "AAAA", mimeType: "image/jpeg" });
        expect(takeComputerScreenshot("cell-1.1")).toBeNull();
    });

    it("refuses a result from another device", async () => {
        const first = await addComputer("One");
        const second = await addComputer("Two");
        await request(app).post("/computers/device/heartbeat").set("Authorization", `Bearer ${first.token}`);
        const call = runComputerTool({
            db: store.db,
            userId: "u1",
            callId: "c",
            name: "computer_act",
            args: { frame_id: "f1", actions: [{ type: "key", combo: "cmd+s" }] },
        });
        const poll = await request(app)
            .get("/computers/device/next?wait=5")
            .set("Authorization", `Bearer ${first.token}`);
        expect(poll.body).toMatchObject({ type: "act", frame_id: "f1" });
        const stolen = await request(app)
            .post(`/computers/device/results/${poll.body.id}`)
            .set("Authorization", `Bearer ${second.token}`)
            .send({ ok: true, act: { outcomes: [] } });
        expect(stolen.status).toBe(404);
        await request(app)
            .post(`/computers/device/results/${poll.body.id}`)
            .set("Authorization", `Bearer ${first.token}`)
            .send({ ok: true, act: { outcomes: [{ index: 0, ok: true }] } });
        expect(JSON.parse(await call)).toEqual({ ok: true, outcomes: [{ index: 0, ok: true }] });
    });

    it("tells the model when no computer is connected", async () => {
        await addComputer();
        const text = JSON.parse(
            await runComputerTool({ db: store.db, userId: "u1", callId: "c", name: "computer_observe", args: {} }),
        );
        expect(text.ok).toBe(false);
        expect(text.error).toMatch(/No computer is connected/);
    });

    it("validates actions before anything is sent", async () => {
        const { token } = await addComputer();
        await request(app).post("/computers/device/heartbeat").set("Authorization", `Bearer ${token}`);
        const run = (args: Record<string, unknown>) =>
            runComputerTool({ db: store.db, userId: "u1", callId: "c", name: "computer_act", args }).then(JSON.parse);
        expect((await run({ actions: [] })).error).toMatch(/frame_id/);
        expect((await run({ frame_id: "f", actions: [] })).error).toMatch(/non-empty/);
        expect((await run({ frame_id: "f", actions: [{ type: "format_disk" }] })).error).toMatch(/unknown type/);
        expect((await run({ frame_id: "f", actions: Array(21).fill({ type: "wait", ms: 1 }) })).error).toMatch(/at most 20/);
    });

    it("revokes a computer so its token stops working", async () => {
        const { device, token } = await addComputer();
        expect((await request(app).delete(`/computers/${device.id}`)).status).toBe(204);
        expect((await request(app).delete(`/computers/${device.id}`)).status).toBe(404);
        const res = await request(app)
            .post("/computers/device/heartbeat")
            .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
        expect((await request(app).get("/computers")).body.devices).toEqual([]);
    });
});
