import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  cleanImage,
  ImageRejectedError,
  imageForModel,
  sizeForModel,
  sniffImageFormat,
  STORED_IMAGE_LONG_EDGE,
} from "../images";
import { imageSizingFor } from "../llm/models";

const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: { r: 200, g: 30, b: 30, alpha: 0 } } });

/** A PNG whose header claims `width` x `height` with almost no pixel data. */
function pngHeaderClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("cleanImage", () => {
  it("turns a photo upright and strips its metadata, GPS included", async () => {
    const photo = await solid(40, 20)
      .withExif({
        IFD0: { Copyright: "Client office" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
      })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const before = await sharp(photo).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();
    expect(photo.includes(Buffer.from("Client office"))).toBe(true);

    const cleaned = await cleanImage(photo, "jpg");
    const after = await sharp(cleaned.bytes).metadata();

    expect([cleaned.width, cleaned.height]).toEqual([20, 40]);
    expect(after.format).toBe("jpeg");
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(cleaned.bytes.includes(Buffer.from("Client office"))).toBe(false);
  });

  it("stores a large image at most 3072 px on its long edge", async () => {
    const big = await solid(6000, 3000).png().toBuffer();
    const cleaned = await cleanImage(big, "png");
    expect([cleaned.width, cleaned.height]).toEqual([STORED_IMAGE_LONG_EDGE, 1536]);
  });

  it("flattens transparency onto white", async () => {
    const clear = await solid(4, 4, 4).png().toBuffer();
    const cleaned = await cleanImage(clear, "png");
    const { data, info } = await sharp(cleaned.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it("keeps the first frame of an animation", async () => {
    const frames = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#00ff00" },
    })
      .gif()
      .toBuffer();
    const cleaned = await cleanImage(frames, "gif");
    expect((await sharp(cleaned.bytes).metadata()).pages ?? 1).toBe(1);
  });

  it("writes the format the extension names", async () => {
    const png = await solid(10, 10).png().toBuffer();
    const cleaned = await cleanImage(png, "jpeg");
    expect(cleaned.format).toBe("jpeg");
    expect(sniffImageFormat(cleaned.bytes)).toBe("jpeg");
  });

  it("refuses an SVG renamed to .png", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(cleanImage(svg, "png")).rejects.toMatchObject({ code: "unsupported_image" });
  });

  it("refuses a type that is not an image", async () => {
    await expect(cleanImage(Buffer.from("%PDF-1.7"), "pdf")).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it("refuses a header that claims more pixels than it may open", async () => {
    await expect(cleanImage(pngHeaderClaiming(20_000, 20_000), "png")).rejects.toMatchObject({
      code: "image_too_large",
    });
  });

  it("refuses more than 20 MB", async () => {
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(cleanImage(huge, "png")).rejects.toMatchObject({ code: "image_too_large" });
  });
});

describe("sniffImageFormat", () => {
  it("names the four formats by their bytes and nothing else", () => {
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageFormat(Buffer.from("GIF89a....."))).toBe("gif");
    expect(sniffImageFormat(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImageFormat(Buffer.from("<svg"))).toBeNull();
    expect(sniffImageFormat(Buffer.from("%PDF"))).toBeNull();
  });
});

describe("sizing for a model", () => {
  it("shrinks to the model family's budget, snapped to its grid", () => {
    const qwen = imageSizingFor("phala/qwen3.8-27b-uncensored");
    const size = sizeForModel(3072, 2304, qwen);
    expect(size.width % 32).toBe(0);
    expect(size.height % 32).toBe(0);
    expect(size.width * size.height).toBeLessThanOrEqual(qwen.maxPixels);

    const gemma = sizeForModel(3072, 2304, imageSizingFor("phala/gemma-4-26b-a4b-uncensored"));
    expect(gemma.width % 48).toBe(0);
    expect(gemma.height % 48).toBe(0);

    const claude = sizeForModel(3072, 2304, imageSizingFor("claude-opus-5"));
    expect(Math.max(claude.width, claude.height)).toBeLessThanOrEqual(1568);
    expect(claude.width % 28).toBe(0);
  });

  it("never enlarges a small image", () => {
    expect(sizeForModel(300, 200, imageSizingFor("claude-opus-5"))).toEqual({ width: 300, height: 200 });
  });

  it("sends photos as JPEG and other images as PNG, at the model's size", async () => {
    const photo = await solid(3072, 2304).jpeg().toBuffer();
    const forQwen = await imageForModel(photo, imageSizingFor("phala/qwen3.8-27b-uncensored"));
    expect(forQwen.mimeType).toBe("image/jpeg");
    const meta = await sharp(forQwen.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([forQwen.width, forQwen.height]);
    expect(forQwen.width % 32).toBe(0);

    const screenshot = await solid(1000, 800).png().toBuffer();
    expect((await imageForModel(screenshot, imageSizingFor("claude-opus-5"))).mimeType).toBe("image/png");
  });
});
