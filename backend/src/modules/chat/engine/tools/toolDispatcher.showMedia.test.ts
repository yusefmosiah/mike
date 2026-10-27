/**
 * show_media: the model shows an image, audio or video document inline. The
 * document is resolved from the chat's own index and store, only media types
 * are accepted, and the model sees the filename alone — the document id and
 * version belong to the wire event.
 */
import { describe, expect, it } from "vitest";

import type { MediaEvent } from "@mike/contracts";
import { isMeaningfulTextlessAssistantOutput } from "../contextBuilders";
import type { DocIndex, DocStore } from "../types";
import { runToolCalls } from "./toolDispatcher";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const DOC_INDEX: DocIndex = {
  "doc-0": {
    document_id: DOC_ID,
    filename: "chart.png",
    version_id: VERSION_ID,
    version_number: 3,
  },
};

const DOC_STORE: DocStore = new Map([
  [
    "doc-0",
    {
      storage_path: "documents/chart.png",
      file_type: "png",
      filename: "chart.png",
    },
  ],
]);

type Call = { id: string; args: Record<string, unknown> };

async function dispatch(
  calls: Call[],
  docs: { docStore?: DocStore; docIndex?: DocIndex } = {},
) {
  const docStore = "docStore" in docs && docs.docStore ? docs.docStore : DOC_STORE;
  const docIndex = "docIndex" in docs && docs.docIndex ? docs.docIndex : DOC_INDEX;
  const frames: string[] = [];
  const result = await runToolCalls(
    calls.map((call) => ({
      id: call.id,
      function: { name: "show_media", arguments: JSON.stringify(call.args) },
    })),
    docStore,
    "user-1",
    {} as never,
    (frame) => frames.push(frame),
    undefined,
    undefined,
    docIndex,
  );
  return {
    result,
    frames: frames
      .filter((frame) => frame.startsWith("data: {"))
      .map((frame) => JSON.parse(frame.slice(6)) as MediaEvent),
    contents: result.toolResults.map(toolContent),
  };
}

/** The string a tool result carries for the model. */
function toolContent(entry: unknown): string {
  return entry &&
    typeof entry === "object" &&
    "content" in entry &&
    typeof entry.content === "string"
    ? entry.content
    : "";
}

describe("show_media", () => {
  it("emits a media event and frame for an image, and tells the model only the filename", async () => {
    const { result, frames, contents } = await dispatch([
      { id: "call-1", args: { doc_id: "doc-0", caption: "Revenue by quarter" } },
    ]);

    expect(result.mediaEvents).toEqual([
      {
        type: "media",
        call_id: "call-1",
        document_id: DOC_ID,
        version_id: VERSION_ID,
        version_number: 3,
        filename: "chart.png",
        kind: "image",
        caption: "Revenue by quarter",
      },
    ]);
    expect(frames).toEqual(result.mediaEvents);
    expect(contents).toEqual([JSON.stringify({ shown: "chart.png" })]);
    // The model-facing result carries no document id, version or URL.
    expect(contents[0]).not.toContain(DOC_ID);
    expect(contents[0]).not.toContain(VERSION_ID);
    expect(contents[0]).not.toContain("http");
    expect(contents[0]).not.toContain("documents/");
  });

  it("resolves each document's own kind from its file type", async () => {
    const docStore: DocStore = new Map([
      ...DOC_STORE,
      ["doc-1", { storage_path: "documents/brief.mp3", file_type: "mp3", filename: "brief.mp3" }],
      ["doc-2", { storage_path: "documents/walkthrough.mp4", file_type: "mp4", filename: "walkthrough.mp4" }],
    ]);
    const docIndex: DocIndex = {
      ...DOC_INDEX,
      "doc-1": { document_id: "audio-id", filename: "brief.mp3", version_id: "audio-v", version_number: 1 },
      "doc-2": { document_id: "video-id", filename: "walkthrough.mp4", version_id: "video-v", version_number: 4 },
    };

    const { result } = await dispatch(
      [
        { id: "call-1", args: { doc_id: "doc-1" } },
        { id: "call-2", args: { doc_id: "doc-2" } },
      ],
      { docStore, docIndex },
    );

    expect(
      result.mediaEvents.map((event) => ({
        kind: event.kind,
        filename: event.filename,
        version_number: event.version_number,
      })),
    ).toEqual([
      { kind: "audio", filename: "brief.mp3", version_number: 1 },
      { kind: "video", filename: "walkthrough.mp4", version_number: 4 },
    ]);
  });

  it("refuses an unknown label with an error and no event", async () => {
    const { result, frames, contents } = await dispatch([
      { id: "call-1", args: { doc_id: "doc-99" } },
    ]);

    expect(result.mediaEvents).toEqual([]);
    expect(frames).toEqual([]);
    expect(JSON.parse(contents[0])).toEqual({
      error: expect.stringContaining('"doc-99"'),
    });
  });

  it("refuses a non-media document and points at the document card instead", async () => {
    const { result, frames, contents } = await dispatch([{ id: "call-1", args: { doc_id: "doc-0" } }], {
      docStore: new Map([
        ["doc-0", { storage_path: "documents/lease.pdf", file_type: "pdf", filename: "lease.pdf" }],
      ]),
    });

    expect(result.mediaEvents).toEqual([]);
    expect(frames).toEqual([]);
    expect(JSON.parse(contents[0])).toEqual({
      error: expect.stringContaining("not an image, audio or video"),
    });
  });

  it("refuses a document with no index entry", async () => {
    const { result, contents } = await dispatch([{ id: "call-1", args: { doc_id: "doc-0" } }], {
      docIndex: {},
    });

    expect(result.mediaEvents).toEqual([]);
    expect(JSON.parse(contents[0])).toEqual({
      error: expect.stringContaining("no saved version"),
    });
  });

  it("refuses a label missing from the document store", async () => {
    const { result, contents } = await dispatch([{ id: "call-1", args: { doc_id: "doc-0" } }], {
      docStore: new Map(),
    });

    expect(result.mediaEvents).toEqual([]);
    expect(JSON.parse(contents[0])).toEqual({
      error: expect.stringContaining("is available in this chat"),
    });
  });

  it("trims and clamps the caption, and leaves it out when empty", async () => {
    const { result } = await dispatch([
      { id: "call-1", args: { doc_id: "doc-0", caption: `  ${"x".repeat(400)}  ` } },
      { id: "call-2", args: { doc_id: "doc-0", caption: "   " } },
      { id: "call-3", args: { doc_id: "doc-0", caption: 42 } },
    ]);

    expect(result.mediaEvents[0].caption).toBe("x".repeat(300));
    expect(result.mediaEvents[1]).not.toHaveProperty("caption");
    expect(result.mediaEvents[2]).not.toHaveProperty("caption");
  });

  it("accepts a filename in place of a label, as the other document tools do", async () => {
    const { result } = await dispatch([{ id: "call-1", args: { doc_id: "chart.png" } }]);

    expect(result.mediaEvents).toEqual([
      expect.objectContaining({ filename: "chart.png", kind: "image" }),
    ]);
  });

  it("stamps each event with the call that produced it", async () => {
    const { result } = await dispatch([
      { id: "call-a", args: { doc_id: "doc-0" } },
      { id: "call-b", args: { doc_id: "doc-0" } },
    ]);

    expect(result.mediaEvents.map((event) => event.call_id)).toEqual([
      "call-a",
      "call-b",
    ]);
  });
});

describe("a media event alone", () => {
  it("completes an otherwise textless turn, unlike a document read", () => {
    expect(
      isMeaningfulTextlessAssistantOutput({
        type: "media",
        document_id: DOC_ID,
        version_id: VERSION_ID,
        version_number: 3,
        filename: "chart.png",
        kind: "image",
      }),
    ).toBe(true);
    expect(
      isMeaningfulTextlessAssistantOutput({ type: "doc_read", filename: "chart.png" }),
    ).toBe(false);
  });
});
