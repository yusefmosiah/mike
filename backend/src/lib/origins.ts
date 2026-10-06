export function configuredAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const developmentOrigins =
    env.NODE_ENV === "production"
      ? []
      : [
          ...(env.FRONTEND_URL ? [] : ["http://localhost:3000"]),
          ...(env.WORD_ADDIN_URL ? [] : ["https://localhost:3200"]),
        ];

  return new Set(
    [
      env.FRONTEND_URL ?? "http://localhost:3000",
      env.WORD_ADDIN_URL,
      ...(env.ALLOWED_ORIGINS ?? "").split(","),
      ...developmentOrigins,
    ]
      .map((origin) => origin?.trim().replace(/\/$/, ""))
      .filter((origin): origin is string => !!origin),
  );
}

function isDevelopmentPrivateOrigin(parsed: URL): boolean {
  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".ts.net")
  ) {
    return true;
  }
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 100.64.0.0/10 (Carrier-Grade NAT / Tailscale IP range)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  return false;
}

export function requestOriginIsTrusted(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (configuredAllowedOrigins(env).has(parsed.origin)) {
      return true;
    }
    if (env.NODE_ENV !== "production" && isDevelopmentPrivateOrigin(parsed)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function requestOriginIsWordAddin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured =
    env.WORD_ADDIN_URL?.trim() ||
    (env.NODE_ENV === "production" ? "" : "https://localhost:3200");
  if (!origin || !configured) return false;
  try {
    return new URL(origin).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}
