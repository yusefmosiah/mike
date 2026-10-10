/**
 * Images attached to a message reach the model inside that message, sized for
 * the turn's model; a model that cannot see refuses a new image and gets a
 * placeholder for older ones.
 */
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const sees = vi.hoisted(() => ({ value: true }));
const stored = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../../../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/llm")>()),
  modelSeesImages: vi.fn(async () => sees.value),
}));
vi.mock("../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/storage")>()),
  downloadFile: vi.fn(async (key: string) => {
    const bytes = stored.get(key);
    return bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
  }),
}));

import { attachImages, MODEL_CANNOT_SEE_IMAGES, refuseImagesForTextModel } from "../attachedImages";
import type { ChatMessage, DocIndex, DocStore } from "../types";

afterEach(() => {
  sees.value = true;
  stored.clear();
});

const photo = () =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#336699" } }).jpeg().toBuffer();

const docIndex: DocIndex = {
  "doc-1": { document_id: "d-photo", filename: "site.jpg" },
  "doc-2": { document_id: "d-lease", filename: "lease.pdf" },
};
const docStore: DocStore = new Map([
  ["doc-1", { storage_path: "store/site.jpg", file_type: "jpg", filename: "site.jpg" }],
  ["doc-2", { storage_path: "store/lease.pdf", file_type: "pdf", filename: "lease.pdf" }],
]);

const turn = (files: ChatMessage["files"]): ChatMessage[] => [
  { role: "user", content: "What is in this photo?", files },
];

describe("refuseImagesForTextModel", () => {
  it("refuses a new image for a model that cannot see", async () => {
    sees.value = false;
    expect(await refuseImagesForTextModel(turn([{ filename: "site.jpg", document_id: "d-photo" }]), "glm-5.3")).toEqual({
      ok: false,
      status: 400,
      code: "model_cannot_see_images",
      detail: MODEL_CANNOT_SEE_IMAGES,
    });
  });

  it("lets the turn through for a vision model, or with no image in the newest message", async () => {
    expect(await refuseImagesForTextModel(turn([{ filename: "site.jpg", document_id: "d-photo" }]), "claude-opus-5")).toBeNull();
    sees.value = false;
    const history: ChatMessage[] = [
      ...turn([{ filename: "site.jpg", document_id: "d-photo" }]),
      { role: "assistant", content: "A building." },
      { role: "user", content: "Thanks", files: [{ filename: "lease.pdf", document_id: "d-lease" }] },
    ];
    expect(await refuseImagesForTextModel(history, "glm-5.3")).toBeNull();
  });
});

describe("attachImages", () => {
  it("puts the image in the message, before the text, sized for the model", async () => {
    stored.set("store/site.jpg", await photo());
    const messages = turn([
      { filename: "site.jpg", document_id: "d-photo" },
      { filename: "lease.pdf", document_id: "d-lease" },
    ]);
    const apiMessages: { role: string; content: unknown }[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "What is in this photo?" },
    ];

    await attachImages({ apiMessages, messages, docIndex, docStore, model: "phala/qwen3.8-27b-uncensored" });

    const content = apiMessages[1]!.content as Array<Record<string, unknown>>;
    expect(content.map((part) => part.type)).toEqual(["image", "text"]);
    expect(content[1]).toEqual({ type: "text", text: "What is in this photo?" });
    expect(content[0]!.mimeType).toBe("image/jpeg");
    const meta = await sharp(content[0]!.image as Buffer).metadata();
    expect(meta.width! % 32).toBe(0);
    expect(meta.width! * meta.height!).toBeLessThanOrEqual(1280 * 32 * 32);
  });

  it("gives a text-only model a placeholder and leaves the stored image alone", async () => {
    sees.value = false;
    const apiMessages: { role: string; content: unknown }[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "Earlier photo" },
    ];
    await attachImages({
      apiMessages,
      messages: turn([{ filename: "site.jpg", document_id: "d-photo" }]),
      docIndex,
      docStore,
      model: "glm-5.3",
    });
    const [image] = apiMessages[1]!.content as Array<Record<string, unknown>>;
    expect(image).toMatchObject({ type: "image", image: "" });
    expect(String(image!.fallbackText)).toContain("cannot see images");
  });

  it("only attaches documents this conversation may read", async () => {
    const apiMessages: { role: string; content: unknown }[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "Look" },
    ];
    await attachImages({
      apiMessages,
      messages: turn([{ filename: "secret.png", document_id: "d-elsewhere" }]),
      docIndex,
      docStore,
      model: "claude-opus-5",
    });
    expect(apiMessages[1]!.content).toBe("Look");
  });
});
