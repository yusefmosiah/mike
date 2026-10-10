// Business logic for the auth module.
//
// Service layer behind auth.routes.ts. This module owns the request-payload
// schemas, the redirect-URL construction, and every GoTrue call the endpoints
// make. It never touches req/res: the cookie-bearing GoTrue client is
// created by the route (that needs req/res to read and write cookies) and
// handed in, and every function returns GoTrue's own `{ data, error }` shape
// so the route keeps mapping failures exactly as it always has.
//
// There is no `db: Db` here — auth talks to GoTrue, not to the application
// database. The cookie/session primitives themselves stay in
// lib/authSession and lib/authHandoff because middleware/auth depends on them.

import { z } from "zod";
import type { Session, User } from "@supabase/auth-js";
import { browserAuthUrl, type AuthClient } from "../../lib/gotrue";
import { consumeAuthHandoff, issueAuthHandoff } from "../../lib/authHandoff";

// ---------------------------------------------------------------------------
// Request payload schemas
// ---------------------------------------------------------------------------

export const emailSchema = z.string().trim().email().max(320);
export const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(4096),
});
export const handoffRequestIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const exchangeSchema = z.object({
  code: z.string().trim().min(1).max(4096),
  handoffRequestId: handoffRequestIdSchema.optional(),
});
export const handoffSchema = z.object({
  ticket: z
    .string()
    .trim()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  requestId: handoffRequestIdSchema,
});
export const passwordSchema = z.object({
  password: z.string().min(8).max(4096),
  signOut: z.boolean().optional(),
});
export const factorSchema = z.object({ factorId: z.string().uuid() });
export const verificationSchema = factorSchema.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  challengeId: z.string().uuid().optional(),
});
export const friendlyNameSchema = z.string().trim().min(1).max(100);

export type Credentials = z.infer<typeof credentialsSchema>;

export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt hashes at most 72 bytes, so GoTrue refuses to set a longer password. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Why a NEW password (sign-up, password change) is not accepted, or null; the
 * web forms apply the same rule (frontend passwordPolicy.ts). Sign-in does
 * not: a password set under earlier rules (or before GoTrue refused long
 * ones) must still sign in, or its owner could never reach the page that
 * changes it.
 */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return "Password is too long: use at most 72 bytes (fewer characters with accents or emoji).";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redirect targets
// ---------------------------------------------------------------------------

/**
 * Only same-site absolute paths survive; anything else falls back. Blocks
 * protocol-relative (`//evil`), backslash, and control-character payloads
 * from riding along as an open redirect.
 */
export function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  return value;
}

/** The email/OAuth callback URL for a request that arrived from `origin`. */
export function buildCallbackUrl(
  origin: string,
  next: unknown,
  fallback: string,
  path = "/auth/callback",
): string {
  const url = new URL(path, origin);
  url.searchParams.set("next", safeNext(next, fallback));
  return url.toString();
}

// ---------------------------------------------------------------------------
// GoTrue calls
// ---------------------------------------------------------------------------

export function signInWithPassword(
  client: AuthClient,
  credentials: Credentials,
) {
  return client.signInWithPassword(credentials);
}

export function signUpWithPassword(
  client: AuthClient,
  credentials: Credentials,
  emailRedirectTo: string,
) {
  return client.signUp({
    ...credentials,
    options: { emailRedirectTo },
  });
}

export async function startGoogleOAuth(client: AuthClient, redirectTo: string) {
  const result = await client.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (result.data.url) result.data.url = browserAuthUrl(result.data.url);
  return result;
}

export const ssoRequestSchema = z.object({
  provider: z.literal("sso"),
  email: z.string().trim().toLowerCase().email().max(320),
});

export function startSsoSignIn(
  client: AuthClient,
  domain: string,
  redirectTo: string,
) {
  return client.signInWithSSO({
    domain,
    options: { redirectTo, skipBrowserRedirect: true },
  });
}

export function exchangeCodeForSession(client: AuthClient, code: string) {
  return client.exchangeCodeForSession(code);
}

/** Mint a one-shot ticket the Word add-in trades for a cookie session. */
export function issueWordHandoff(args: {
  userId: string;
  requestId: string;
  origin: string;
  session: Session;
}) {
  return issueAuthHandoff(args);
}

/** Redeem that ticket. Returns null when it is unknown, used, or expired. */
export function consumeWordHandoff(args: {
  ticket: string;
  requestId: string;
  origin: string;
}) {
  return consumeAuthHandoff(args);
}

export function applyHandoffSession(
  client: AuthClient,
  tokens: { accessToken: string; refreshToken: string },
) {
  return client.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
}

export function sendPasswordReset(
  client: AuthClient,
  email: string,
  redirectTo: string,
) {
  return client.resetPasswordForEmail(email, { redirectTo });
}

export async function currentUser(
  client: AuthClient,
): Promise<{ user: User | null; error: unknown }> {
  const { data, error } = await client.getUser();
  return { user: data.user, error };
}

export function signOut(client: AuthClient, scope: "global" | "local") {
  return client.signOut({ scope });
}

export function updateEmail(
  client: AuthClient,
  email: string,
  emailRedirectTo: string,
) {
  return client.updateUser({ email }, { emailRedirectTo });
}

export function updatePassword(client: AuthClient, password: string) {
  return client.updateUser({ password });
}

export function listMfaFactors(client: AuthClient) {
  return client.mfa.listFactors();
}

export function mfaAssuranceLevel(client: AuthClient) {
  return client.mfa.getAuthenticatorAssuranceLevel();
}

export function enrollMfaFactor(
  client: AuthClient,
  friendlyName: string,
) {
  return client.mfa.enroll({ factorType: "totp", friendlyName });
}

export function challengeMfaFactor(
  client: AuthClient,
  args: { factorId: string },
) {
  return client.mfa.challenge(args);
}

export function verifyMfaChallenge(
  client: AuthClient,
  args: { factorId: string; challengeId: string; code: string },
) {
  return client.mfa.verify(args);
}

export function challengeAndVerifyMfa(
  client: AuthClient,
  args: { factorId: string; code: string },
) {
  return client.mfa.challengeAndVerify(args);
}

export function unenrollMfaFactor(
  client: AuthClient,
  args: { factorId: string },
) {
  return client.mfa.unenroll(args);
}
