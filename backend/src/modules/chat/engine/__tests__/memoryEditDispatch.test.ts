import { beforeEach, expect, it, vi } from "vitest";
import { runToolCalls } from "../tools/toolDispatcher";
import { editMemoryFromConversation, type MemoryEditTarget } from "../../../memory/memory.service";
import type { Db } from "../../../../lib/db";

vi.mock("../../../memory/memory.service", () => ({
  editMemoryFromConversation: vi.fn(),
}));

const call = {
  id: "call-1",
  function: {
    name: "edit_memory",
    arguments: JSON.stringify({
      scope: "project",
      edits: [{ old_text: "", new_text: "- Governing law: England." }],
      summary: "Added the governing law.",
    }),
  },
};

const target: MemoryEditTarget = {
  userId: "u1",
  appWritable: false,
  projectId: "p1",
  surface: "chat",
  conversationId: "chat-1",
};

async function dispatch(memoryEdit: MemoryEditTarget | null) {
  const write = vi.fn();
  const result = await runToolCalls(
    [call], new Map(), "u1", {} as Db, write,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { memoryEdit },
  );
  return { result, write };
}

beforeEach(() => vi.mocked(editMemoryFromConversation).mockReset());

it("streams and returns a memory_updated event for an edit that changed the file", async () => {
  vi.mocked(editMemoryFromConversation).mockResolvedValue({
    ok: true, scope: "project", projectId: "p1", versionId: "v7", versionNumber: 7,
    summary: "Added the governing law.", changed: true,
  });
  const { result, write } = await dispatch(target);
  const event = {
    type: "memory_updated", scope: "project", project_id: "p1",
    version_id: "v7", version_number: 7, summary: "Added the governing law.",
    call_id: "call-1",
  };
  expect(editMemoryFromConversation).toHaveBeenCalledWith(expect.anything(), target, JSON.parse(call.function.arguments));
  expect(write).toHaveBeenCalledWith(`data: ${JSON.stringify(event)}\n\n`);
  expect(result.memoryUpdates).toEqual([event]);
  expect(result.toolResults).toEqual([
    expect.objectContaining({ tool_call_id: "call-1", content: expect.stringMatching(/^Memory updated \(version 7\)/) }),
  ]);
});

it("shows nothing when the file already said it, or when the edit is refused", async () => {
  vi.mocked(editMemoryFromConversation).mockResolvedValueOnce({
    ok: true, scope: "project", projectId: "p1", versionId: null, versionNumber: null,
    summary: "Added the governing law.", changed: false,
  });
  let { result, write } = await dispatch(target);
  expect(write).not.toHaveBeenCalled();
  expect(result.memoryUpdates).toEqual([]);
  expect(result.toolResults[0]).toMatchObject({ content: expect.stringMatching(/Nothing changed/) });

  ({ result, write } = await dispatch(null));
  expect(editMemoryFromConversation).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  expect(result.toolResults[0]).toMatchObject({
    content: JSON.stringify({ error: "Memory cannot be changed from this conversation." }),
  });
});
