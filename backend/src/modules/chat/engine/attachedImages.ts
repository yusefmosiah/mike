// Images attached to a message go into that message, as image parts, sized
// for the turn's model (goals/mission-15-vision.md). They are not document
// handles: the model sees them without calling a tool.

import { documentSuffix } from "../../../lib/documentTypes";
import { imageForModel, isImageFileType, type ModelImage } from "../../../lib/images";
import {
  imageSizingFor,
  modelSeesImages,
  type ImageSizing,
  type LlmImagePart,
  type LlmTextPart,
} from "../../../lib/llm";
import { downloadFile } from "../../../lib/storage";
import { spotlightFilename } from "./contextBuilders";
import type { ChatMessage, DocIndex, DocStore } from "./types";

type Attachment = NonNullable<ChatMessage["files"]>[number];

const isImageAttachment = (file: Attachment) =>
  isImageFileType(documentSuffix(file.filename));

export const MODEL_CANNOT_SEE_IMAGES =
  "The selected model cannot see images. Choose a model that can, or remove the image.";

/**
 * Refuses a turn whose newest message attaches an image when the model cannot
 * see. Older images in the history do not refuse a turn: a text-only model
 * gets a placeholder for those (see attachImages).
 */
export async function refuseImagesForTextModel(
  messages: readonly ChatMessage[],
  model: string,
): Promise<{ ok: false; status: 400; code: "model_cannot_see_images"; detail: string } | null> {
  const latest = [...messages].reverse().find((m) => m.role === "user");
  if (!latest?.files?.some(isImageAttachment)) return null;
  if (await modelSeesImages(model)) return null;
  return { ok: false, status: 400, code: "model_cannot_see_images", detail: MODEL_CANNOT_SEE_IMAGES };
}

/** Resized images, by stored file and sizing; a thread resends its images every turn. */
const resized = new Map<string, Promise<ModelImage>>();
const RESIZED_LIMIT = 64;

function resizedImage(storagePath: string, sizing: ImageSizing): Promise<ModelImage> {
  const key = `${storagePath}\n${sizing.grid}:${sizing.maxLongEdge}:${sizing.maxPixels}`;
  let image = resized.get(key);
  if (!image) {
    image = (async () => {
      const bytes = await downloadFile(storagePath);
      if (!bytes) throw new Error("attached image missing from storage");
      return imageForModel(new Uint8Array(bytes), sizing);
    })();
    image.catch(() => resized.delete(key));
    resized.set(key, image);
    if (resized.size > RESIZED_LIMIT) resized.delete(resized.keys().next().value!);
  }
  return image;
}

/**
 * Puts each user message's image attachments into the message sent to the
 * model. `apiMessages` is buildMessages' output for `messages`: a system
 * message, then one entry per message in order. Images come before the text,
 * where most vision models expect them. A model that cannot see gets each
 * image's fallback text instead, so earlier images never break a thread that
 * moved to a text-only model; the stored image is untouched.
 */
export async function attachImages(args: {
  apiMessages: { role: string; content: unknown }[];
  messages: readonly ChatMessage[];
  docIndex: DocIndex;
  docStore: DocStore;
  model: string;
  nonce?: string;
}): Promise<void> {
  const { apiMessages, messages, docIndex, docStore, model, nonce } = args;
  if (!messages.some((m) => m.role === "user" && m.files?.some(isImageAttachment))) return;
  const sees = await modelSeesImages(model);
  const sizing = imageSizingFor(model);
  const slugByDocumentId = new Map(
    Object.entries(docIndex).map(([slug, info]) => [info.document_id, slug]),
  );

  await Promise.all(
    messages.map(async (message, index) => {
      if (message.role !== "user") return;
      const target = apiMessages[index + 1];
      if (!target || typeof target.content !== "string") return;
      const images: LlmImagePart[] = [];
      for (const file of message.files ?? []) {
        if (!isImageAttachment(file) || !file.document_id) continue;
        const slug = slugByDocumentId.get(file.document_id);
        const stored = slug ? docStore.get(slug) : undefined;
        // Only documents this conversation may read reach docStore.
        if (!stored || !isImageFileType(stored.file_type)) continue;
        const name = spotlightFilename(file.filename, nonce);
        const unseen = `[Image ${name}: the model answering cannot see images.]`;
        if (!sees) {
          images.push({ type: "image", image: "", fallbackText: unseen });
          continue;
        }
        try {
          const image = await resizedImage(stored.storage_path, sizing);
          images.push({
            type: "image",
            image: image.bytes,
            mimeType: image.mimeType,
            fallbackText: unseen,
          });
        } catch {
          images.push({ type: "image", image: "", fallbackText: `[Image ${name} could not be loaded.]` });
        }
      }
      if (!images.length) return;
      const text: LlmTextPart = { type: "text", text: target.content };
      target.content = [...images, text];
    }),
  );
}
