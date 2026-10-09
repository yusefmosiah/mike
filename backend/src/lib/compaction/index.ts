// Compaction entry point. The policy is token-triggered and the result is
// always "replace the older turns with this summary, keep this tail": the
// caller mutates its history only when `compacted` is true, so an untouched
// prefix keeps its KV-cache hash the rest of the time.

import { modelSupportsVision } from "../llm/models";
import {
  clampThresholdPercent,
  contextWindowForModel,
  estimateTokens,
  estimateTurnsTokens,
  KEEP_RECENT_TOKENS,
  MAX_SUMMARY_TOKENS,
  MEDIA_TOKENS,
  RECOVERY_BAND,
  resolveThresholdTokens,
  shouldCompact,
  splitRecentTurns,
  type CompactTurn,
} from "./policy";
import {
  ARCHIVE_FRAME_CHARS,
  MAX_ARCHIVE_FRAMES,
  compressArchiveTurns,
  framesForArchive,
  serializeTurnsForArchive,
  type ArchiveFrame,
} from "./snapcompact";
import { summarizeToText } from "./textFallback";

export type { ArchiveFrame } from "./snapcompact";
export type { CompactTurn } from "./policy";

export type CompactResult = {
  /** False on a no-op: the caller keeps its history exactly as it was. */
  compacted: boolean;
  /** PNG frames carrying the dropped turns; vision models only. */
  archivedFrames?: ArchiveFrame[];
  /** Deterministic text summary of the dropped turns. */
  summaryText?: string;
  /** Turns to keep verbatim. Unchanged history whenever `compacted` is false. */
  keptTurns: CompactTurn[];
};

export type CompactIfNeededArgs = {
  /** Conversation in send order; older turns may be dropped by compaction. */
  turns: readonly CompactTurn[];
  /** Provider-reported context tokens (see `contextTokensFromUsage`). */
  contextTokens?: number | null;
  modelId: string;
  /** Configured threshold percent; clamped to the supported 75-80 band. */
  thresholdPct?: number;
  /** Explicit window for models outside the focus table. */
  contextWindow?: number;
  /** System/tool overhead outside the serialized conversation. */
  reservedTokens?: number;
  /** Active request and pending tool units that must remain verbatim. */
  protectedTurnIndices?: readonly number[];
};

/**
 * Compact when (and only when) the context exceeds the model's token trigger
 * and the result is a real reduction. Vision models get bounded, ASCII-safe
 * Snapcompact PNG frames plus the text summary. Other archives use text only;
 * images are never routed to a model that did not positively claim vision.
 */
export function compactIfNeeded(args: CompactIfNeededArgs): CompactResult {
  const turns = [...args.turns];
  const window = args.contextWindow ?? contextWindowForModel(args.modelId);
  const thresholdPct = clampThresholdPercent(args.thresholdPct);
  const reserved = Number.isFinite(args.reservedTokens)
    ? Math.max(0, args.reservedTokens ?? 0)
    : 0;
  const reported =
    typeof args.contextTokens === "number" && Number.isFinite(args.contextTokens)
      ? args.contextTokens
      : 0;
  // Provider-reported usage is floored by the stored-conversation estimate:
  // a missing or under-reported usage field must not hide a full context.
  const beforeTokens = Math.max(reported, reserved + estimateTurnsTokens(turns));
  if (
    window === undefined ||
    window <= 0 ||
    !shouldCompact(beforeTokens, window, thresholdPct)
  ) {
    return { compacted: false, keptTurns: turns };
  }

  const tailStart = turns.length - splitRecentTurns(turns, KEEP_RECENT_TOKENS).kept.length;
  const protectedIndices = args.protectedTurnIndices
    ? new Set(args.protectedTurnIndices)
    : undefined;
  const kept: CompactTurn[] = [];
  const older: CompactTurn[] = [];
  for (let index = 0; index < turns.length; index++) {
    (index >= tailStart || protectedIndices?.has(index) ? kept : older).push(turns[index]);
  }
  if (older.length === 0) return { compacted: false, keptTurns: turns };

  const threshold = resolveThresholdTokens(window, thresholdPct);
  const ceiling = Math.floor(threshold * RECOVERY_BAND);
  const retainedTokens = reserved + estimateTurnsTokens(kept);
  // Reserve the summary message envelope, then size only the discarded
  // history to the actual headroom. Retained content is never summarized twice.
  const available = ceiling - retainedTokens - 8;
  if (available <= 0) return { compacted: false, keptTurns: turns };

  let archivedFrames: ArchiveFrame[] | undefined;
  if (
    modelSupportsVision(args.modelId) &&
    available >= MAX_SUMMARY_TOKENS + MAX_ARCHIVE_FRAMES * MEDIA_TOKENS
  ) {
    // Frame-pressure compression drops oldest non-anchor turns first; user
    // requests and error/recovery turns always survive into the archive.
    const archive = serializeTurnsForArchive(compressArchiveTurns(older));
    // The bitmap font is ASCII-only. Never substitute glyphs in legal text,
    // or render an unbounded anchor into one enormous final image.
    if (
      archive.length <= ARCHIVE_FRAME_CHARS * MAX_ARCHIVE_FRAMES &&
      /^[\x09\x0a\x0d\x20-\x7e]*$/.test(archive)
    ) {
      const frames = framesForArchive(archive);
      if (frames.length > 0) archivedFrames = frames;
    }
  }

  const frameTokens = (archivedFrames?.length ?? 0) * MEDIA_TOKENS;
  const summaryText = summarizeToText(older, Math.min(MAX_SUMMARY_TOKENS, available - frameTokens));
  const projected = retainedTokens + 8 + estimateTokens(summaryText) + frameTokens;
  if (projected >= beforeTokens || projected > ceiling) {
    return { compacted: false, keptTurns: turns };
  }

  return { compacted: true, archivedFrames, summaryText, keptTurns: kept };
}
