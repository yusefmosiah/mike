/**
 * Auto Mode guardrails (lib): tiering, scope checks, and Tier 3
 * classification for assistant tool calls. See ./policy.ts for the tier
 * definitions and ./classifier.ts for the on-route classifier.
 */

export {
  AUTO_MODE_SAFE_DEFAULTS,
  DOCUMENT_WRITE_TOOLS,
  TIER_1_READ_TOOLS,
  inScopeForContainer,
  tierForTool,
} from "./policy";
export type { GuardrailTier } from "./policy";

export {
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  classifyToolCall,
} from "./classifier";
export type {
  ClassifierCompleteFn,
  ClassifierVerdict,
  ClassifyToolCallInput,
  ClassifyToolCallResult,
} from "./classifier";
