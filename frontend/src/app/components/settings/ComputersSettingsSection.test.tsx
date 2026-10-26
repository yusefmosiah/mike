import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputersSettingsSection,
  lastSeenText,
} from "./ComputersSettingsSection";

const api = vi.hoisted(() => ({
  listComputers: vi.fn(),
  createComputer: vi.fn(),
  revokeComputer: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  ...api,
}));

const device = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  name: "Desk Mac",
  created_at: "2026-01-01T00:00:00Z",
  last_seen_at: null,
  online: false,
  ...over,
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listComputers.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("lastSeenText", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  const at = (ms: number) =>
    device({ last_seen_at: new Date(now - ms).toISOString() });
  it("describes each age", () => {
    expect(lastSeenText(device({ online: true }), now)).toBe("Online");
    expect(lastSeenText(device(), now)).toBe("Never connected");
    expect(lastSeenText(at(5_000), now)).toBe("Last seen just now");
    expect(lastSeenText(at(5 * 60_000), now)).toBe("Last seen 5 min ago");
    expect(lastSeenText(at(3 * 3_600_000), now)).toBe("Last seen 3 h ago");
    expect(lastSeenText(at(86_400_000), now)).toBe("Last seen 1 day ago");
    expect(lastSeenText(at(3 * 86_400_000), now)).toBe("Last seen 3 days ago");
    expect(lastSeenText(at(-5_000), now)).toBe("Last seen just now");
  });
});

describe("ComputersSettingsSection", () => {
  it("shows an empty state", async () => {
    render(<ComputersSettingsSection />);
    expect(
      await screen.findByText("No computers connected yet."),
    ).toBeTruthy();
  });

  it("lists devices with status text", async () => {
    api.listComputers.mockResolvedValue([
      device({ online: true }),
      device({ id: "d2", name: "Laptop" }),
    ]);
    render(<ComputersSettingsSection />);
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.getByText("Never connected")).toBeTruthy();
  });

  it("reports a load failure and keeps the add control", async () => {
    api.listComputers.mockRejectedValue(new Error("boom"));
    render(<ComputersSettingsSection />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Computers could not be loaded.",
    );
    expect(screen.getByLabelText("Computer name")).toBeTruthy();
  });

  it("creates a computer and shows the token once", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    api.createComputer.mockResolvedValue({ device: device(), token: "secret-token" });
    render(<ComputersSettingsSection />);
    await screen.findByText("No computers connected yet.");
    const input = screen.getByLabelText("Computer name") as HTMLInputElement;
    expect(input.value).toBe("My Mac");
    await user.clear(input);
    await user.type(input, "  Desk Mac ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(api.createComputer).toHaveBeenCalledWith("Desk Mac");
    const token = (await screen.findByLabelText("Device token")) as HTMLInputElement;
    expect(token.value).toBe("secret-token");
    expect(token.readOnly).toBe(true);
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/api`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenCalledWith("secret-token");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("ignores a blank name and reports create and copy failures", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
      configurable: true,
    });
    api.createComputer.mockRejectedValueOnce(new Error("x"));
    render(<ComputersSettingsSection />);
    await screen.findByText("No computers connected yet.");
    const input = screen.getByLabelText("Computer name");
    await user.clear(input);
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, "Mac{enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The computer could not be added.",
    );
    api.createComputer.mockResolvedValueOnce({ device: device(), token: "t" });
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("button", { name: "Copy token" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be copied/);
  });

  it("revokes after confirmation, and can cancel", async () => {
    const user = userEvent.setup();
    api.listComputers.mockResolvedValue([device()]);
    api.revokeComputer.mockResolvedValue(undefined);
    render(<ComputersSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Revoke Desk Mac" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.revokeComputer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Revoke Desk Mac" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.revokeComputer).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears the token when its computer is revoked and reports revoke errors", async () => {
    const user = userEvent.setup();
    api.listComputers.mockResolvedValue([device()]);
    api.createComputer.mockResolvedValue({ device: device(), token: "t" });
    api.revokeComputer.mockRejectedValueOnce(new Error("x"));
    api.revokeComputer.mockResolvedValueOnce(undefined);
    render(<ComputersSettingsSection />);
    await screen.findByText("Desk Mac");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByLabelText("Device token");
    await user.click(screen.getByRole("button", { name: "Revoke Desk Mac" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The computer could not be revoked.",
    );
    await user.click(screen.getByRole("button", { name: "Revoke Desk Mac" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByLabelText("Device token")).toBeNull());
  });

  it("refreshes every 15 seconds and stops on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ComputersSettingsSection />);
    await act(async () => {});
    expect(api.listComputers).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(api.listComputers).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.listComputers).toHaveBeenCalledTimes(2);
  });

  it("ignores a response that lands after unmount", async () => {
    let resolve!: (v: never[]) => void;
    api.listComputers.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(<ComputersSettingsSection />);
    unmount();
    await act(async () => resolve([]));
    let reject!: (e: Error) => void;
    api.listComputers.mockReturnValue(new Promise((_, r) => (reject = r)));
    const second = render(<ComputersSettingsSection />);
    second.unmount();
    await act(async () => reject(new Error("late")));
  });
});
