import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishRequestItem } from "@mike/contracts";

const facade = vi.hoisted(() => ({
  describeOwnPublication: vi.fn(),
  publishPreflight: vi.fn(),
}));
vi.mock("../../../publications/publications.service", async (original) => ({
  ...(await original<typeof import("../../../publications/publications.service")>()),
  describeOwnPublication: facade.describeOwnPublication,
  publishPreflight: facade.publishPreflight,
}));

import {
  appendAskInputsResponseToAssistantMessage,
  enrichWithPriorEvents,
  parseAskInputsResponsePayload,
} from "../contextBuilders";
import { runPublishTool } from "../tools/publishTools";

const item: PublishRequestItem = {
  id: "publish-1",
  kind: "publish",
  document_id: "doc-1",
  version_id: "v1",
  filename: "Field notes.html",
  audience: "password",
  require_sign_in: true,
  expires_in_days: 30,
  purpose: "Share the article with the client.",
};

/** One assistant row whose events the RPCs append to, like chat_messages. */
function messageDb(content: Record<string, unknown>[]) {
  const row = {
    id: "assistant-1",
    chat_id: "chat-1",
    role: "assistant",
    content,
    citations: null,
    author_user_id: "user-1",
    created_at: "2026-01-01T00:00:00Z",
  };
  const db = {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(resolve),
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "append_chat_ask_inputs_response") row.content = [...row.content, args.p_response as never];
      return { data: "appended", error: null };
    },
  };
  return { db: db as never, row };
}

const view = {
  id: "pub-1",
  url: "https://abc.pub.example/",
  audience: "password",
  require_sign_in: true,
  expires_at: "2026-11-23T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publish answers", () => {
  it("carries only the publication id from the client", () => {
    expect(
      parseAskInputsResponsePayload({
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [
          { id: "publish-1", kind: "publish", publication_id: "pub-1", url: "https://evil.example/", password: "x" },
          { id: "publish-2", kind: "publish" },
        ],
      })?.responses,
    ).toEqual([
      { id: "publish-1", kind: "publish", publication_id: "pub-1" },
      { id: "publish-2", kind: "publish", skipped: true },
    ]);
  });

  it("stores the link read from the person's own publication", async () => {
    facade.describeOwnPublication.mockResolvedValue(view);
    const { db, row } = messageDb([{ type: "ask_inputs", event_id: "ask-1", items: [item] }]);
    const result = await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "publish-1", kind: "publish", publication_id: "pub-1" }],
      },
      "user-1",
    );
    expect(result).toBe("appended");
    expect(facade.describeOwnPublication).toHaveBeenCalledWith(db, "user-1", "pub-1", "doc-1");
    expect((row.content[1] as { responses: unknown[] }).responses).toEqual([
      {
        id: "publish-1",
        kind: "publish",
        publication_id: "pub-1",
        url: view.url,
        audience: "password",
        require_sign_in: true,
        expires_at: view.expires_at,
      },
    ]);
  });

  it("records a publication that is not theirs, or not of this document, as not published", async () => {
    facade.describeOwnPublication.mockResolvedValue(null);
    const { db, row } = messageDb([{ type: "ask_inputs", event_id: "ask-1", items: [item] }]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "publish-1", kind: "publish", publication_id: "someone-elses" }],
      },
      "user-1",
    );
    expect((row.content[1] as { responses: unknown[] }).responses).toEqual([
      { id: "publish-1", kind: "publish", skipped: true },
    ]);
  });

  it("tells the model where it went and who can open it, never the password", async () => {
    const replay = async (response: Record<string, unknown>) => {
      const { db } = messageDb([
        { type: "ask_inputs", event_id: "ask-1", items: [item] },
        { type: "ask_inputs_response", ask_event_id: "ask-1", responses: [response] },
      ]);
      const [assistant] = await enrichWithPriorEvents(
        [
          { role: "assistant", content: "Here is the form." },
          { role: "user", content: "Done." },
        ],
        "chat-1",
        db,
        {},
        "nonce1234",
      );
      return assistant.content ?? "";
    };
    const published = await replay({ id: "publish-1", kind: "publish", ...view, publication_id: "pub-1" });
    expect(published).toMatch(/asked user to publish .*Field notes\.html.* as a link/s);
    expect(published).toMatch(/user published the document at .*abc\.pub\.example/s);
    expect(published).toContain("the password the user set (you do not know it)");
    expect(published).toContain("who is signed in and can open the document; it expires 2026-11-23");
    expect(published).not.toContain("asked user for");

    const open = await replay({ id: "publish-1", kind: "publish", ...view, audience: "public", require_sign_in: false, expires_at: null });
    expect(open).toContain("for anyone with the link; it does not expire");

    expect(await replay({ id: "publish-1", kind: "publish", skipped: true })).toContain("user did not publish the document");
  });
});

describe("publish_document", () => {
  const run = (overrides: Partial<Parameters<typeof runPublishTool>[0]> = {}) =>
    runPublishTool({
      db: {} as never,
      args: { doc_id: "doc-a", password: true, require_sign_in: true, expires_in_days: 7, purpose: "  For the client.  " },
      userId: "user-1",
      userEmail: "u@example.test",
      document: { document_id: "doc-1", version_id: null },
      canAsk: true,
      ...overrides,
    });

  it("pauses the turn on a form prefilled with the assistant's suggestions", async () => {
    facade.publishPreflight.mockResolvedValue({ ok: true, documentId: "doc-1", versionId: "v3", filename: "Field notes.html" });
    const outcome = await run();
    expect(facade.publishPreflight).toHaveBeenCalledWith({}, "user-1", "u@example.test", "doc-1", null);
    expect(outcome.item).toMatchObject({
      kind: "publish",
      document_id: "doc-1",
      version_id: "v3",
      filename: "Field notes.html",
      audience: "password",
      require_sign_in: true,
      expires_in_days: 7,
      purpose: "For the client.",
    });
    expect(JSON.parse(outcome.content)).toMatchObject({ ok: false, status: "awaiting_user" });
  });

  it("defaults to a public link for 30 days, and keeps a chosen no-expiry", async () => {
    facade.publishPreflight.mockResolvedValue({ ok: true, documentId: "doc-1", versionId: "v3", filename: "a.pdf" });
    expect((await run({ args: { doc_id: "doc-a" } })).item).toMatchObject({
      audience: "public",
      require_sign_in: false,
      expires_in_days: 30,
      purpose: "",
    });
    expect((await run({ args: { doc_id: "doc-a", expires_in_days: null } })).item?.expires_in_days).toBeNull();
    expect((await run({ args: { doc_id: "doc-a", expires_in_days: 12 } })).item?.expires_in_days).toBe(30);
  });

  it("refuses without asking when it cannot pause, the document is unknown, or publishing would fail", async () => {
    expect(JSON.parse((await run({ canAsk: false })).content).error).toMatch(/cannot pause/);
    expect(JSON.parse((await run({ document: null })).content).error).toMatch(/doc_id/);
    facade.publishPreflight.mockResolvedValue({ ok: false, code: "not_owner" });
    const refused = await run();
    expect(refused.item).toBeUndefined();
    expect(JSON.parse(refused.content).error).toMatch(/Only the document's owner/);
  });
});
