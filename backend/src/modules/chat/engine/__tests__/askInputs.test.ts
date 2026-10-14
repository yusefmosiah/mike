import { describe, expect, it, vi } from "vitest";

import { parseAskInputs } from "../tools/askInputs";
import { runToolCalls } from "../tools/toolDispatcher";

// ask_inputs must show the user real questions or nothing at all. These are
// the shapes models were seen writing in production traces.

describe("parseAskInputs", () => {
  it("reads the canonical shape unchanged", () => {
    const parsed = parseAskInputs({
      items: [
        {
          id: "law",
          kind: "choice",
          question: "Which governing law?",
          options: [{ value: "England" }, { value: "New York" }],
          allow_other: false,
        },
        { id: "party", kind: "text", question: "Counterparty name?", response_prefix: "Name: " },
        { id: "files", kind: "documents", document_types: ["Signed NDA"] },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      items: [
        {
          id: "law",
          kind: "choice",
          question: "Which governing law?",
          options: [{ value: "England" }, { value: "New York" }],
          allow_other: false,
          other_label: "Other",
        },
        { id: "party", kind: "text", question: "Counterparty name?", response_prefix: "Name:" },
        { id: "files", kind: "documents", document_types: ["Signed NDA"] },
      ],
    });
  });

  it("accepts type for kind, prompt/label/text for question, and string options", () => {
    const parsed = parseAskInputs({
      items: [
        { type: "choice", prompt: "Which audience?", options: ["Lawyers", "Clients"] },
        { type: "text", prompt: "Any word limit?" },
        { type: "multiple_choice", label: "Which sections?", options: [{ label: "Intro" }, "Body"] },
        { type: "free-text", text: "Anything else?" },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      items: [
        {
          id: "choice-1",
          kind: "choice",
          question: "Which audience?",
          options: [{ value: "Lawyers" }, { value: "Clients" }],
          allow_other: true,
          other_label: "Other",
        },
        { id: "text-2", kind: "text", question: "Any word limit?" },
        {
          id: "multi-choice-3",
          kind: "multi_choice",
          question: "Which sections?",
          options: [{ value: "Intro" }, { value: "Body" }],
          allow_other: true,
          other_label: "Other",
        },
        { id: "text-4", kind: "text", question: "Anything else?" },
      ],
    });
  });

  it("refuses an item without a question instead of inventing one", () => {
    const parsed = parseAskInputs({
      items: [
        { kind: "choice", question: "Pick one", options: [{ value: "A" }] },
        { id: "q2", kind: "choice", options: [{ value: "A" }] },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('item 2 ("q2") has no question text');
    expect(parsed.error).toContain('"kind": "choice" | "multi_choice" | "text" | "documents"');
    expect(parsed.error).toContain("Example: {");
    expect(parsed.error).not.toContain("Please choose");
  });

  it("refuses a choice without options and an unknown kind", () => {
    const parsed = parseAskInputs({
      items: [
        { kind: "choice", question: "Pick one" },
        { kind: "slider", question: "How sure?" },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("item 1 is a choice with no usable options");
    expect(parsed.error).toContain('item 2 has kind "slider"');
    expect(parsed.error).not.toContain("Continue");
  });

  it("refuses an empty or missing items list", () => {
    expect(parseAskInputs({}).ok).toBe(false);
    expect(parseAskInputs({ items: [] }).ok).toBe(false);
  });
});

describe("ask_inputs in the dispatcher", () => {
  const dispatch = (args: Record<string, unknown>) =>
    runToolCalls(
      [{ id: "c1", function: { name: "ask_inputs", arguments: JSON.stringify(args) } }],
      new Map(),
      "u1",
      {} as never,
      vi.fn(),
    );

  it("pauses with the normalized questions when the call is usable", async () => {
    const result = await dispatch({
      items: [{ type: "choice", prompt: "Which tone?", options: ["Formal", "Plain"] }],
    });
    expect(result.toolResults).toEqual([]);
    expect(result.askInputsEvents).toHaveLength(1);
    expect(result.askInputsEvents[0].items).toEqual([
      {
        id: "choice-1",
        kind: "choice",
        question: "Which tone?",
        options: [{ value: "Formal" }, { value: "Plain" }],
        allow_other: true,
        other_label: "Other",
      },
    ]);
  });

  it("returns an error to the model and asks the user nothing when an item is unusable", async () => {
    const result = await dispatch({ items: [{ kind: "text" }, { kind: "choice", question: "Pick" }] });
    expect(result.askInputsEvents).toEqual([]);
    expect(result.toolResults).toHaveLength(1);
    const content = JSON.parse((result.toolResults[0] as { content: string }).content);
    expect(content.ok).toBe(false);
    expect(content.error).toMatch(/^ask_inputs was not shown to the user: item 1 has no question text/);
  });
});
