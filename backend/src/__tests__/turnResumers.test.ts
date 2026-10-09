import { describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/db";
import type { InterruptedTurn } from "../lib/llm";
import { resumeInterruptedTurns, TURN_RESUMERS } from "../turnResumers";

const db = {} as Db;

function turn(id: string, context: unknown): InterruptedTurn {
  return { assistantMessageId: id, chatKey: "chat", context, startedAt: 0 };
}

describe("resumeInterruptedTurns", () => {
  it("has a resumer for every surface that stores a durable turn", () => {
    expect(Object.keys(TURN_RESUMERS).sort()).toEqual(
      ["chat", "project-chat", "tabular", "word"],
    );
  });

  it("hands each turn to its surface's resumer and gives up the rest", async () => {
    const chat = vi.fn(async () => undefined);
    const word = vi.fn(async () => undefined);
    const abandon = vi.fn(async () => undefined);
    const turns = [
      turn("a", { surface: "chat" }),
      turn("b", { surface: "word" }),
      turn("c", { surface: "retired-surface" }),
      turn("d", null),
    ];

    await resumeInterruptedTurns(db, {
      pending: async () => turns,
      resumers: { chat, word },
      abandon,
    });

    expect(chat).toHaveBeenCalledWith(db, turns[0]);
    expect(word).toHaveBeenCalledWith(db, turns[1]);
    expect(abandon.mock.calls).toEqual([["c"], ["d"]]);
  });

  it("keeps resuming the others when one resumer throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const chat = vi.fn(async () => {
      throw new Error("boom");
    });
    const tabular = vi.fn(async () => undefined);

    await resumeInterruptedTurns(db, {
      pending: async () => [turn("a", { surface: "chat" }), turn("b", { surface: "tabular" })],
      resumers: { chat, tabular },
      abandon: vi.fn(),
    });

    expect(tabular).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("survives not being able to read the interrupted turns", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      resumeInterruptedTurns(db, {
        pending: async () => {
          throw new Error("no database");
        },
      }),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });
});
