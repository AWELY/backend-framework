# 0006. Server-side sessions behind signed tokens

- Status: Accepted
- Since: 1.0.0

## Context

0.1.0 issued stateless HMAC-signed tokens valid for 7 days. Without server state, a token could not
be revoked before it expired:

- logout only deleted the token in the browser;
- a password change did not sign out other devices;
- a stolen token stayed valid for up to a week;
- with staff accounts coming, a dismissed or demoted employee would keep their old access.

## Decision

Tokens stay signed, and every token now points at a row in `auth_sessions`.

- Format (`src/engine/auth-token.ts`): `base64url(payload).base64url(HMAC-SHA256)`. Payload: `sub`
  (account id), `role`, `exp`, `sid` (session id), `pt` (`customer` or `staff`). The payload is
  encoded, not encrypted, so it holds ids only.
- `SessionManager.issue()` (`src/runtime/sessions.ts`) inserts the session (expiry, IP, user agent)
  and signs a token with the same TTL (`tokenTtlSeconds`, default 7 days).
- `createAuthenticator()` (`src/middleware/auth.ts`) verifies the signature against the current and
  previous secrets (constant time), requires a `sid`, then calls `SessionVerifier.verify()`: a
  primary-key lookup that checks principal type and id, `revoked_at IS NULL` and
  `expires_at > now()`.
- The role is resolved on every request: customers are always `customer`; staff roles come from the
  `staff` table and return nothing when the account is inactive. A role change takes effect on the
  next request.
- Revocation: `POST /customers/logout` (this session), `POST /customers/logout-all`, password change
  (all sessions except the current one), password reset (all), staff deactivation, role change or
  password change by the owner (all), `POST /staff/logout`.
- Any invalid credential is a 401 (`INVALID_TOKEN`, message "Invalid or expired token"); it never
  degrades to anonymous access.
- The owner keeps the `X-Api-Key` header, compared in constant time against the current and
  previous keys. It has no session.
- Secret rotation: `AUTH_TOKEN_SECRET_PREVIOUS` and `OWNER_API_KEY_PREVIOUS` (`docs/RUNBOOK.md`).
- `system.cleanup` deletes sessions one day after expiry or 30 days after revocation.

## Consequences

- Logout, "log out everywhere", password change and staff deactivation take effect immediately
  (`tests/integration/security.test.ts`).
- A leaked signing secret alone does not grant access: a forged token still needs the id of a live
  session for that exact account and principal type.
- `GET /customers/me/sessions` can list devices.
- Cost: one indexed lookup per authenticated request, plus one staff-role query for staff.
- Breaking: tokens from 0.1.0 carry no `sid` and are rejected, so every customer logs in again
  after the upgrade (`CHANGELOG.md`).
- Tokens are still bearer credentials. Whoever holds one can use it until it is revoked or expires;
  where the storefront keeps it is a client decision (`docs/THREAT-MODEL.md`, residual risks).

## Alternatives considered

- **Short-lived stateless JWTs plus refresh tokens.** Revocation still lags by the access-token
  lifetime, clients get more complex, and the refresh token needs server state anyway.
- **A JWT library.** One fixed algorithm in 90 lines avoids algorithm-confusion bugs and a
  dependency.
- **Opaque random tokens stored hashed.** Equivalent security. The signed format was kept so garbage
  or tampered tokens are rejected without touching the database, and the token format stays
  familiar to existing clients.
- **Cookie sessions.** The API is headless and cross-origin; cookies would need CSRF protection and
  `SameSite` handling across origins.
- **Sessions in Redis.** See ADR 0002.
