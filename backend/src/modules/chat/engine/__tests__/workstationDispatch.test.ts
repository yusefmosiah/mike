import { afterEach, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/workstation/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/workstation/exec")>()),
  runInWorkstation: run,
}));

import { workstationFor } from "../../../../lib/workstation";
import { runToolCalls } from "../tools/toolDispatcher";

afterEach(() => {
  vi.unstubAllEnvs();
  run.mockReset();
});

const call = (args: Record<string, unknown>) => [{ id: "c1", function: { name: "run_command", arguments: JSON.stringify(args) } }];
// The turn resolves the workstation once and hands it to the dispatcher.
const dispatch = (args: Record<string, unknown>) =>
  runToolCalls(call(args), new Map(), "u1", {} as never, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    workstation: workstationFor("u1"),
  });
const content = (result: Awaited<ReturnType<typeof dispatch>>) => JSON.parse((result.toolResults[0] as { content: string }).content);

it("refuses when the user has no workstation", async () => {
  vi.stubEnv("WORKSTATION_USER_IDS", "someone-else");
  const result = await dispatch({ command: "ls" });
  expect(content(result)).toEqual({ error: "No workstation is configured for this user." });
  expect(run).not.toHaveBeenCalled();
});

it("runs the command in the user's workstation and returns its output", async () => {
  vi.stubEnv("WORKSTATION_USER_IDS", "u1");
  vi.stubEnv("WORKSTATION_SSH_HOST", "127.0.0.1");
  vi.stubEnv("WORKSTATION_SSH_PORT", "2222");
  vi.stubEnv("WORKSTATION_SSH_IDENTITY_FILE", "/keys/dev");
  run.mockResolvedValue({ ok: true, exitCode: 0, stdout: "4\n", stderr: "", truncated: false, timedOut: false, durationMs: 12 });
  const result = await dispatch({ command: "python3 -c 'print(2+2)'", cwd: "/home/agent/repo", timeout_seconds: 30 });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ host: "127.0.0.1", port: 2222, user: "agent" }),
    { command: "python3 -c 'print(2+2)'", cwd: "/home/agent/repo", timeoutMs: 30_000 },
  );
  expect(content(result)).toEqual({ exit_code: 0, stdout: "4\n", stderr: "", timed_out: false, truncated: false, duration_ms: 12 });
});

it("runs a guest's command only once the host's gate lets it", async () => {
  vi.stubEnv("WORKSTATION_USER_IDS", "u1");
  vi.stubEnv("WORKSTATION_SSH_HOST", "127.0.0.1");
  vi.stubEnv("WORKSTATION_SSH_PORT", "2222");
  vi.stubEnv("WORKSTATION_SSH_IDENTITY_FILE", "/keys/dev");
  run.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 1 });
  const guarded = (gate: (callId: string, summary: string) => Promise<string | null>) =>
    runToolCalls(call({ command: "rm -rf build" }), new Map(), "guest", {} as never, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      workstation: workstationFor("u1"),
      workstationGate: gate,
    });

  const refusing = vi.fn(async () => "The host did not allow running this command.");
  const refused = await guarded(refusing);
  expect(refusing).toHaveBeenCalledWith("c1", "rm -rf build");
  expect(content(refused)).toEqual({ error: "The host did not allow running this command." });
  expect(run).not.toHaveBeenCalled();

  const allowed = await guarded(async () => null);
  expect(content(allowed)).toMatchObject({ exit_code: 0 });
  expect(run).toHaveBeenCalledTimes(1);
});
