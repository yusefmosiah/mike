// Strict private mode's boot gate lives in lib/privateMode (which also owns
// the model allow-gate); re-exported here so this module stays the single
// discoverable home for boot-time configuration checks.
export { assertPrivateModeBoot } from "./privateMode";

function required(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function envInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

// The hourly session ceiling is passed straight into a PostgreSQL integer
// argument, so an oversized override would turn every session create into a
// numeric-overflow failure rather than a looser limit.
const MAX_UPLOAD_SESSIONS_PER_HOUR = 1_000_000;

export function uploadSessionRateLimitConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    mutationWindowMinutes: envInt(
      "RATE_LIMIT_UPLOAD_SESSION_MUTATION_WINDOW_MINUTES",
      15,
      env,
    ),
    mutationMax: envInt("RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX", 300, env),
    pollingWindowMinutes: envInt(
      "RATE_LIMIT_UPLOAD_SESSION_POLL_WINDOW_MINUTES",
      15,
      env,
    ),
    pollingMax: envInt("RATE_LIMIT_UPLOAD_SESSION_POLL_MAX", 3_000, env),
    sessionCreationMaxPerHour: clamp(
      envInt("RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR", 50, env),
      1,
      MAX_UPLOAD_SESSIONS_PER_HOUR,
    ),
  };
}

export function uploadProcessingConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const concurrency = Math.min(
    envInt("UPLOAD_PROCESSING_CONCURRENCY", 8, env),
    64,
  );
  return {
    concurrency,
    maxRunningPerUser: Math.min(
      envInt("UPLOAD_PROCESSING_MAX_RUNNING_PER_USER", 2, env),
      concurrency,
    ),
  };
}

/**
 * Hard deadline for one LibreOffice conversion. A wedged `soffice` child would
 * otherwise hold its worker slot for the life of the process.
 */
export function uploadConversionTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clamp(
    envInt("UPLOAD_CONVERT_TIMEOUT_MS", 120_000, env),
    10_000,
    600_000,
  );
}

/**
 * Wall-clock budget for one upload job. Past this point the worker stops
 * renewing its lease so another worker can steal and retry the job.
 */
export function uploadJobWallClockMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clamp(
    envInt("UPLOAD_JOB_WALL_CLOCK_MS", 15 * 60_000, env),
    60_000,
    60 * 60_000,
  );
}

/**
 * Deadlines for one server-owned SSE run (chat, project chat, Word chat,
 * tabular generation). `idleMs` aborts a run that has produced no output for
 * that long (a hung provider or tool); it re-arms on every frame, so a long
 * agentic run that keeps working is unaffected. `maxMs` is a wall-clock
 * backstop for a run that never stops emitting.
 */
export function streamRunDeadlines(env: NodeJS.ProcessEnv = process.env): {
  idleMs: number;
  maxMs: number;
} {
  return {
    idleMs: clamp(
      envInt("STREAM_IDLE_TIMEOUT_MS", 5 * 60_000, env),
      30_000,
      60 * 60_000,
    ),
    maxMs: clamp(
      envInt("STREAM_MAX_LIFETIME_MS", 4 * 60 * 60_000, env),
      60_000,
      24 * 60 * 60_000,
    ),
  };
}

/**
 * Silence limits on the MODEL's response stream, enforced by the provider
 * relay in lib/llm/pi/providers.mts. `firstChunkMs` bounds the wait for the first
 * output of each step (a reasoning model may think silently for a while, so it
 * is generous); `chunkMs` bounds the gap between chunks once output is
 * flowing, and re-arms on every chunk. They catch a stalled provider at the
 * source; `streamRunDeadlines` stays as the run-level backstop.
 */
export function streamChunkTimeouts(env: NodeJS.ProcessEnv = process.env): {
  firstChunkMs: number;
  chunkMs: number;
} {
  return {
    firstChunkMs: clamp(
      envInt("STREAM_FIRST_CHUNK_TIMEOUT_MS", 2 * 60_000, env),
      10_000,
      30 * 60_000,
    ),
    chunkMs: clamp(
      envInt("STREAM_CHUNK_TIMEOUT_MS", 60_000, env),
      5_000,
      30 * 60_000,
    ),
  };
}

function parsedUrl(value: string, name: string, errors: string[]): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${name} must use http or https`);
      return null;
    }
    return url;
  } catch {
    errors.push(`${name} must be an absolute URL`);
    return null;
  }
}

function requireHttps(url: URL | null, name: string, errors: string[]) {
  if (url && url.protocol !== "https:") {
    errors.push(`${name} must use https in production`);
  }
}

export interface AuthServerConfiguration {
  /** GoTrue's base URL as this process reaches it (no trailing slash). */
  url: string;
  /** GoTrue's base URL as a browser reaches it: OAuth redirects go here. */
  publicUrl: string;
  /** A service-role JWT signed with GoTrue's secret: admin API access. */
  serviceKey: string;
}

/** Where the auth server (GoTrue) is, and the key to its admin API. */
export function authServerConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): AuthServerConfiguration {
  const url = required(env, ["AUTH_URL"]).replace(/\/+$/, "");
  return {
    url,
    publicUrl: required(env, ["AUTH_PUBLIC_URL"]).replace(/\/+$/, "") || url,
    serviceKey: required(env, ["AUTH_SERVICE_KEY"]),
  };
}

export function configuredApiPublicUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return required(env, ["API_PUBLIC_URL"]).replace(/\/+$/, "");
}

export function authHandoffEncryptionSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = env.AUTH_HANDOFF_ENCRYPTION_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      "AUTH_HANDOFF_ENCRYPTION_SECRET must contain at least 32 characters",
    );
  }
  return secret;
}

/**
 * The Postgres database: application tables and chat transcripts (Pi
 * Durable) alike. PI_DURABLE_DATABASE_URL is the name it had while only the
 * chat runtime used it.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL?.trim() || env.PI_DURABLE_DATABASE_URL?.trim() || undefined;
}

/**
 * Fail before the HTTP listener starts when the authentication boundary is not
 * usable. This deliberately lives outside app.ts so unit tests can import the
 * Express app without supplying production credentials.
 */
export function validateRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const errors: string[] = [];
  const auth = authServerConfiguration(env);

  if (!auth.url) errors.push("AUTH_URL is required (the GoTrue auth server)");
  if (!auth.serviceKey) {
    errors.push("AUTH_SERVICE_KEY is required (a service-role JWT for GoTrue)");
  }
  if (auth.url) parsedUrl(auth.url, "AUTH_URL", errors);
  if (env.AUTH_PUBLIC_URL?.trim()) {
    parsedUrl(env.AUTH_PUBLIC_URL.trim(), "AUTH_PUBLIC_URL", errors);
  }
  if (!databaseUrl(env)) {
    errors.push("DATABASE_URL is required (the Postgres database)");
  }

  if (env.AUTH_HANDOFF_ENCRYPTION_SECRET?.trim()) {
    if (env.AUTH_HANDOFF_ENCRYPTION_SECRET.trim().length < 32) {
      errors.push(
        "AUTH_HANDOFF_ENCRYPTION_SECRET must contain at least 32 characters",
      );
    }
  } else if (env.WORD_ADDIN_URL?.trim()) {
    errors.push(
      "AUTH_HANDOFF_ENCRYPTION_SECRET is required when WORD_ADDIN_URL is set",
    );
  }

  const errorsBeforeProductionChecks = errors.length;
  if (env.NODE_ENV === "production") {
    const frontend = env.FRONTEND_URL?.trim();
    if (!frontend) {
      errors.push("FRONTEND_URL is required in production");
    } else {
      requireHttps(
        parsedUrl(frontend, "FRONTEND_URL", errors),
        "FRONTEND_URL",
        errors,
      );
    }

    const publicApi = configuredApiPublicUrl(env);
    if (!publicApi) {
      errors.push("API_PUBLIC_URL is required in production");
    } else {
      requireHttps(
        parsedUrl(publicApi, "API_PUBLIC_URL", errors),
        "API_PUBLIC_URL",
        errors,
      );
    }

    const wordAddin = env.WORD_ADDIN_URL?.trim();
    if (wordAddin) {
      requireHttps(
        parsedUrl(wordAddin, "WORD_ADDIN_URL", errors),
        "WORD_ADDIN_URL",
        errors,
      );
    }
  }

  if (errors.length > 0) {
    // The backend image sets NODE_ENV=production so that a real deployment
    // can never boot with insecure cookies by omission. Someone who runs that
    // image outside docker compose on their own machine hits these public-URL rules
    // first, so say which switch they are actually looking for.
    const hint =
      errors.length > errorsBeforeProductionChecks
        ? "\n\nNODE_ENV=production requires the public https URLs above " +
          "(FRONTEND_URL, API_PUBLIC_URL, and WORD_ADDIN_URL when set). " +
          "For a local run over http, set NODE_ENV=development instead; " +
          "docker compose does this by default. See docs/deployment.md."
        : "";
    throw Object.assign(
      new Error(
        `Backend authentication configuration is invalid:\n- ${errors.join("\n- ")}${hint}`,
      ),
      {
        code: "configuration_invalid",
        // Field names only: never configuration values or validation prose.
        configurationFields: [
          ...new Set(
            errors.map((issue) => issue.match(/^[A-Z_]+/)?.[0]).filter(Boolean),
          ),
        ],
      },
    );
  }
}
