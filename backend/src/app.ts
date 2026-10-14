import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { chatRouter } from "./modules/chat/chat.routes";
import { wordChatRouter } from "./modules/word-chat/wordChat.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { orgsRouter } from "./modules/orgs/orgs.routes";
import { projectChatRouter } from "./modules/project-chat/projectChat.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { libraryRouter } from "./modules/library/library.routes";
import { tabularRouter } from "./modules/tabular/tabular.routes";
import { workflowsRouter } from "./modules/workflows/workflows.routes";
import { quickActionsRouter } from "./modules/quick-actions/quickActions.routes";
import { vaultRouter } from "./modules/vault/vault.routes";
import { workflowAddonsRouter } from "./modules/workflows/workflowAddons.routes";
import { userRouter } from "./modules/user/user.routes";
import { modelsRouter } from "./modules/models/models.routes";
import { downloadsRouter } from "./modules/downloads/downloads.routes";
import { sourceDocumentsRouter } from "./modules/source-documents/sourceDocuments.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { uploadSessionsRouter } from "./modules/uploads/uploads.routes";
import { audioRouter } from "./modules/audio/audio.routes";
import { citationsRouter } from "./modules/citations/citations.routes";
import {
  projectMemoryRouter,
  userMemoryRouter,
} from "./modules/memory/memory.routes";
import { manifestPublicKey } from "./lib/manifestSigning";
import {
  handleUnhandledError,
  protectInternalErrorResponses,
} from "./middleware/internalErrorResponse";
import { configuredAllowedOrigins, requestOriginIsTrusted } from "./lib/origins";
import { assertPrivateModeBoot } from "./lib/privateMode";
import { envInt } from "./lib/runtimeConfig";
import { tagCurrentRequest } from "./lib/observability/sentry";

export const app = express();
const isProduction = process.env.NODE_ENV === "production";

// Station 8: strict private mode fails closed before any route is mounted.
// index.ts imports this module before main() binds the listener, so exiting
// here means a leaking segmented deployment never serves a request. The gate
// is a no-op unless STRICT_PRIVATE_MODE=true.
try {
  assertPrivateModeBoot();
} catch (error) {
  console.error(
    `[boot] refusing to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

// Ceiling for JSON API requests. File bytes upload directly to object storage;
// only small upload-session manifests and control requests reach Express.
const JSON_BODY_LIMIT = "50mb";

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (req: express.Request) => string;
  skipSuccessfulRequests?: boolean;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: options.keyGenerator,
    skipSuccessfulRequests: options.skipSuccessfulRequests,
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const TOOL_RESULT_PATH = "/word-chat/tool-result";

const authLoginIpLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_LOGIN_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_LOGIN_MAX", 30),
  message: "Too many login attempts. Please try again later.",
  skipSuccessfulRequests: true,
});

const authLoginAccountLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_ACCOUNT_MAX", 10),
  message: "Too many login attempts. Please try again later.",
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!email) {
      return `ip:${ipKeyGenerator(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
      )}`;
    }
    return `email:${createHash("sha256").update(email).digest("hex")}`;
  },
});

const authEmailLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_AUTH_EMAIL_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_AUTH_EMAIL_MAX", 10),
  message: "Too many authentication requests. Please try again later.",
});

const authFlowLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_FLOW_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_FLOW_MAX", 30),
  message: "Too many authentication requests. Please try again later.",
});

const authMfaLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_MFA_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_MFA_MAX", 20),
  message: "Too many verification attempts. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));
app.use((_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  // Same id on the Sentry event, the response body, and the access log.
  tagCurrentRequest(requestId);
  next();
});
app.use(protectInternalErrorResponses);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

export { configuredAllowedOrigins } from "./lib/origins";

const allowedOrigins = configuredAllowedOrigins();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no Origin header) and any
      // explicitly listed origin. A disallowed origin resolves to `false`
      // (cors omits the Access-Control-Allow-Origin header and the browser
      // blocks the response) rather than calling back with an Error —
      // throwing here would propagate to Express's default handler and turn
      // every disallowed cross-origin request, including preflight, into an
      // HTTP 500.
      callback(null, !origin || requestOriginIsTrusted(origin));
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // The request id is the correlation key between a user report, the
    // access log, and the Sentry event. Browsers hide response headers from
    // cross-origin scripts unless they are listed here, so a dev build or a
    // self-hoster serving the API from another origin could not read it.
    exposedHeaders: ["X-Request-ID", "X-Mike-Audio-Provider", "X-Mike-Audio-Model", "X-Mike-Audio-Cost"],
  }),
);

// Only the authentication endpoints are rate limited: they guard against
// password guessing and email abuse. Chat, export, import and deletion
// requests are not, so long-running and scripted work is never refused.
app.post("/auth/login", authLoginIpLimiter);
app.post(["/auth/signup", "/auth/password-reset"], authEmailLimiter);
app.post(["/auth/oauth", "/auth/exchange", "/auth/handoff"], authFlowLimiter);
app.post(
  ["/auth/mfa/verify", "/auth/mfa/challenge-and-verify"],
  authMfaLimiter,
);

// A tight body cap for the Word tool-result return channel: the largest
// legitimate payload is one live document read, which the backend truncates at
// 200k characters anyway — 2mb leaves headroom for UTF-8 and JSON escaping
// while keeping the global 50mb ceiling out of reach of this endpoint. This
// parser runs before the global one; body-parser skips a request whose body is
// already parsed, so the smaller limit wins for this path.
app.post(TOOL_RESULT_PATH, express.json({ limit: "2mb" }));

const legacyUploadRemoved = (_req: express.Request, res: express.Response) => {
  res.status(410).json({
    code: "upload_session_required",
    detail: "This upload endpoint has been replaced by /upload-sessions.",
  });
};

// Reject the former multipart endpoints before any body parser or route-level
// body-reading middleware can consume file bytes. Browser clients use the
// direct object-storage upload-session protocol instead.
app.post("/single-documents", legacyUploadRemoved);
app.post("/library/:kind/documents", legacyUploadRemoved);
app.post("/single-documents/:documentId/versions", legacyUploadRemoved);
app.put(
  "/single-documents/:documentId/versions/:versionId/file",
  legacyUploadRemoved,
);
app.post("/projects/:projectId/documents", legacyUploadRemoved);

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Body-aware account throttling complements the per-IP login limiter. The key
// is a one-way digest, so email addresses never enter the limiter store.
app.post("/auth/login", authLoginAccountLimiter);

app.use("/auth", authRouter);
app.use("/chat", chatRouter);
app.use("/citation-checks", citationsRouter);
app.use("/word-chat", wordChatRouter);
app.use("/models", modelsRouter);
app.use("/projects/:projectId/memory", projectMemoryRouter);
app.use("/projects", projectsRouter);
app.use("/orgs", orgsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/library", libraryRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/quick-actions", quickActionsRouter);
app.use("/workflow-addons", workflowAddonsRouter);
app.use("/user/memory", userMemoryRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/documents", sourceDocumentsRouter);
app.use("/audit", auditRouter);
app.use("/upload-sessions", uploadSessionsRouter);
app.use("/audio", audioRouter);
app.use("/vault", vaultRouter);
// /diligence (RLM deep runs) is not mounted: the work is tabled until its
// sandbox and model lane are redone (goals/STATUS.md).

app.get("/health", (_req, res) => res.json({ ok: true }));

// Deliberate failure for verifying the error pipeline end to end (a real
// thrown error through the real 500 path, so the Sentry event carries the
// request id the caller sees). Opt-in per deployment: it is an unauthenticated
// way to generate events, so leave it off once the DSN is confirmed working.
if (process.env.SENTRY_ENABLE_TEST_ROUTE === "true") {
  app.get("/observability/sentry-test", () => {
    throw Object.assign(new Error("Sentry backend test error (SENTRY_ENABLE_TEST_ROUTE)"), { code: "sentry_test" });
  });
}

// The Ed25519 public key this deployment signs project export manifests with,
// or null when no key is configured. Deliberately open: whoever checks a
// manifest is usually outside the workspace, and they need to get the key from
// the server rather than trust the copy inside the file they were handed.
app.get("/manifest-signing-key", (_req, res) => {
  try {
    res.json(manifestPublicKey());
  } catch (err) {
    console.error("[manifest-signing-key] failed", err);
    res.status(500).json({
      detail: "Manifest signing key is misconfigured",
    });
  }
});

// Terminal error handler. Routers mount routerErrorHandler("[tag]") so a
// failure is attributed to its router in the log; the response is delegated
// back here, so every router answers with the same body. Anything that escapes
// a router lands here too, instead of Express's default handler, which would
// leak the stack trace in a non-production environment. Must stay last: Express
// only reaches an error handler registered after the middleware that failed.
app.use(handleUnhandledError);
