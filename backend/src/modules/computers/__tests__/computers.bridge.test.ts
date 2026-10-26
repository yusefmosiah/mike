import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextDeviceCommand,
  requeueDeviceCommand,
  resetDeviceBridgeForTests,
  sendDeviceCommand,
  submitDeviceResult,
} from "../computers.bridge";

afterEach(() => {
  resetDeviceBridgeForTests();
  vi.useRealTimers();
});

const observe = { type: "observe" as const, screenshot: false, max_elements: 10 };

describe("computer command bridge", () => {
  it("hands a queued command to the next poll and resolves with its result", async () => {
    const sent = sendDeviceCommand("d1", observe, { timeoutMs: 1000 });
    const command = await nextDeviceCommand("d1", 1000);
    expect(command).toMatchObject(observe);
    expect(submitDeviceResult("d1", command!.id, { ok: false, error: "no" })).toBe(true);
    await expect(sent).resolves.toEqual({ ok: false, error: "no" });
  });

  it("gives a waiting poll a command sent later", async () => {
    const poll = nextDeviceCommand("d1", 1000);
    void sendDeviceCommand("d1", observe, { timeoutMs: 1000 });
    expect(await poll).toMatchObject({ type: "observe" });
  });

  it("keeps devices apart", async () => {
    void sendDeviceCommand("d1", observe, { timeoutMs: 1000 });
    expect(await nextDeviceCommand("d2", 0)).toBeNull();
  });

  it("refuses a result before delivery or for an unknown command", async () => {
    void sendDeviceCommand("d1", observe, { timeoutMs: 1000 });
    expect(submitDeviceResult("d1", "nope", { ok: false, error: "x" })).toBe(false);
  });

  it("says whether the helper never collected or never answered", async () => {
    vi.useFakeTimers();
    const uncollected = sendDeviceCommand("d1", observe, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    await expect(uncollected).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/did not collect/) });

    const unanswered = sendDeviceCommand("d1", observe, { timeoutMs: 100 });
    const poll = nextDeviceCommand("d1", 50);
    expect(await poll).not.toBeNull();
    await vi.advanceTimersByTimeAsync(150);
    await expect(unanswered).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/did not answer/) });
  });

  it("stops waiting when the turn is stopped", async () => {
    const controller = new AbortController();
    const sent = sendDeviceCommand("d1", observe, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(sent).resolves.toEqual({ ok: false, error: "The turn was stopped." });
    expect(await nextDeviceCommand("d1", 0)).toBeNull();
  });

  it("puts back a command whose poll response was lost", async () => {
    void sendDeviceCommand("d1", observe, { timeoutMs: 1000 });
    const first = await nextDeviceCommand("d1", 0);
    requeueDeviceCommand("d1", first!.id);
    expect((await nextDeviceCommand("d1", 0))?.id).toBe(first!.id);
  });
});
