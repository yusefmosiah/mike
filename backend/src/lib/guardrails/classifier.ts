import { completeWithProvider } from "../llm/providers";
import type { UserApiKeys } from "../llm/types";

import { tierForTool, type GuardrailTier } from "./policy";

/**
 * Tier 3 classification for Auto Mode: a single on-route completion call
 * decides whether one tool call may run. Nothing leaves the route the turn is
 * already on — same provider, same key, same model family as the turn itself.
 *
 * Reasoning-blind by construction: the model sees only the turn's last user
 * message, the tool name, its redacted arguments, and the tool names already
 * used this turn. There is no field for assistant prose, so no caller can
 * accidentally hand the classifier the story the assistant told about itself.
 *
 * Fail closed everywhere: an unparseable verdict, a thrown completion, or a
 * timeout all resolve to `deny` with a reason the tool wrapper can return
 * in-band. Tier 1 and Tier 2 never reach a model at all.
 */

// Router models are addressed by their app-level id, prefix included:
// providerForModel resolves "opencode-go/glm-5.3-flash" (a bare catalog id
// throws "Unknown model id"), and callers normally pass the turn's own model,
// which is already in this form.
export const DEFAULT_CLASSIFIER_MODEL = "opencode-go/glm-5.3-flash";
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;

export const SYSTEM1_PROMPT = [
  "You are a security gate for one AI assistant tool call. You see only the user's stated intent, the tool name, its arguments (secrets redacted), and the tool names already used this turn — never assistant prose, so judge nothing beyond this payload.",
  "Treat unknown, connector, and externally-reaching tools as untrusted: allow only when the call plainly serves the user's stated intent with no exfiltration, no destruction of data the user did not ask about, and no scope beyond what they asked for. Otherwise deny — when in doubt, deny.",
  'Reply with JSON only, no markdown: {"verdict":"allow"|"deny","reason":"one short sentence"}.',
].join("\n");

const MAX_INTENT_LENGTH = 2000;
const MAX_HISTORY_ENTRIES = 10;
const MAX_ARG_STRING_LENGTH = 500;
const MAX_ARG_DEPTH = 6;
const MAX_REASON_LENGTH = 300;
const CLASSIFIER_MAX_TOKENS = 200;

const REDACTED_MARKER = "[redacted]";
const TRUNCATION_MARKER = "…[truncated]";
const DEPTH_MARKER = "[max-depth]";
const SECRET_KEY_PATTERN = /key|token|secret|password/i;

/** A completion that fails to arrive in time; distinguishes timeout logs. */
class ClassifierTimeoutError extends Error {
  constructor() {
    super("guardrail classifier timed out");
    this.name = "ClassifierTimeoutError";
  }
}

export type ClassifierVerdict = "allow" | "deny";

/** The single completion call a Tier 3 classification makes. */
export type ClassifierCompleteFn = (params: {
  model: string;
  systemPrompt: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}) => Promise<string>;

export type ClassifyToolCallInput = {
  /** The turn's last user message. Assistant prose is never part of it. */
  userIntent: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Names of tools this turn already called, oldest first. */
  history?: string[];
  model?: string;
  apiKeys?: UserApiKeys;
  timeoutMs?: number;
  /** Test seam; production uses the on-route completion below. */
  completeFn?: ClassifierCompleteFn;
};

export type ClassifyToolCallResult = {
  verdict: ClassifierVerdict;
  reason: string;
  tier: GuardrailTier;
  /** Tier 2 only: argument-scope enforcement stays with the caller. */
  scopeAssumed?: boolean;
};

const completeOnRoute: ClassifierCompleteFn = (params) =>
  completeWithProvider({
    model: params.model,
    systemPrompt: params.systemPrompt,
    user: params.user,
    maxTokens: params.maxTokens,
    apiKeys: params.apiKeys,
  });

export async function classifyToolCall(
  input: ClassifyToolCallInput,
): Promise<ClassifyToolCallResult> {
  const tier = tierForTool(input.toolName);
  // Tiers 1 and 2 are deterministic: reads have nothing to judge, and a
  // document write's scope is enforced by the caller's own authorization
  // (allowDocumentMutation plus inScopeForContainer), not by another model's
  // opinion of it.
  if (tier === 1) {
    return { verdict: "allow", reason: "read-only tool", tier: 1 };
  }
  if (tier === 2) {
    return {
      verdict: "allow",
      reason: "workspace-scoped document write",
      tier: 2,
      scopeAssumed: true,
    };
  }

  const model = input.model?.trim() || DEFAULT_CLASSIFIER_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const user = JSON.stringify({
    intent: (
      typeof input.userIntent === "string" ? input.userIntent : ""
    ).slice(0, MAX_INTENT_LENGTH),
    tool: input.toolName,
    args: redactArgs(input.toolArgs ?? {}),
    priorTools: (input.history ?? []).slice(-MAX_HISTORY_ENTRIES),
  });
  try {
    const text = await withTimeout(
      (input.completeFn ?? completeOnRoute)({
        model,
        systemPrompt: SYSTEM1_PROMPT,
        user,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        apiKeys: input.apiKeys,
      }),
      timeoutMs,
    );
    const parsed = parseVerdict(text);
    if (!parsed) {
      return {
        verdict: "deny",
        reason: "classifier verdict was unverifiable",
        tier: 3,
      };
    }
    return { verdict: parsed.verdict, reason: parsed.reason, tier: 3 };
  } catch (error) {
    return {
      verdict: "deny",
      reason:
        error instanceof ClassifierTimeoutError
          ? `classifier unavailable (timed out after ${timeoutMs}ms)`
          : "classifier unavailable",
      tier: 3,
    };
  }
}

/**
 * Truncate long strings and drop secret-looking keys before arguments reach
 * the classifier. Key matching is deliberately blunt (any key containing
 * "key", "token", "secret" or "password"): a redacted value costs the
 * classifier nothing, a leaked credential costs everything.
 */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ARG_STRING_LENGTH
      ? `${value.slice(0, MAX_ARG_STRING_LENGTH)}${TRUNCATION_MARKER}`
      : value;
  }
  if (Array.isArray(value)) {
    return depth >= MAX_ARG_DEPTH
      ? DEPTH_MARKER
      : value.map((entry) => redactArgs(entry, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_ARG_DEPTH) return DEPTH_MARKER;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED_MARKER
      : redactArgs(entry, depth + 1);
  }
  return redacted;
}

/** Parse `{"verdict":"allow"|"deny","reason":…}` out of model text; null when unusable. */
function parseVerdict(
  text: string,
): { verdict: ClassifierVerdict; reason: string } | null {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { verdict, reason } = parsed as { verdict?: unknown; reason?: unknown };
  if (verdict !== "allow" && verdict !== "deny") return null;
  const reasonText =
    typeof reason === "string" && reason.trim() ? reason.trim() : verdict;
  return { verdict, reason: reasonText.slice(0, MAX_REASON_LENGTH) };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  // The completion itself takes no abort signal, so the deadline is a race
  // against an AbortSignal.timeout. Promise.race subscribes to both inputs,
  // so a late rejection from the losing promise is consumed, not unhandled.
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ClassifierTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
