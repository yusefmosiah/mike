import { describe, expect, it } from "vitest";
import { moveToolActivityToInput } from "../contextBuilders";
import type { LlmMessage } from "../../../../lib/llm/types";

const summary = "[Tool activity in your previous turn]\n- user did not store the credential";

describe("moveToolActivityToInput", () => {
  it("moves the paused answer's summary onto the input that resumes it", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "Publish the article" },
      { role: "assistant", content: `I need a token.\n\n${summary}` },
      { role: "user", content: "Responses to your questions:\n1. Did not store the credential." },
    ];
    const moved = moveToolActivityToInput(messages);
    expect(moved[1]).toEqual({ role: "assistant", content: "I need a token." });
    expect(moved[2]!.content).toBe(`${summary}\n\nResponses to your questions:\n1. Did not store the credential.`);
    expect(messages[1]!.content).toContain(summary);
  });

  it("puts the summary first in an input with parts", () => {
    const moved = moveToolActivityToInput([
      { role: "assistant", content: `Done.\n\n${summary}` },
      { role: "user", content: [{ type: "text", text: "go on" }] },
    ]);
    expect(moved[1]!.content).toEqual([
      { type: "text", text: summary },
      { type: "text", text: "go on" },
    ]);
  });

  it("leaves messages without a summary alone", () => {
    const messages: LlmMessage[] = [
      { role: "assistant", content: "Done." },
      { role: "user", content: "next" },
    ];
    expect(moveToolActivityToInput(messages)).toBe(messages);
    expect(moveToolActivityToInput([{ role: "user", content: "only" }])).toHaveLength(1);
  });
});
