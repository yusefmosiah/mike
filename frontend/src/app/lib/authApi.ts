export interface AuthUser {
    id: string;
    email: string;
    pendingEmail: string | null;
    createdWithGoogle: boolean;
}

export interface MfaFactor {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
    status?: string;
}

export class AuthApiError extends Error {
    status: number;
    code: string | null;

    constructor(status: number, code: string | null, message: string) {
        super(message);
        this.name = "AuthApiError";
        this.status = status;
        this.code = code;
    }
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/auth${path}`, {
        ...init,
        // A request that stalls — not one that is refused — must not hold a
        // gate open: the session read guards every page's loading state.
        signal:
            init?.signal !== undefined && init.signal !== null
                ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
                : AbortSignal.timeout(30_000),
        credentials: "include",
        cache: "no-store",
        headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...(init?.headers as Record<string, string> | undefined),
        },
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
            code?: unknown;
            detail?: unknown;
        };
        throw new AuthApiError(
            response.status,
            typeof body.code === "string" ? body.code : null,
            typeof body.detail === "string"
                ? body.detail
                : "Authentication could not be completed.",
        );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

/**
 * Every page waits on the session read, so it gives up sooner than other
 * auth requests; AuthProvider retries a failed first read once.
 */
export const SESSION_REQUEST_TIMEOUT_MS = 10_000;

export async function getAuthSession(): Promise<AuthUser | null> {
    try {
        return (
            await authRequest<{ user: AuthUser }>("/session", {
                signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
            })
        ).user;
    } catch (error) {
        if (error instanceof AuthApiError && error.status === 401) return null;
        throw error;
    }
}

export async function login(email: string, password: string) {
    return authRequest<{ user: AuthUser }>("/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    });
}

export async function signup(email: string, password: string, next: string) {
    return authRequest<{
        user: AuthUser;
        requiresEmailConfirmation: boolean;
    }>("/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, next }),
    });
}

export async function startGoogleOAuth(next: string) {
    return authRequest<{ url: string }>("/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "google", next }),
    });
}

export function startSso(next: string, email: string) {
    return authRequest<{ url: string }>("/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "sso", next, email }),
    });
}

export async function exchangeAuthCode(code: string) {
    return authRequest<{ user: AuthUser }>("/exchange", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
}

export async function requestPasswordReset(email: string) {
    return authRequest<void>("/password-reset", {
        method: "POST",
        body: JSON.stringify({ email }),
    });
}

export async function logout(scope: "local" | "global" = "local") {
    return authRequest<void>("/logout", {
        method: "POST",
        body: JSON.stringify({ scope }),
    });
}

export async function updateAuthEmail(email: string, next: string) {
    return authRequest<{ user: AuthUser }>("/email", {
        method: "PATCH",
        body: JSON.stringify({ email, next }),
    });
}

export async function updateAuthPassword(password: string, signOut = false) {
    return authRequest<{ user: AuthUser }>("/password", {
        method: "PATCH",
        body: JSON.stringify({ password, signOut }),
    });
}

export function listMfaFactors() {
    return authRequest<{ all: MfaFactor[]; totp: MfaFactor[] }>("/mfa/factors");
}

export function getMfaAssurance() {
    return authRequest<{
        currentLevel: string | null;
        nextLevel: string | null;
    }>("/mfa/assurance");
}

export function enrollMfa(friendlyName: string) {
    return authRequest<{
        id: string;
        totp: { qr_code: string; secret: string };
    }>("/mfa/enroll", {
        method: "POST",
        body: JSON.stringify({ friendlyName }),
    });
}

export function challengeMfa(factorId: string) {
    return authRequest<{ id: string }>("/mfa/challenge", {
        method: "POST",
        body: JSON.stringify({ factorId }),
    });
}

export function verifyMfa(factorId: string, challengeId: string, code: string) {
    return authRequest<unknown>("/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ factorId, challengeId, code }),
    });
}

export function challengeAndVerifyMfa(factorId: string, code: string) {
    return authRequest<unknown>("/mfa/challenge-and-verify", {
        method: "POST",
        body: JSON.stringify({ factorId, code }),
    });
}

export function unenrollMfa(factorId: string) {
    return authRequest<unknown>(
        `/mfa/factors/${encodeURIComponent(factorId)}`,
        {
            method: "DELETE",
        },
    );
}
