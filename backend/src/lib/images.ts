// Images a person attaches, cleaned once on the way in and sized per model on
// the way out (docs/reports/file-intake-2026-10-10.md, section 2).
//
// sharp decodes only JPEG, PNG, WebP and GIF: every other libvips loader
// (SVG through librsvg, TIFF, HEIF, PDF, the ImageMagick bridge) is blocked
// for the whole process, so a renamed file cannot reach a parser we did not
// choose. Cleaning applies the EXIF orientation, takes the first frame of an
// animation, flattens transparency onto white, converts to 8-bit sRGB and
// writes a fresh file, which carries no EXIF, XMP, IPTC or GPS.

import sharp from "sharp";
import { IMAGE_FORMAT_BY_FILE_TYPE } from "./documentTypes";
import type { ImageSizing } from "./llm/models";

export { isImageFileType } from "./documentTypes";

sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadNsgifBuffer",
  ],
});

export type ImageFormat = "jpeg" | "png" | "webp" | "gif";

/** The largest raw image accepted, before cleaning. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Decoding stops above this many pixels (a decompression bomb guard). */
export const MAX_IMAGE_PIXELS = 100_000_000;
/** The long edge of the stored, cleaned copy. */
export const STORED_IMAGE_LONG_EDGE = 3072;

export class ImageRejectedError extends Error {
  constructor(
    readonly code: "unsupported_image" | "image_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

/** The format named by an image's first bytes, whatever its extension says. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  const at = (offset: number, ascii: string) =>
    bytes.length >= offset + ascii.length &&
    [...ascii].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  return null;
}

function encode(pipeline: sharp.Sharp, format: ImageFormat): sharp.Sharp {
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4" });
    case "webp":
      return pipeline.webp({ quality: 90 });
    case "gif":
      return pipeline.gif();
    case "png":
      return pipeline.png();
  }
}

export type CleanImage = {
  bytes: Buffer;
  format: ImageFormat;
  width: number;
  height: number;
};

/**
 * The stored copy of an uploaded image. The bytes must be an image sharp is
 * allowed to decode; the result is written in the format the extension names,
 * so a PNG saved as `.jpg` is stored as a real JPEG and the two always agree.
 */
export async function cleanImage(
  bytes: Uint8Array,
  fileType: string,
): Promise<CleanImage> {
  const format = IMAGE_FORMAT_BY_FILE_TYPE[fileType.toLowerCase()];
  if (!format) {
    throw new ImageRejectedError("unsupported_image", "This file type is not an image Mike accepts.");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageRejectedError("image_too_large", "Images can be at most 20 MB.");
  }
  if (!sniffImageFormat(bytes)) {
    throw new ImageRejectedError("unsupported_image", "This file is not a JPEG, PNG, WebP or GIF image.");
  }
  try {
    const decoded = sharp(bytes, {
      autoOrient: true,
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
      pages: 1,
    })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize({
        width: STORED_IMAGE_LONG_EDGE,
        height: STORED_IMAGE_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const { data, info } = await encode(decoded, format).toBuffer({ resolveWithObject: true });
    return { bytes: data, format, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new ImageRejectedError("image_too_large", "This image has too many pixels to open safely.");
    }
    throw new ImageRejectedError("unsupported_image", "This image could not be read.");
  }
}

export type ModelImage = {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
};

/** The largest image part sent, so a request stays under every provider's cap. */
const MAX_MODEL_IMAGE_BYTES = 3_500_000;

/**
 * Dimensions that fit `sizing`, shrinking only. When it shrinks, both sides
 * are rounded down to the model's grid.
 */
export function sizeForModel(
  width: number,
  height: number,
  sizing: ImageSizing,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    sizing.maxLongEdge / Math.max(width, height),
    Math.sqrt(sizing.maxPixels / (width * height)),
  );
  if (scale >= 1) return { width, height };
  const snap = (side: number) =>
    Math.max(sizing.grid, Math.floor((side * scale) / sizing.grid) * sizing.grid);
  return { width: snap(width), height: snap(height) };
}

/**
 * A stored image resized for one model. Photos stay JPEG; everything else is
 * sent as PNG, which keeps text in screenshots and diagrams sharp. An image
 * that still comes out too heavy is re-encoded once as JPEG.
 */
export async function imageForModel(
  stored: Uint8Array,
  sizing: ImageSizing,
): Promise<ModelImage> {
  const input = sharp(stored, { limitInputPixels: MAX_IMAGE_PIXELS, pages: 1 });
  const meta = await input.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new ImageRejectedError("unsupported_image", "This image could not be read.");
  }
  const target = sizeForModel(width, height, sizing);
  const resized = input.resize({ width: target.width, height: target.height, fit: "fill" });
  const asJpeg = () =>
    resized.clone().jpeg({ quality: 88, chromaSubsampling: "4:4:4" }).toBuffer();
  let bytes = meta.format === "jpeg" ? await asJpeg() : await resized.clone().png().toBuffer();
  let mimeType = meta.format === "jpeg" ? "image/jpeg" : "image/png";
  if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES && mimeType === "image/png") {
    bytes = await asJpeg();
    mimeType = "image/jpeg";
  }
  return { bytes, mimeType, ...target };
}
