import {
  CONFIGURED_REASONING_EFFORTS,
  type CommitteeModel,
  type ConfiguredModel,
  type ConfiguredReasoning,
  type ConfiguredReasoningEffort,
  type Provider,
  type UserApiKeys,
} from "./types";
import { PHALA_GATEWAY_REPO } from "./attestation/aci";

// Deployment-declared models. The static catalog in models.ts covers the
// hosted providers Mike ships with; this registry is how an operator adds a
// self-hosted or third-party endpoint (and, in a later change, committees)
// without a code change. Everything is read from one env var so the
// configuration travels with the deployment rather than the database.

type ModelRegistryConfig = {
  models: ConfiguredModel[];
  committees: CommitteeModel[];
};

const EMPTY_CONFIG: ModelRegistryConfig = { models: [], committees: [] };

let cached: ModelRegistryConfig | undefined;

export function loadModelRegistry(): ModelRegistryConfig {
  if (cached) return cached;

  const raw = process.env.MIKE_MODEL_CONFIG_JSON?.trim();
  if (!raw) {
    cached = EMPTY_CONFIG;
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MIKE_MODEL_CONFIG_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  cached = {
    models: Array.isArray(record.models)
      ? record.models.flatMap((value) => {
          const model = parseConfiguredModel(value);
          return model ? [model] : [];
        })
      : [],
    committees: Array.isArray(record.committees)
      ? record.committees.filter(isCommitteeModel)
      : [],
  };
  return cached;
}

/** Test seam — the registry is otherwise parsed once per process. */
export function resetModelRegistryCache(): void {
  cached = undefined;
}

export function getConfiguredModel(id: string): ConfiguredModel | null {
  return loadModelRegistry().models.find((model) => model.id === id) ?? null;
}

export function getCommitteeModel(
  id: string,
  additionalCommittees: CommitteeModel[] = [],
): CommitteeModel | null {
  return (
    additionalCommittees.find((committee) => committee.id === id) ??
    loadModelRegistry().committees.find((committee) => committee.id === id) ??
    null
  );
}

export function configuredModelIds(
  additionalCommittees: CommitteeModel[] = [],
): string[] {
  return configuredModelSummaries(additionalCommittees).map(
    (summary) => summary.id,
  );
}

export type ConfiguredModelSummary = {
  id: string;
  label: string;
  provider: Provider | "committee";
  location: ModelSummaryLocation;
};

type ModelSummaryLocation = ConfiguredModel["location"] | "committee";

export function configuredModelSummaries(
  additionalCommittees: CommitteeModel[] = [],
): ConfiguredModelSummary[] {
  const registry = loadModelRegistry();
  const committees = [...registry.committees, ...additionalCommittees];
  return [
    ...registry.models.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      provider: model.provider,
      location: model.location,
    })),
    ...committees.map((committee) => ({
      id: committee.id,
      label: committee.label || committee.id,
      provider: "committee" as const,
      location: "committee" as const,
    })),
  ];
}

export function apiKeyForConfiguredModel(
  model: ConfiguredModel,
  apiKeys?: UserApiKeys,
): string | null {
  if (model.apiKey?.trim()) return model.apiKey.trim();
  if (model.apiKeyProvider) {
    const userKey = apiKeys?.[model.apiKeyProvider];
    if (typeof userKey === "string" && userKey.trim()) return userKey.trim();
  }
  if (model.apiKeyEnv?.trim()) {
    return process.env[model.apiKeyEnv.trim()]?.trim() || null;
  }
  return null;
}

/** Whether the declaration names an authentication source that must resolve. */
export function configuredModelRequiresApiKey(model: ConfiguredModel): boolean {
  return Boolean(model.apiKey || model.apiKeyEnv || model.apiKeyProvider);
}

export type ConfiguredEndpointSummary = {
  id: string;
  label: string;
  group: string;
  location: ConfiguredModel["location"];
  available: boolean;
};

/** Picker heading for declarations that name none. */
export const DEFAULT_CONFIGURED_GROUP = "Configured";

/** Public, secret-free catalog information for the requesting user. */
export function configuredEndpointSummaries(
  apiKeys?: UserApiKeys,
): ConfiguredEndpointSummary[] {
  return loadModelRegistry().models.map((model) => ({
    id: model.id,
    label: model.label || model.id,
    group: model.group || DEFAULT_CONFIGURED_GROUP,
    location: model.location,
    available:
      !configuredModelRequiresApiKey(model) ||
      apiKeyForConfiguredModel(model, apiKeys) !== null,
  }));
}

/**
 * Local endpoints are the ones that routinely emit tool calls as prose, so
 * they get the tolerant parsing path unless the config says otherwise.
 */
export function tolerateTextToolCalls(model: ConfiguredModel): boolean {
  return model.tolerateTextToolCalls ?? model.location === "local";
}

// Only OpenAI-compatible endpoints are declarable. The hosted providers are
// covered by the static catalog in models.ts and by the router prefixes
// (openrouter/, vercel/, opencode-go/), so a configured entry for one of them
// would be a second, subtly different way to say the same thing.
const USER_API_KEY_PROVIDERS = new Set<keyof UserApiKeys>([
  "claude",
  "gemini",
  "openai",
  "openrouter",
  "vercel",
  "opencode-go",
  "courtlistener",
]);

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function validBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

/**
 * Attestation declarations are all-or-nothing: a malformed record rejects the
 * whole model entry rather than silently dropping the requirement, so a typo
 * can never downgrade an attested endpoint to an unattested one. A missing
 * expectedMeasurement is malformed for the same reason: a lane that verifies
 * without a pinned measurement accepts whatever the endpoint self-reports.
 */
function parseAttestation(
  value: unknown,
): ConfiguredModel["attestation"] | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.scheme !== undefined) {
    // ACI pins the workload by hardware evidence and source repository, so
    // the repository defaults to Phala's gateway rather than being optional.
    if (record.scheme !== "aci") return null;
    const repoUrl = optionalString(record, "repoUrl");
    const composeHash = optionalString(record, "composeHash");
    if (repoUrl === null || composeHash === null) return null;
    if (repoUrl !== undefined && !validBaseUrl(repoUrl)) return null;
    if (composeHash !== undefined && !/^[0-9a-f]{64}$/i.test(composeHash)) return null;
    return {
      scheme: "aci",
      repoUrl: repoUrl ?? PHALA_GATEWAY_REPO,
      ...(composeHash ? { composeHash: composeHash.toLowerCase() } : {}),
    };
  }
  const endpoint = optionalString(record, "endpoint");
  if (!endpoint || !validBaseUrl(endpoint)) return null;
  const expectedMeasurement = optionalString(record, "expectedMeasurement");
  if (!expectedMeasurement) return null;
  return { endpoint, expectedMeasurement };
}

/** A whole number in [min, max]; undefined when absent, null when malformed. */
function optionalInteger(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined | null {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/** Context windows and output limits Mike accepts, in tokens. */
const MIN_CONTEXT_WINDOW = 1_024;
const MAX_TOKENS_LIMIT = 100_000_000;
/** Stream idle limits Mike accepts, in ms (as STREAM_CHUNK_TIMEOUT_MS). */
const MIN_STREAM_IDLE_MS = 5_000;
const MAX_STREAM_IDLE_MS = 30 * 60_000;

/**
 * Reasoning declarations are all-or-nothing, like attestation: a malformed
 * record rejects the model rather than quietly running a reasoning model
 * without its reasoning.
 */
function parseReasoning(
  value: unknown,
): ConfiguredReasoning | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const known = new Set<string>(CONFIGURED_REASONING_EFFORTS);
  const efforts = record.efforts;
  if (
    !Array.isArray(efforts) ||
    efforts.length === 0 ||
    !efforts.every((effort) => typeof effort === "string" && known.has(effort)) ||
    new Set(efforts).size !== efforts.length
  ) {
    return null;
  }
  // Lightest first, whatever order the declaration used.
  const ordered = CONFIGURED_REASONING_EFFORTS.filter((effort) =>
    efforts.includes(effort),
  );
  const fallback: ConfiguredReasoningEffort = ordered.includes("high")
    ? "high"
    : ordered[ordered.length - 1];
  const effortDefault = record.default ?? fallback;
  if (
    typeof effortDefault !== "string" ||
    !ordered.includes(effortDefault as ConfiguredReasoningEffort)
  ) {
    return null;
  }
  if (record.canDisable !== undefined && typeof record.canDisable !== "boolean") {
    return null;
  }
  const canDisable = record.canDisable === true;
  const offValue = optionalString(record, "offValue");
  // An off value only means something for a model that can be turned off.
  if (offValue === null || (offValue !== undefined && !canDisable)) return null;
  const param = record.param ?? "reasoning_effort";
  if (
    param !== "reasoning_effort" &&
    param !== "reasoning.effort" &&
    param !== "none"
  ) {
    return null;
  }
  return {
    efforts: ordered,
    default: effortDefault as ConfiguredReasoningEffort,
    canDisable,
    ...(offValue ? { offValue } : {}),
    param,
  };
}

/** Per-million-token prices; each rate a finite, non-negative number. */
function parseCost(value: unknown): ConfiguredModel["cost"] | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rate = (field: string): number | null => {
    const rateValue = record[field];
    if (rateValue === undefined) return 0;
    return typeof rateValue === "number" &&
      Number.isFinite(rateValue) &&
      rateValue >= 0
      ? rateValue
      : null;
  };
  const input = rate("input");
  const output = rate("output");
  const cacheRead = rate("cacheRead");
  const cacheWrite = rate("cacheWrite");
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

function parseConfiguredModel(value: unknown): ConfiguredModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = optionalString(record, "id");
  const label = optionalString(record, "label");
  const group = optionalString(record, "group");
  const apiModel = optionalString(record, "apiModel");
  const baseUrl = optionalString(record, "baseUrl");
  const apiKeyEnv = optionalString(record, "apiKeyEnv");
  const apiKey = optionalString(record, "apiKey");
  const apiKeyProvider = record.apiKeyProvider;
  const maxTokensField = record.maxTokensField;
  const attestation = parseAttestation(record.attestation);
  const contextWindow = optionalInteger(
    record,
    "contextWindow",
    MIN_CONTEXT_WINDOW,
    MAX_TOKENS_LIMIT,
  );
  const maxOutputTokens = optionalInteger(
    record,
    "maxOutputTokens",
    1,
    MAX_TOKENS_LIMIT,
  );
  const reasoning = parseReasoning(record.reasoning);
  const cost = parseCost(record.cost);
  const streamIdleTimeoutMs = optionalInteger(
    record,
    "streamIdleTimeoutMs",
    MIN_STREAM_IDLE_MS,
    MAX_STREAM_IDLE_MS,
  );

  if (
    !id ||
    id.length > 200 ||
    /\s/.test(id) ||
    record.provider !== "openai-compatible" ||
    (record.location !== "cloud" && record.location !== "local") ||
    !baseUrl ||
    !validBaseUrl(baseUrl) ||
    label === null ||
    group === null ||
    (group !== undefined && group.length > 80) ||
    apiModel === null ||
    apiKeyEnv === null ||
    apiKey === null ||
    attestation === null ||
    // ACI pins TLS to the attested keys, which needs TLS.
    (attestation && "scheme" in attestation && !baseUrl.startsWith("https://")) ||
    (apiKeyProvider !== undefined &&
      (typeof apiKeyProvider !== "string" ||
        !USER_API_KEY_PROVIDERS.has(apiKeyProvider as keyof UserApiKeys))) ||
    (record.tolerateTextToolCalls !== undefined &&
      typeof record.tolerateTextToolCalls !== "boolean") ||
    (record.supportsVision !== undefined &&
      typeof record.supportsVision !== "boolean") ||
    (maxTokensField !== undefined &&
      maxTokensField !== "max_tokens" &&
      maxTokensField !== "max_completion_tokens") ||
    contextWindow === null ||
    maxOutputTokens === null ||
    // The answer has to fit in the window with at least some input.
    (contextWindow !== undefined &&
      maxOutputTokens !== undefined &&
      maxOutputTokens >= contextWindow) ||
    reasoning === null ||
    cost === null ||
    streamIdleTimeoutMs === null
  ) {
    return null;
  }

  return {
    id,
    provider: "openai-compatible",
    location: record.location,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(attestation ? { attestation } : {}),
    ...(label ? { label } : {}),
    ...(group ? { group } : {}),
    ...(apiModel ? { apiModel } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyProvider
      ? { apiKeyProvider: apiKeyProvider as keyof UserApiKeys }
      : {}),
    ...(typeof record.tolerateTextToolCalls === "boolean"
      ? { tolerateTextToolCalls: record.tolerateTextToolCalls }
      : {}),
    ...(typeof record.supportsVision === "boolean"
      ? { supportsVision: record.supportsVision }
      : {}),
    ...(maxTokensField ? { maxTokensField } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(cost ? { cost } : {}),
    ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
  };
}

function isCommitteeModel(value: unknown): value is CommitteeModel {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.chair === "string" &&
    Array.isArray(record.members) &&
    record.members.every(
      (member) =>
        typeof member === "string" ||
        (!!member &&
          typeof member === "object" &&
          typeof (member as Record<string, unknown>).model === "string"),
    )
  );
}
