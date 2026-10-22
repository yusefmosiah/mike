import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  getMemoryVersion,
  getProjectMemory,
  getUserMemory,
  listMemoryVersions,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { MemoryUpdatedBlock } from "./MemoryUpdatedBlock";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getUserMemory: vi.fn(),
  getProjectMemory: vi.fn(),
  listMemoryVersions: vi.fn(),
  getMemoryVersion: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me" } }),
}));

const current: MemoryCurrent = {
  enabled: true,
  content: "- Governing law: England.",
  revision: 5,
  hash: "h",
  updated_at: null,
  updated_by: "me",
  source: "assistant",
  status: "idle",
};

const version = (n: number, source: MemoryVersion["source"]): MemoryVersion => ({
  id: `v${n}`,
  version_number: n,
  revision: n,
  source,
  change_summary: source === "assistant" ? "Added the governing law." : null,
  updated_by: "me",
  updated_by_name: null,
  source_chat_id: "chat-1",
  size_bytes: 10,
  created_at: "2026-10-22T10:00:00.000Z",
  updated_at: "2026-10-22T10:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectMemory).mockResolvedValue(current);
  vi.mocked(getUserMemory).mockResolvedValue(current);
  vi.mocked(listMemoryVersions).mockResolvedValue([version(3, "manual"), version(2, "assistant"), version(1, "manual")]);
  vi.mocked(getMemoryVersion).mockImplementation(async (_ref, id) => ({
    ...version(Number(id.slice(1)), id === "v2" ? "assistant" : "manual"),
    content: id === "v1" ? "" : "- Governing law: England.",
  }));
});

it("names the change in blue and opens the project's history at the version it made", async () => {
  const user = userEvent.setup();
  render(
    <MemoryUpdatedBlock
      event={{
        type: "memory_updated",
        scope: "project",
        project_id: "p1",
        version_id: "v2",
        version_number: 2,
        summary: "Added the governing law.",
      }}
    />,
  );
  expect(screen.getByText("Added the governing law.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Project memory updated.*version 2/ }));

  const dialog = await screen.findByRole("dialog", { name: "Version history" });
  expect(getProjectMemory).toHaveBeenCalledWith("p1", expect.anything());
  expect(listMemoryVersions).toHaveBeenCalledWith({ scope: "project", projectId: "p1" }, expect.anything());
  const selected = await within(dialog).findByRole("button", { current: true });
  expect(selected).toHaveTextContent("Version 2");
  expect(selected).toHaveTextContent("Changed by the assistant in a chat");
  // An earlier version, so it can be restored from here.
  expect(within(dialog).getByRole("button", { name: "Restore this version" })).toBeEnabled();
});

it("opens app memory for an app-scope update", async () => {
  const user = userEvent.setup();
  render(
    <MemoryUpdatedBlock
      event={{ type: "memory_updated", scope: "app", project_id: null, version_id: null, version_number: null, summary: "" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Memory updated" }));
  await screen.findByRole("dialog", { name: "Version history" });
  expect(getUserMemory).toHaveBeenCalled();
  expect(getProjectMemory).not.toHaveBeenCalled();
});
