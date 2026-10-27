# Authentication

Sign-in, sessions, OAuth, MFA and the Word add-in handoff. Auth talks to
GoTrue; the application database is not involved.

## What the surface does

- **Credentials:** email/password login and signup. Passwords are at least 8
  characters; login is rate-limited per IP and per account.
- **Sessions:** the browser holds an HttpOnly cookie managed by
  `lib/authSession`; `GET /auth/session` returns the signed-in user and
  `POST /auth/logout` clears the cookies.
- **OAuth and SSO:** `POST /auth/oauth` starts an upstream flow and
  `POST /auth/exchange` redeems its code. `SSO_ENABLED` and
  `SSO_ALLOWED_DOMAINS` constrain which email domains may authenticate.
- **Word add-in:** `POST /auth/handoff` and the exchange endpoint issue and
  redeem a short-lived, encrypted handoff ticket, so the add-in gets its own
  session without sharing the web app's cookie.
- **Account changes:** `PATCH /auth/email` and `PATCH /auth/password` (the
  password change can sign out other sessions).
- **MFA:** TOTP factors can be listed, enrolled, challenged and verified under
  `/auth/mfa/*`. When a user enables MFA on login, `requireAuth` requires a
  verified factor for every route except the bootstrap ones; mutating `/user`
  routes additionally use `requireMfaIfEnrolled` as a step-up guard.
- **Password reset:** `POST /auth/password-reset`.

Deployment settings and the GoTrue service are in
[Manual and production deployment](deployment.md); local accounts and email
capture are in [Local development](local-development.md).

State as of 2026-10-27; re-read `backend/src/modules/auth/` and
`backend/src/middleware/auth.ts` before relying on the route list.
