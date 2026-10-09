// Token-triggered compaction policy (oh-my-pi shape): the trigger is a
// provider-reported context-token count, never a turn count.
//
//   shouldCompact = C > 0 && contextTokens > floor(C * thresholdPercent / 100)
//
// The comparison is strict `>`: sitting exactly at the threshold is not yet a
// trigger. The default threshold is 80% of the context window and callers may
// configure 75-80%; anything outside that band is clamped so a bad setting
// cannot compact far too early or wait until the provider rejects the prompt.

export const DEFAULT_THRESHOLD_PERCENT = 80;
export const MIN_THRESHOLD_PERCENT = 75;
export const MAX_THRESHOLD_PERCENT = 80;

/** Recent turns kept verbatim across a compaction. */
export const KEEP_RECENT_TOKENS = 20_000;

/** Ceiling for the deterministic text summary that replaces older turns. */
export const MAX_SUMMARY_TOKENS = 16_384;

/** Conservative allowance for one retained media part or archive frame. */
export const MEDIA_TOKENS = 4096;

/**
 * After compaction the context must sit below this fraction of the trigger.
 * A "recovery" that landed at, say, 95% of the trigger would immediately
 * re-trigger on the next turn.
 */
export const RECOVERY_BAND = 0.8;

/**
 * Context windows for the OpenCode Go focus models, by canonical id. Keys
 * mirror the provider catalog; router-prefixed ids are stripped before lookup
 * (see `contextWindowForModel`), so a saved `opencode-go/<id>` still matches.
 *
 * Keep in sync with OPENCODE_GO_CONTEXT_WINDOWS in lib/llm/models.ts — that
 * table is the provider-facing source; this one drives the compaction trigger.
 */
export const FOCUS_MODEL_WINDOWS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 1_000_000,
  "muse-spark-1.3-contributor": 1_048_576,
  "glm-5.3": 1_000_000,
  "glm-5.3-flash": 1_000_000,
  "minimax-m3": 1_000_000,
  "kimi-k3": 1_048_576,
};

// Router-prefixed ids (`opencode-go/glm-5.3`, `openrouter/...`) resolve to the
// same model as the canonical id, so the prefix is stripped before lookup.
const ROUTER_PREFIX_RE = /^(?:opencode-go|openrouter|vercel|ollama)\//;

/** Context window of a focus model, or undefined when the model is unknown. */
export function contextWindowForModel(
  modelId: string,
): number | undefined {
  return FOCUS_MODEL_WINDOWS[modelId.replace(ROUTER_PREFIX_RE, "")];
}

/**
 * `floor(C * pct / 100)`, clamped to `[1, C - 1]`: the trigger must be
 * reachable for a C-token window yet strictly inside it.
 */
export function resolveThresholdTokens(
  contextWindow: number,
  thresholdPct: number = DEFAULT_THRESHOLD_PERCENT,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 1;
  const raw = Math.floor((contextWindow * thresholdPct) / 100);
  const ceiling = Math.max(1, Math.floor(contextWindow) - 1);
  return Math.min(Math.max(raw, 1), ceiling);
}

/** Clamp a configured threshold into the supported 75-80 band. */
export function clampThresholdPercent(
  thresholdPct: number | null | undefined,
): number {
  if (typeof thresholdPct !== "number" || !Number.isFinite(thresholdPct)) {
    return DEFAULT_THRESHOLD_PERCENT;
  }
  return Math.min(
    MAX_THRESHOLD_PERCENT,
    Math.max(MIN_THRESHOLD_PERCENT, thresholdPct),
  );
}

/** Strict `>` against the per-window threshold; unknown windows never fire. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  thresholdPct: number = DEFAULT_THRESHOLD_PERCENT,
): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) {
    return false;
  }
  return contextTokens > resolveThresholdTokens(contextWindow, thresholdPct);
}

/** Trigger token count for a focus model, or undefined when unknown. */
export function triggerTokensForModel(
  modelId: string,
  thresholdPct: number = DEFAULT_THRESHOLD_PERCENT,
): number | undefined {
  const window = contextWindowForModel(modelId);
  return window === undefined
    ? undefined
    : resolveThresholdTokens(window, thresholdPct);
}

/** Per-model trigger table (canonical id -> token count) at `thresholdPct`. */
export function focusTriggerTable(
  thresholdPct: number = DEFAULT_THRESHOLD_PERCENT,
): Record<string, number> {
  const table: Record<string, number> = {};
  for (const [modelId, window] of Object.entries(FOCUS_MODEL_WINDOWS)) {
    table[modelId] = resolveThresholdTokens(window, thresholdPct);
  }
  return table;
}

// ---------------------------------------------------------------------------
// Usage and estimation
// ---------------------------------------------------------------------------

/**
 * Provider usage, AI-SDK camelCase and raw-payload snake_case both accepted.
 * `orchestrationTokens` is present only on routes that count tokens spent by
 * orchestration (title generation, internal fan-out) inside the same usage
 * envelope; those do not occupy the conversation's context window.
 */
export type ContextUsage = {
  inputTokens?: number | null;
  input_tokens?: number | null;
  outputTokens?: number | null;
  output_tokens?: number | null;
  totalTokens?: number | null;
  total_tokens?: number | null;
  promptTokens?: number | null;
  prompt_tokens?: number | null;
  completionTokens?: number | null;
  completion_tokens?: number | null;
  contextTokens?: number | null;
  context_tokens?: number | null;
  orchestrationTokens?: number | null;
  orchestration_tokens?: number | null;
  orchestratorTokens?: number | null;
};

function firstNumber(
  ...values: (number | null | undefined)[]
): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Context tokens a provider reported for the turn: prompt + completion
 * (cache reads included — they still occupy the window), minus orchestration
 * tokens when the route reports them. Never negative.
 */
export function contextTokensFromUsage(
  usage: ContextUsage | null | undefined,
): number {
  if (!usage) return 0;
  const input =
    firstNumber(
      usage.inputTokens,
      usage.input_tokens,
      usage.promptTokens,
      usage.prompt_tokens,
    ) ?? 0;
  const output =
    firstNumber(
      usage.outputTokens,
      usage.output_tokens,
      usage.completionTokens,
      usage.completion_tokens,
    ) ?? 0;
  const total =
    firstNumber(usage.contextTokens, usage.context_tokens) ??
    firstNumber(usage.totalTokens, usage.total_tokens) ??
    input + output;
  const orchestration =
    firstNumber(
      usage.orchestrationTokens,
      usage.orchestration_tokens,
      usage.orchestratorTokens,
    ) ?? 0;
  return Math.max(0, total - orchestration);
}

/** A role-tagged turn of the conversation, in send order. */
export type CompactTurn = {
  role: string;
  text: string;
  /** Conservative allowance for media, in addition to the text estimate. */
  additionalTokens?: number;
};

/** ~4 chars/token heuristic, rounded up so short text is never zero. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTurnTokens(turn: CompactTurn): number {
  const additional = Number.isFinite(turn.additionalTokens)
    ? Math.max(0, turn.additionalTokens ?? 0)
    : 0;
  return estimateTokens(turn.text) + additional;
}

export function estimateTurnsTokens(turns: readonly CompactTurn[]): number {
  return turns.reduce((total, turn) => total + estimateTurnTokens(turn), 0);
}

// Error/recovery turns are anchor material for both the archive (they survive
// frame-pressure drops) and the text summary, so both read the same predicate.
const ERROR_OR_RECOVERY_RE =
  /(?:\berrors?\b|\bfailed\b|\bfailure\b|\bexception\b|\brecover(?:y|ed|ing)\b|\btimed?\s+out\b|\bcrash(?:ed|es)?\b|\btruncated\b)/i;

export function looksLikeErrorOrRecovery(text: string): boolean {
  return ERROR_OR_RECOVERY_RE.test(text);
}

/**
 * Split history into the recent tail kept verbatim (`<= keepTokens` by the
 * 4-chars/token estimate) and the older turns a compaction summarizes. The
 * newest turn is always kept, even when it alone exceeds the budget.
 */
export function splitRecentTurns(
  turns: readonly CompactTurn[],
  keepTokens: number = KEEP_RECENT_TOKENS,
): { kept: CompactTurn[]; older: CompactTurn[] } {
  if (turns.length === 0) return { kept: [], older: [] };
  let used = 0;
  let splitAt = turns.length;
  for (let index = turns.length - 1; index >= 0; index--) {
    const cost = estimateTurnTokens(turns[index]);
    if (used + cost > keepTokens) break;
    used += cost;
    splitAt = index;
  }
  if (splitAt === turns.length) splitAt = turns.length - 1;
  return { kept: turns.slice(splitAt), older: turns.slice(0, splitAt) };
}
