// Context compaction: token-triggered policy, deterministic text fallback,
// Snapcompact PNG frames, and the chat-engine hook.
//
// The policy is the oh-my-pi one — trigger strictly above
// floor(C * thresholdPercent / 100) — and the routing rule is fail-closed:
// only models that positively claim vision get image blocks; glm-5.3 is the
// text-only proof.

import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  clampThresholdPercent,
  contextTokensFromUsage,
  FOCUS_MODEL_WINDOWS,
  focusTriggerTable,
  resolveThresholdTokens,
  shouldCompact,
  triggerTokensForModel,
  type CompactTurn,
} from "../../../../lib/compaction/policy";
import {
  ARCHIVE_FRAME_CHARS,
  MAX_ARCHIVE_FRAMES,
  compressArchiveTurns,
  framesForArchive,
  paginateArchive,
  serializeTurnsForArchive,
} from "../../../../lib/compaction/snapcompact";
import { summarizeToText } from "../../../../lib/compaction/textFallback";
import { compactIfNeeded } from "../../../../lib/compaction";
import {
  compactConversationIfNeeded,
  estimateConversationTokens,
} from "../contextBuilders";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `count` turns alternating user/assistant, each ~`size` characters. */
function sizedTurns(size: number, count = 6): CompactTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `turn ${index}: ${"x".repeat(size)}`,
  }));
}

/** Walk PNG chunks; asserts structure, returns dimensions and raw scanlines. */
function readPng(image: Buffer): { width: number; height: number; raw: Buffer } {
  expect(image.subarray(0, 8)).toEqual(PNG_MAGIC);
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  const idat: Buffer[] = [];
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString("ascii", offset + 4, offset + 8);
    const data = image.subarray(offset + 8, offset + 8 + length);
    expect(offset + 12 + length).toBeLessThanOrEqual(image.length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(0); // grayscale
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      expect(length).toBe(0);
      sawEnd = true;
    }
    offset += 12 + length;
  }
  expect(sawEnd).toBe(true);
  expect(offset).toBe(image.length);
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe(height * (width + 1));
  return { width, height, raw };
}

describe("compaction policy", () => {
  it("resolves the per-model trigger from the focus table", () => {
    expect(triggerTokensForModel("deepseek-v4.1-flash")).toBe(800_000);
    expect(triggerTokensForModel("glm-5.3")).toBe(800_000);
    expect(triggerTokensForModel("glm-5.3-flash")).toBe(800_000);
    expect(triggerTokensForModel("minimax-m3")).toBe(800_000);
    expect(triggerTokensForModel("muse-spark-1.3-contributor")).toBe(838_860);
    expect(triggerTokensForModel("kimi-k3")).toBe(838_860);
    // Router prefixes resolve to the same model.
    expect(triggerTokensForModel("opencode-go/kimi-k3")).toBe(838_860);
    expect(triggerTokensForModel("openrouter/deepseek-v4.1-flash")).toBe(800_000);
    // Unknown models have no trigger and fail closed.
    expect(triggerTokensForModel("space-bunny")).toBeUndefined();
    expect(triggerTokensForModel("glm-5.2")).toBeUndefined();
    expect(FOCUS_MODEL_WINDOWS["kimi-k3"]).toBe(1_048_576);
    expect(Object.keys(focusTriggerTable())).toHaveLength(6);
    expect(triggerTokensForModel("kimi-k3", 75)).toBe(
      Math.floor((1_048_576 * 75) / 100),
    );
  });

  it("triggers strictly above the threshold, not at it", () => {
    expect(shouldCompact(800_000, 1_000_000)).toBe(false);
    expect(shouldCompact(800_001, 1_000_000)).toBe(true);
    expect(shouldCompact(838_860, 1_048_576)).toBe(false);
    expect(shouldCompact(838_861, 1_048_576)).toBe(true);
    // A 75% configuration moves the trigger, and equality is still not a hit.
    expect(resolveThresholdTokens(1_000_000, 75)).toBe(750_000);
    expect(shouldCompact(750_000, 1_000_000, 75)).toBe(false);
    expect(shouldCompact(750_001, 1_000_000, 75)).toBe(true);
    // Unknown/empty windows never trigger.
    expect(shouldCompact(2_000_000, 0)).toBe(false);
    expect(shouldCompact(Number.NaN, 1_000_000)).toBe(false);
  });

  it("clamps the configured percent to 75-80 and the trigger into the window", () => {
    expect(clampThresholdPercent(undefined)).toBe(80);
    expect(clampThresholdPercent(50)).toBe(75);
    expect(clampThresholdPercent(95)).toBe(80);
    expect(clampThresholdPercent(78)).toBe(78);
    // floor(C * pct / 100) stays inside [1, C-1].
    expect(resolveThresholdTokens(1_000_000, 100)).toBe(999_999);
    expect(resolveThresholdTokens(2, 50)).toBe(1);
    expect(resolveThresholdTokens(0)).toBe(1);
  });

  it("derives context tokens from usage, subtracting orchestration tokens", () => {
    expect(
      contextTokensFromUsage({
        inputTokens: 800_000,
        outputTokens: 12_000,
        orchestrationTokens: 5_000,
      }),
    ).toBe(807_000);
    expect(
      contextTokensFromUsage({ totalTokens: 1_000, orchestration_tokens: 250 }),
    ).toBe(750);
    expect(contextTokensFromUsage({ input_tokens: 100 })).toBe(100);
    expect(contextTokensFromUsage({ contextTokens: 40_000 })).toBe(40_000);
    expect(
      contextTokensFromUsage({ contextTokens: 100, orchestrationTokens: 500 }),
    ).toBe(0);
    expect(contextTokensFromUsage(null)).toBe(0);
  });
});

describe("text fallback summary", () => {
  const turns: CompactTurn[] = [
    { role: "user", text: "Review doc-3 and summarize the indemnity clause." },
    { role: "assistant", text: "x".repeat(4_000) },
    {
      role: "user",
      text: "Also check doc-7 limits.\nSecond line stays out of the digest.",
    },
    {
      role: "tool",
      text: "read_document failed: timeout after 30s (retried successfully)",
    },
    { role: "assistant", text: "y".repeat(4_000) },
    { role: "user", text: "Draft the changes." },
  ];

  it("keeps anchors and the newest turns under budget", () => {
    const summary = summarizeToText(turns, 400);
    expect(summary).toMatch(
      /^\[Context compacted: \d+ older turns summarized, \d+ recent turns verbatim\]/,
    );
    // Original request verbatim.
    expect(summary).toContain("Review doc-3 and summarize the indemnity clause.");
    // First lines of later user requests, but not their full text.
    expect(summary).toContain("Also check doc-7 limits.");
    expect(summary).not.toContain("Second line stays out of the digest.");
    // Error/recovery notes and active document handles.
    expect(summary).toContain("read_document failed: timeout after 30s");
    expect(summary).toContain("ACTIVE DOCUMENTS\ndoc-3, doc-7");
    // The newest turn survives verbatim.
    expect(summary).toContain("Draft the changes.");
    // Whole summary respects the token budget (~4 chars/token).
    expect(Math.ceil(summary.length / 4)).toBeLessThanOrEqual(400);
  });

  it("is deterministic for the same input", () => {
    expect(summarizeToText(turns, 400)).toBe(summarizeToText(turns, 400));
  });
});

describe("snapcompact", () => {
  it("paginates at line boundaries without losing characters", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `line ${index} ${"z".repeat(index)}`,
    ).join("\n");
    const pages = paginateArchive(text, 100);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 100)).toBe(true);
    expect(pages.join("")).toBe(text);
    expect(paginateArchive("short", 6000)).toEqual(["short"]);
    expect(paginateArchive("")).toEqual([]);
  });

  it("emits valid PNG frames whose fallbackText round-trips the source", () => {
    const archive = serializeTurnsForArchive([
      { role: "user", text: "Please review doc-3." },
      { role: "tool", text: "Error: read failed once, recovered." },
      { role: "assistant", text: "The clause caps liability at fees paid." },
    ]);
    const frames = framesForArchive(archive);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(MAX_ARCHIVE_FRAMES);
    expect(frames.map((frame) => frame.fallbackText).join("")).toBe(archive);
    for (const frame of frames) {
      expect(frame.mimeType).toBe("image/png");
      const { width } = readPng(frame.image);
      expect(width).toBe(2 * 8 + 80 * 8); // padding + 80 monospace cells
    }
  });

  it("keeps every character when the archive exceeds the frame bound", () => {
    const huge = "q".repeat(ARCHIVE_FRAME_CHARS * 10);
    const frames = framesForArchive(huge);
    expect(frames).toHaveLength(MAX_ARCHIVE_FRAMES);
    expect(frames.map((frame) => frame.fallbackText).join("")).toBe(huge);
    for (const frame of frames) readPng(frame.image);
  });

  it("drops oldest non-anchor turns first under frame pressure", () => {
    const verbose: CompactTurn[] = [
      { role: "user", text: "first request" },
      { role: "assistant", text: "a".repeat(ARCHIVE_FRAME_CHARS * 2) },
      { role: "assistant", text: "b".repeat(ARCHIVE_FRAME_CHARS * 2) },
      { role: "tool", text: "Error: write failed" },
    ];
    const compressed = compressArchiveTurns(verbose, 2);
    expect(compressed.map((turn) => turn.role)).toEqual(["user", "tool"]);
    expect(compressed.some((turn) => turn.role === "user")).toBe(true);
    expect(compressed.some((turn) => /failed/i.test(turn.text))).toBe(true);
  });
});

// The five vision focus models and the text-only proof from the station spec.
const VISION_ROUTE_MODELS = [
  "deepseek-v4.1-flash",
  "muse-spark-1.3-contributor",
  "glm-5.3-flash",
  "minimax-m3",
  "kimi-k3",
] as const;

describe("compactIfNeeded", () => {
  it("leaves history untouched below the trigger", () => {
    const turns = sizedTurns(1_000, 2);
    const result = compactIfNeeded({
      turns,
      contextTokens: 100_000,
      modelId: "deepseek-v4.1-flash",
    });
    expect(result.compacted).toBe(false);
    expect(result.keptTurns).toEqual(turns);
    expect(result.summaryText).toBeUndefined();
    expect(result.archivedFrames).toBeUndefined();
  });

  it("fails closed for models without a known context window", () => {
    const result = compactIfNeeded({
      turns: sizedTurns(20_000, 6),
      contextTokens: 2_000_000,
      modelId: "space-bunny",
    });
    expect(result.compacted).toBe(false);
  });

  it("routes every vision focus model to PNG frames plus the text summary", () => {
    const turns = sizedTurns(20_000, 6);
    for (const modelId of VISION_ROUTE_MODELS) {
      const result = compactIfNeeded({
        turns,
        contextTokens: 850_000,
        modelId,
      });
      expect(result.compacted, modelId).toBe(true);
      expect(result.summaryText, modelId).toContain("[Context compacted:");
      expect(result.keptTurns.length, modelId).toBeGreaterThan(0);
      expect(result.keptTurns.length, modelId).toBeLessThan(turns.length);
      expect(result.archivedFrames?.length, modelId).toBeGreaterThan(0);
      for (const frame of result.archivedFrames ?? []) {
        expect(frame.mimeType).toBe("image/png");
        expect(frame.image.subarray(0, 4).toString("hex")).toBe("89504e47");
        expect(frame.fallbackText.length).toBeGreaterThan(0);
      }
    }
  });

  it("routes glm-5.3 and unknown ids to text only, never image blocks", () => {
    const turns = sizedTurns(20_000, 6);
    const textOnly = compactIfNeeded({
      turns,
      contextTokens: 850_000,
      modelId: "glm-5.3",
    });
    expect(textOnly.compacted).toBe(true);
    expect(textOnly.summaryText).toContain("[Context compacted:");
    expect(textOnly.archivedFrames).toBeUndefined();
    expect(textOnly.keptTurns.length).toBeLessThan(6);

    // An explicit window lets an unknown model compact, but the vision gate
    // is independent: it still gets text only.
    const unknown = compactIfNeeded({
      turns,
      contextTokens: 850_000,
      modelId: "space-bunny",
      contextWindow: 1_000_000,
    });
    expect(unknown.compacted).toBe(true);
    expect(unknown.archivedFrames).toBeUndefined();
  });
});

describe("compactConversationIfNeeded hook", () => {
  it("estimates stored-conversation tokens at ~4 chars/token", () => {
    expect(
      estimateConversationTokens([{ role: "user", content: "x".repeat(400) }]),
    ).toBe(100);
    expect(estimateConversationTokens([{ role: "assistant", content: null }])).toBe(0);
  });

  it("maps messages and no-ops below the trigger", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: null },
    ];
    const result = compactConversationIfNeeded({
      messages,
      contextTokens: 1_000,
      modelId: "glm-5.3",
    });
    expect(result.compacted).toBe(false);
    expect(result.keptTurns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "" },
    ]);
  });
});
