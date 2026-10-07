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
  RECOVERY_BAND,
  resolveThresholdTokens,
  shouldCompact,
  splitRecentTurns,
  type CompactTurn,
} from "./policy";
import {
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
};

/**
 * Compact when (and only when) the context exceeds the model's token trigger
 * and the result is a real reduction. Vision models get Snapcompact PNG
 * frames plus the text summary; every other model gets text only — image
 * blocks are never routed to a model that did not positively claim vision.
 */
export function compactIfNeeded(args: CompactIfNeededArgs): CompactResult {
  const turns = [...args.turns];
  const window = args.contextWindow ?? contextWindowForModel(args.modelId);
  const thresholdPct = clampThresholdPercent(args.thresholdPct);
  const reported =
    typeof args.contextTokens === "number" && Number.isFinite(args.contextTokens)
      ? args.contextTokens
      : 0;
  // Provider-reported usage is floored by the stored-conversation estimate:
  // a missing or under-reported usage field must not hide a full context.
  const beforeTokens = Math.max(reported, estimateTurnsTokens(turns));
  if (
    window === undefined ||
    window <= 0 ||
    !shouldCompact(beforeTokens, window, thresholdPct)
  ) {
    return { compacted: false, keptTurns: turns };
  }

  const { kept, older } = splitRecentTurns(turns, KEEP_RECENT_TOKENS);
  if (older.length === 0) return { compacted: false, keptTurns: turns };

  const summaryText = summarizeToText(turns, MAX_SUMMARY_TOKENS);
  const threshold = resolveThresholdTokens(window, thresholdPct);
  const projected = estimateTurnsTokens(kept) + estimateTokens(summaryText);
  // Reject no-ops. The recovery band is the point of compacting at all: a
  // result that lands back at >=80% of the trigger would re-trigger next turn.
  if (
    projected >= beforeTokens ||
    projected > Math.floor(threshold * RECOVERY_BAND)
  ) {
    return { compacted: false, keptTurns: turns };
  }

  let archivedFrames: ArchiveFrame[] | undefined;
  if (modelSupportsVision(args.modelId)) {
    // Frame-pressure compression drops oldest non-anchor turns first; user
    // requests and error/recovery turns always survive into the archive.
    const archive = serializeTurnsForArchive(compressArchiveTurns(older));
    const frames = framesForArchive(archive);
    if (frames.length > 0) archivedFrames = frames;
  }

  return { compacted: true, archivedFrames, summaryText, keptTurns: kept };
}
