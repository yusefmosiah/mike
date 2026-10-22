import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getMemoryVersion,
  listMemoryVersions,
  restoreMemoryVersion,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { MemoryVersionHistory } from "./MemoryVersionHistory";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  listMemoryVersions: vi.fn(),
  getMemoryVersion: vi.fn(),
  restoreMemoryVersion: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me" } }),
}));

const current: MemoryCurrent = {
  enabled: true,
  content: "- Short answers\n- Cites pinpoints",
  revision: 7,
  hash: "h7",
  updated_at: "2026-10-22T10:00:00.000Z",
  updated_by: "me",
  source: "curator",
  status: "idle",
};

function version(overrides: Partial<MemoryVersion>): MemoryVersion {
  return {
    id: "v",
    version_number: 1,
    revision: 1,
    source: "manual",
    change_summary: null,
    updated_by: "me",
    updated_by_name: null,
    source_chat_id: null,
    size_bytes: 10,
    created_at: "2026-10-20T10:00:00.000Z",
    updated_at: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

const versions = [
  version({
    id: "v3",
    version_number: 3,
    revision: 7,
    source: "curator",
    change_summary: "Added the citation preference.",
  }),
  version({ id: "v2", version_number: 2, revision: 4, updated_by: "colleague", updated_by_name: "Ada" }),
  version({ id: "v1", version_number: 1, revision: 1 }),
];

const texts: Record<string, string> = {
  v3: "- Short answers\n- Cites pinpoints",
  v2: "- British spelling\n- Short answers",
  v1: "- British spelling",
};

function renderHistory(props: Partial<Parameters<typeof MemoryVersionHistory>[0]> = {}) {
  const onRestored = vi.fn();
  render(
    <MemoryVersionHistory
      fileRef={{ scope: "user" }}
      current={current}
      canRestore
      onRestored={onRestored}
      {...props}
    />,
  );
  return { onRestored };
}

describe("MemoryVersionHistory", () => {
  beforeEach(() => {
    vi.mocked(listMemoryVersions).mockResolvedValue(versions);
    vi.mocked(getMemoryVersion).mockImplementation(async (_ref, id) => ({
      ...versions.find((v) => v.id === id)!,
      content: texts[id]!,
    }));
    vi.mocked(restoreMemoryVersion).mockReset();
  });

  it("lists who changed each version, and shows the newest as changes from the one before", async () => {
    renderHistory();
    const list = await screen.findByRole("list", { name: "Versions" });
    expect(within(list).getByText("Version 3 (current)")).toBeVisible();
    expect(within(list).getByText("Updated from a chat")).toBeVisible();
    expect(within(list).getByText("Edited by Ada")).toBeVisible();
    expect(within(list).getByText("Edited by you")).toBeVisible();
    expect(screen.getByText("Added the citation preference.")).toBeVisible();

    const changes = await screen.findByRole("list", { name: "Changes from the version before" });
    expect(within(changes).getByText("- Cites pinpoints").closest("li")).toHaveTextContent("Added:");
    expect(within(changes).getByText("- British spelling").closest("li")).toHaveTextContent("Removed:");
    // The newest version is what the file holds; there is nothing to restore.
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
  });

  it("shows a version's full text and the first version against an empty file", async () => {
    const user = userEvent.setup();
    renderHistory();
    await user.click(await screen.findByRole("button", { name: /Version 1/ }));
    const changes = await screen.findByRole("list", { name: "Changes from the version before" });
    expect(within(changes).getByText("- British spelling").closest("li")).toHaveTextContent("Added:");
    await user.click(screen.getByRole("button", { name: "Full text" }));
    expect(screen.getByText("- British spelling")).toBeVisible();
  });

  it("restores an earlier version against the revision the editor holds", async () => {
    const user = userEvent.setup();
    const restored = { ...current, content: texts.v2!, revision: 8, source: "manual" as const };
    vi.mocked(restoreMemoryVersion).mockResolvedValue(restored);
    const { onRestored } = renderHistory();
    await user.click(await screen.findByRole("button", { name: /Version 2/ }));
    await user.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(screen.getByText("Restore version 2?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(restored));
    expect(restoreMemoryVersion).toHaveBeenCalledWith({ scope: "user" }, "v2", 7);
  });

  it("says so when memory changed before the restore landed", async () => {
    const user = userEvent.setup();
    vi.mocked(restoreMemoryVersion).mockRejectedValue(
      new MikeApiError({ message: "conflict", status: 409 }),
    );
    const { onRestored } = renderHistory();
    await user.click(await screen.findByRole("button", { name: /Version 2/ }));
    await user.click(screen.getByRole("button", { name: "Restore this version" }));
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/memory changed while you were looking/i);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("holds restoring while the editor has unsaved text, and offers none without edit rights", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryVersionHistory
        fileRef={{ scope: "user" }}
        current={current}
        canRestore
        restoreBlockedReason="Your latest edits are still saving."
        onRestored={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Version 2/ }));
    expect(screen.getByRole("button", { name: "Restore this version" })).toBeDisabled();
    expect(screen.getByText("Your latest edits are still saving.")).toBeVisible();
    unmount();

    renderHistory({ fileRef: { scope: "project", projectId: "p1" }, canRestore: false });
    await user.click(await screen.findByRole("button", { name: /Version 2/ }));
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
  });

  it("offers a retry when the list cannot be loaded", async () => {
    vi.mocked(listMemoryVersions).mockRejectedValueOnce(new Error("boom"));
    renderHistory();
    expect(await screen.findByText("Version history could not be loaded")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Version 3 (current)")).toBeVisible();
  });
});
