import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { getChatWebPage } from "../chat.webPages";
import { getAccessibleChat } from "../chat.access";

vi.mock("../chat.access", () => ({ getAccessibleChat: vi.fn() }));

const SNAPSHOT = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
const args = { chatId: "chat-1", snapshotId: SNAPSHOT, userId: "u1", userEmail: "u1@test.local" };
const citing = [{ citations: [{ kind: "document", ref: 1 }, { kind: "web", ref: 2, snapshot_id: SNAPSHOT }] }];

describe("getChatWebPage", () => {
  beforeEach(() => {
    vi.mocked(getAccessibleChat).mockResolvedValue({ ok: true } as never);
  });

  it("serves a page one of the chat's web citations cites", async () => {
    const { db, calls } = scriptedDb([
      { table: "chat_messages", data: citing },
      {
        table: "citation_snapshots",
        data: {
          id: SNAPSHOT,
          url: "https://example.com/ruling",
          content: "The court held for the appellant.",
          reader_markdown: "# Ruling",
          retrieved_at: new Date("2026-10-12T09:00:00Z"),
        },
      },
    ]);

    const result = await getChatWebPage(db, args);

    expect(result).toEqual({
      ok: true,
      data: {
        id: SNAPSHOT,
        url: "https://example.com/ruling",
        text: "The court held for the appellant.",
        markdown: "# Ruling",
        retrieved_at: "2026-10-12T09:00:00.000Z",
      },
    });
    expect(calls[0].filters).toContainEqual(["eq", "chat_id", "chat-1"]);
    expect(calls[1].filters).toContainEqual(["eq", "source_kind", "web"]);
  });

  it("serves a search result saved without reader Markdown as Markdown", async () => {
    const markdown = "At [PegaWorld](https://www.pega.com/events) on June 8, *Pega* announced Infinity 26.";
    const { db } = scriptedDb([
      { table: "chat_messages", data: [{ citations: [{ kind: "web", snapshot_id: SNAPSHOT, snapshot_source: "search" }] }] },
      {
        table: "citation_snapshots",
        data: { id: SNAPSHOT, url: "https://epikonic.com/pega", content: markdown, reader_markdown: null, retrieved_at: new Date("2026-10-15T09:00:00Z") },
      },
    ]);
    expect(await getChatWebPage(db, args)).toMatchObject({ ok: true, data: { text: markdown, markdown } });
  });

  it("leaves a fetched page without reader Markdown as plain text", async () => {
    const { db } = scriptedDb([
      { table: "chat_messages", data: [{ citations: [{ kind: "web", snapshot_id: SNAPSHOT, snapshot_source: "fetch" }] }] },
      {
        table: "citation_snapshots",
        data: { id: SNAPSHOT, url: "https://example.com", content: "Plain *text*", reader_markdown: null, retrieved_at: new Date("2026-10-15T09:00:00Z") },
      },
    ]);
    expect(await getChatWebPage(db, args)).toMatchObject({ ok: true, data: { markdown: null } });
  });

  it("is not found for a page no message in this chat cites", async () => {
    const { db, calls } = scriptedDb([
      { table: "chat_messages", data: [{ citations: [{ kind: "web", snapshot_id: "another" }] }, { citations: null }] },
    ]);
    expect(await getChatWebPage(db, args)).toMatchObject({ ok: false, kind: "not_found", detail: "Page not found" });
    expect(calls.map((call) => call.table)).toEqual(["chat_messages"]);
  });

  it("is not found for a caller who cannot see the chat, without reading anything", async () => {
    vi.mocked(getAccessibleChat).mockResolvedValue({ ok: false } as never);
    const { db, calls } = scriptedDb([]);
    expect(await getChatWebPage(db, args)).toMatchObject({ ok: false, kind: "not_found", detail: "Chat not found" });
    expect(calls).toEqual([]);
  });

  it("is not found for an id that is not a snapshot id", async () => {
    const { db, calls } = scriptedDb([]);
    expect(await getChatWebPage(db, { ...args, snapshotId: "../etc" })).toMatchObject({ ok: false, kind: "not_found" });
    expect(calls).toEqual([]);
  });
});
