export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt hashes at most 72 bytes, so GoTrue refuses to set a longer password. */
export const MAX_PASSWORD_BYTES = 72;

export const minimumPasswordMessage = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const maximumPasswordMessage =
  "Password is too long: use at most 72 bytes (fewer characters with accents or emoji)";

/**
 * Why a NEW password (sign-up, reset, change) is not accepted, or null. Sign-in
 * does not apply this: a password set under earlier rules still signs in.
 */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return minimumPasswordMessage;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return maximumPasswordMessage;
  }
  return null;
}
