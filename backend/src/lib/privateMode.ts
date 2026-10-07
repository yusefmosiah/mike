// Station 8 — strict private mode.
//
// STRICT_PRIVATE_MODE=true is the deployment-wide switch for segmented,
// on-prem installs: model traffic must stay on operator-declared lanes, and
// no telemetry or hosted-provider credentials may ride along. Every check
// here fails closed — a missing explicit opt-in is never read as consent.
//
// BYOK keys may remain stored in the database; nothing here deletes them.
// What makes them unusable in strict mode is the model allow-gate: the LLM
// and audio call sites refuse hosted lanes before a key is ever spent.

import { getCommitteeModel, getConfiguredModel } from "./llm/registry";

/** Operator-visible failure for a strict-private-mode violation. */
export class PrivateModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateModeError";
  }
}

/**
 * The mode flag, read per call so tests and long-lived processes can stub or
 * re-read it. Exact-match, like the search egress check: only the literal
 * "true" enables the mode, so a typo degrades to the permissive default
 * rather than silently claiming strictness the deployment did not configure.
 */
export function isStrictPrivateMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.STRICT_PRIVATE_MODE === "true";
}

// Hosted-provider credentials that must not sit in a segmented deployment's
// environment. Names follow how the repo actually reads keys (see
// user.apiKeyStore.envApiKey and providers.ROUTER_KEY_ENV_HINTS): the Vercel
// gateway key is AI_GATEWAY_API_KEY, and CLAUDE_API_KEY is the documented
// Anthropic alias. Base-URL overrides (OPENROUTER_BASE_URL etc.) are
// deliberately not checked — pointing a lane at an internal gateway is the
// operator's choice, not a credential leak. OpenCode Go keys are also
// absent: that lane stays permitted, and its traffic still crosses the
// shared egress gate.
const HOSTED_CLOUD_KEY_ENVS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
] as const;

/**
 * Boot gate for strict private mode: throw before the process serves traffic
 * when the environment still leaks.
 *
 * Telemetry defaults to ON (Mike's community Sentry install) unless
 * SENTRY_DISABLED=true, so strict mode requires the explicit opt-out rather
 * than trusting SENTRY_DSN to be absent.
 */
export function assertPrivateModeBoot(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isStrictPrivateMode(env)) return;

  if (env.SENTRY_DISABLED !== "true") {
    throw new PrivateModeError(
      "STRICT_PRIVATE_MODE=true requires SENTRY_DISABLED=true: error reporting would otherwise ship to a hosted Sentry (Mike's community project unless SENTRY_DSN points elsewhere).",
    );
  }

  const present = HOSTED_CLOUD_KEY_ENVS.filter((name) => env[name]?.trim());
  if (present.length > 0) {
    throw new PrivateModeError(
      `STRICT_PRIVATE_MODE=true forbids hosted cloud provider credentials in the environment: ${present.join(", ")}. Remove them or unset STRICT_PRIVATE_MODE.`,
    );
  }
}

// Lanes that stay usable in strict private mode: local Ollama compute and
// OpenCode Go (whose catalog and request traffic still cross the shared
// egress gate). Everything else is default-deny.
const PRIVATE_MODE_MODEL_PREFIXES = ["ollama/", "opencode-go/"] as const;

// Recognized hosted lanes, named in the refusal so logs and the settings UI
// can say which provider the id would have reached. Unknown ids are refused
// by the default-deny below even when no lane matches.
const HOSTED_MODEL_LANES: ReadonlyArray<{ lane: string; prefix: string }> = [
  { lane: "Claude (Anthropic)", prefix: "claude" },
  { lane: "Gemini (Google)", prefix: "gemini" },
  { lane: "OpenAI", prefix: "gpt-" },
  { lane: "OpenRouter", prefix: "openrouter/" },
  { lane: "Vercel AI Gateway", prefix: "vercel/" },
];

/**
 * Refuse a model id at the point of use when strict private mode is on.
 *
 * Allowed: local Ollama ids, OpenCode Go ids, and operator-configured
 * entries — declared in MIKE_MODEL_CONFIG_JSON (registry lookup) or flagged
 * by the caller with `isConfigured` (covers committees assembled per
 * request). Outside strict mode this is a no-op.
 *
 * This is what makes stored BYOK keys unusable here: the key store still
 * returns them (no data loss), but no hosted lane reaches the point where a
 * key would be spent.
 */
export function assertModelAllowed(
  model: string,
  opts: { isConfigured?: boolean } = {},
): void {
  if (!isStrictPrivateMode()) return;

  if (PRIVATE_MODE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return;
  }
  if (opts.isConfigured === true) return;
  // lib-to-lib import only: the registry parses MIKE_MODEL_CONFIG_JSON and
  // imports types alone, so this cannot cycle back through the llm modules.
  if (getConfiguredModel(model) || getCommitteeModel(model)) return;

  const hosted = HOSTED_MODEL_LANES.find(({ prefix }) =>
    model.startsWith(prefix),
  );
  if (hosted) {
    throw new PrivateModeError(
      `Model '${model}' belongs to the hosted ${hosted.lane} lane, which is disabled in strict private mode. Use ollama/*, opencode-go/*, or an operator-configured endpoint.`,
    );
  }
  throw new PrivateModeError(
    `Model '${model}' is not an allowed lane in strict private mode. Only ollama/*, opencode-go/*, and operator-configured models are permitted.`,
  );
}
