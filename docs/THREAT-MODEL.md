# Threat model

Scope: the Maa framework (`src/`) as deployed by a store: one or more Node.js instances behind a
reverse proxy, one PostgreSQL database, optional payment-provider plugins. The bundled storefront
(`storefront/`) appears only where its choices change the risk of the API.

Method: assets, actors and trust boundaries, then threats by STRIDE category. Every threat names its
mitigation and the test that proves it (`tests/...`, test name in quotes), or states that the
mitigation is documented but not tested. Residual risks are listed at the end without softening.

Last reviewed: 1.0.0.

## System overview

```
Browser / app ──HTTPS──> reverse proxy (TLS, optional rate limiting)
                              │ HTTP, X-Forwarded-For
                              v
                     Maa instance(s): createServer → global middleware → router → modules/plugins
                              │ one pg pool per instance            │ outbound HTTPS (plugin code)
                              v                                     v
                     PostgreSQL (business + runtime tables)   payment provider ──webhook──> Maa
```

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Customer personal data | `customers` (email, name, phone), `orders` (contact name, phone, address) | Privacy, legal exposure |
| Password hashes | `customers.password_hash`, `staff.password_hash` (scrypt) | Credential reuse if cracked |
| Owner API key | `OWNER_API_KEY` env, `X-Api-Key` header | Full control of the store |
| Token signing secret | `AUTH_TOKEN_SECRET` env | Forging tokens (bounded by sessions, see S2) |
| Session tokens | client storage, `auth_sessions` rows | Account takeover while valid |
| Password reset codes | delivered by plugin, SHA-256 in `password_resets` | Account takeover |
| Webhook secrets | plugin configuration | Forged payment confirmations |
| Money and stock integrity | `orders`, `refunds`, `inventory`, `variant_inventory`, `coupons` | Direct financial loss |
| Audit trail | `audit_log`, `order_events` | Accountability, dispute resolution |
| Availability of checkout | the whole stack | Lost sales |

## Actors

| Actor | Capability |
|---|---|
| Anonymous visitor / guest buyer | Public catalogue, guest carts (by UUID), checkout, order lookup with order id + phone |
| Customer | Own profile, sessions, carts and orders |
| Staff: `admin`, `manager`, `support`, `courier` | Permissions from `DEFAULT_ROLES` (`src/engine/access-control.ts`) |
| Owner | Holder of `OWNER_API_KEY`: every permission, the only one with `staff:write` |
| Payment provider | Calls plugin webhook routes |
| Plugin code | Runs in-process with the same privileges as the core |
| Operator | Access to logs, `/metrics`, the database and secrets |
| External attacker | Anything reachable from the internet, including bots and credential stuffing |

## Trust boundaries

1. **Internet to proxy to Maa.** TLS ends at the proxy; Maa speaks plain HTTP. `X-Forwarded-For` is
   trusted only with `TRUST_PROXY=true`, and then only its last entry.
2. **Maa to PostgreSQL.** The database is trusted. Credentials are in `DATABASE_URL`. Everything,
   including runtime state, is in this one database (ADR 0002).
3. **Payment provider to Maa.** Webhooks are untrusted until their signature over the raw body is
   verified (by the plugin, using `verifyWebhookSignature`).
4. **Maa to payment provider.** Outbound calls happen outside database transactions; a failing or
   slow provider must not corrupt orders.
5. **Storefront origin to API.** Cross-origin calls with bearer credentials in headers (no cookies).
   CORS decides which origins may read responses.
6. **Plugins.** Not a boundary: a plugin is trusted code with full database access.

## Assumptions

- The reverse proxy terminates TLS and is the only path to Maa; `/metrics` is either token-protected
  or blocked at the proxy.
- Secrets are generated randomly and stored in a secret manager, not in the repository.
- The database is not reachable from the internet, and its credentials are not shared with other
  applications.
- Plugins come from reviewed sources.

## Threats

### Spoofing

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| S1 | Forged or tampered customer/staff token | HMAC-SHA256 signature over the payload, constant-time comparison, expiry check | `tests/unit/auth-crypto.test.ts` "token: tampering with the payload is detected", "token: wrong secret or expiry makes it invalid", "token: garbage input returns null instead of throwing" |
| S2 | Correctly signed token with no live session (0.1.0 token, leaked secret, guessed session id) | Every token must carry `sid`; the session row must match principal type and id, be unrevoked and unexpired (ADR 0006) | `tests/integration/security.test.ts` "a correctly signed token without a session is rejected (no stateless bypass)" |
| S3 | Stolen token used after logout, password change or reset | Server-side revocation on logout, logout-all, password change (other devices), reset (all devices) | `tests/integration/security.test.ts` "logout revokes only this device; logout-all revokes every device", "changing the password keeps this device and logs out the others", "password reset: same 202 for any email, code delivered by event, single use, sessions revoked" |
| S4 | Dismissed or demoted staff keeps access | Staff role read from `staff` on every request; deactivation, role or password change revokes all sessions | `tests/integration/security.test.ts` "deactivating a staff member or changing their role takes effect immediately" |
| S5 | Owner key guessed or recovered by timing | Startup rejects keys under 32 characters or starting with `change-me`; SHA-256 digests compared with `timingSafeEqual` against every accepted key | `tests/unit/runtime-pieces.test.ts` "config: every problem is reported at once, valid values are parsed"; `tests/integration/security.test.ts` "secret rotation: a new secret still accepts tokens and owner keys signed with the previous one" (wrong key is 401) |
| S6 | Password guessing / credential stuffing on login | Per-IP and per-email failure limit (10 per 15 min), checked before scrypt, shared by all instances; 429 with `Retry-After` | `tests/integration/login-rate-limit.test.ts` (all four tests); `tests/integration/multi-instance.test.ts` "rate limits are shared across instances". Staff login uses the same limiter with separate keys: documented in `src/modules/staff/index.ts`, not separately tested |
| S7 | Account enumeration through login | Identical 401 `INVALID_CREDENTIALS` and a dummy scrypt verification for unknown emails | `tests/integration/customers.test.ts` "login: right password works; wrong password and unknown email give the SAME 401" |
| S8 | Reset-code guessing or enumeration through password reset | 32 random bytes, stored as SHA-256, 30-minute lifetime, single use; always 202; limited to 5 per hour per IP and per email | `tests/integration/security.test.ts` "password reset: same 202 for any email, code delivered by event, single use, sessions revoked". The reset rate limit is documented (`src/app.ts`), not tested |
| S9 | Forged payment webhook marks an order paid | HMAC-SHA256 over `timestamp.rawBody`, constant time, several secrets during rotation; `req.rawBody` kept byte for byte | `tests/integration/third-party.test.ts` "hosted gateway: redirect on checkout, signed webhook marks paid, forged or replayed webhooks are harmless"; `tests/unit/runtime-pieces.test.ts` "webhook signatures: valid, tampered, expired, rotated secrets"; `tests/integration/hardening.test.ts` "raw body is kept byte for byte for webhook signatures" |
| S10 | Spoofed `X-Forwarded-For` to dodge rate limits | Header ignored unless `trustProxy`; then only the last entry (written by our proxy) | `tests/unit/rate-limiter.test.ts` "clientIp: socket address by default; X-Forwarded-For ignored unless trustProxy", "clientIp with trustProxy takes the LAST X-Forwarded-For entry (the one our proxy added)" |
| S11 | Guest reads another person's order | Order UUID plus the phone number recorded on the order; anything else is 404 | `tests/integration/cart-orders.test.ts` "guest order lookup needs the matching phone; others get 404" |

### Tampering

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | SQL injection | Every value is a `$n` parameter; table names, columns and `ORDER BY` are constants; sort is an enum; `LIKE` wildcards escaped (ADR 0003) | Documented in `src/db/repository.ts`; sort and search exercised by `tests/integration/hardening.test.ts` "lists carry X-Total-Count; search, sort and strict pagination". No dedicated injection test |
| T2 | Mass assignment (`price`, `role`, `customerId` in a body) | Unknown fields rejected at every nesting level; only schema fields reach handlers; staff role must be a staff role | `tests/unit/validation.test.ts` "unknown fields are rejected (mass-assignment protection)"; `tests/unit/validation-v2.test.ts` "nested objects and arrays are validated, with full paths in errors"; `tests/integration/security.test.ts` "staff roles: ..." (role `owner` is 400) |
| T3 | Prototype pollution or prototype-named roles | `Object.hasOwn` in the validator and in `AccessControl.can` | `tests/unit/validation-v2.test.ts` "inherited property names are not mistaken for schema fields (constructor, __proto__)"; `tests/unit/runtime-pieces.test.ts` "access control: unknown and prototype role names have no permissions" |
| T4 | Client-chosen prices or totals | The checkout body has no price fields; prices read from the database inside the transaction; plugin results checked (non-negative integers); CHECK constraints on totals and line totals | `tests/integration/cart-orders.test.ts` "order keeps the price paid even if the product is repriced later"; `tests/integration/commerce-v2.test.ts` "coupons and tax: priced in the quote, stored on the order, redemptions counted and released on cancel" |
| T5 | Overselling or negative stock under concurrency | Conditional atomic `UPDATE`; checkout all-or-nothing in one transaction; fixed lock order (ADR 0011) | `tests/integration/concurrency.test.ts` (all four tests); `tests/integration/inventory.test.ts` "concurrency: 10 simultaneous buyers, 5 in stock -> exactly 5 succeed, stock ends at 0"; `tests/integration/cart-orders.test.ts` "checkout is all-or-nothing: if one line is short, nothing is sold" |
| T6 | Duplicate orders from double clicks or retries | Cart row locked `FOR UPDATE` and marked `checked_out`; optional `Idempotency-Key` replays the first response and rejects a different body | `tests/integration/concurrency.test.ts` "the same cart checked out 5 times at once: one order, four CART_CHECKED_OUT"; `tests/integration/hardening.test.ts` "Idempotency-Key: a retry returns the original order; a different body with the same key is refused" |
| T7 | Illegal order or payment state changes (paid back to pending, manual "refunded") | Status and payment state machines; refunds only through `POST /orders/:id/refunds`; repeating the current payment status is a no-op | `tests/integration/hardening.test.ts` "payment status follows its state machine; repeating the same status is a no-op"; `tests/integration/cart-orders.test.ts` "status: only allowed transitions; only the owner; cancelling restocks" |
| T8 | Refunding more than was paid, or double refunds | Order row locked; amount reserved in `refunded_total` before the provider call; CHECK `refunded_total <= total`; provider failure releases the reservation | `tests/integration/commerce-v2.test.ts` "refunds: partial with restock, never more than paid, gateway failure changes nothing" |
| T9 | Lost update when two staff edit one product | `ETag` / `If-Match`, 412 on a stale version (ADR 0013) | `tests/integration/hardening.test.ts` "optimistic concurrency: ETag on read, 412 for a stale If-Match, success with the current one" |
| T10 | Replay of a captured valid webhook | Signature timestamp tolerance (300 s); payment transitions are idempotent | `tests/integration/third-party.test.ts` "hosted gateway: ... forged or replayed webhooks are harmless"; `tests/unit/runtime-pieces.test.ts` "webhook signatures: valid, tampered, expired, rotated secrets" |
| T11 | Another user modifies a customer's cart | Customer carts: owner of the cart or the store owner only, otherwise 404; staff roles lack `cart:manage` | `tests/integration/cart-orders.test.ts` "customer: cart is private, orders are linked to the account and listed" |
| T12 | Coupon used beyond its limit | Redemption counted once per order (keyed by order id), released on cancel. The limit is soft (see residual risks) | `tests/integration/commerce-v2.test.ts` "coupons and tax: priced in the quote, stored on the order, redemptions counted and released on cancel" |

### Repudiation

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| R1 | Owner or staff denies making a change | Automatic `audit_log` row for every `POST`/`PUT`/`PATCH`/`DELETE` by owner or staff: actor, route, params, redacted body, status, request id, IP. Staff logins (success and failure) audited. Readable with `audit:read` | `tests/integration/security.test.ts` "audit log records who changed what, with secrets redacted, including failed staff logins" |
| R2 | Disputes over what happened to an order | `order_events` timeline with actor type for every status, payment, refund and delivery change | `tests/integration/commerce-v2.test.ts` "delivery: assign, pickup, deliver with cash collection; couriers only touch their own; full timeline" |

### Information disclosure

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| I1 | Stack traces or SQL details in responses | Non-`AppError` errors become a generic 500 `INTERNAL_ERROR`; stack logged server-side with the request id; PostgreSQL `detail` never forwarded (constraint name only) | Documented in `src/engine/errors.ts` and `src/db/errors.ts`. No test forces a 500 |
| I2 | Personal data or secrets in logs | Request log writes the path without the query string; logger redacts keys matching password, secret, token, authorization, api key, cookie, signature; audit bodies redacted the same way | `tests/integration/operations.test.ts` "JSON request logs carry the request id and route, and never the query string"; `tests/unit/runtime-pieces.test.ts` "logger: JSON lines with bindings from child loggers, and sensitive fields redacted"; `tests/integration/security.test.ts` audit test (`password` is `[REDACTED]`) |
| I3 | Password hash returned by the API | API types exclude `password_hash`; credentials read by separate repository methods | `tests/integration/customers.test.ts` "register returns the customer (never the password hash) and a token" |
| I4 | Offline cracking after a database leak | scrypt (N=16384, r=8, p=1), 16-byte random salt per password, parameters stored with the hash | `tests/unit/auth-crypto.test.ts` "password: same password hashes differently each time (random salt)" |
| I5 | Reset codes readable at rest | Stored as SHA-256; the outbox payload carrying the code is nulled once delivered or dead | `tests/integration/security.test.ts` "password reset: ..." (asserts the delivered payload is `NULL`) |
| I6 | Learning that another customer's cart or order exists | 404, never 403, for resources the caller may not see | `tests/integration/cart-orders.test.ts` "guest order lookup needs the matching phone; others get 404", "customer: cart is private, orders are linked to the account and listed" |
| I7 | Metrics reveal traffic and routes | `METRICS_TOKEN` bearer check (constant time) or block at the proxy; labels use route patterns, never raw ids | `tests/integration/operations.test.ts` "metrics need the token, and label routes by their pattern, not the raw URL" |
| I8 | Authenticated responses cached by a browser or proxy | `Cache-Control: no-store` whenever `Authorization` or `X-Api-Key` is present | `tests/integration/hardening.test.ts` "security headers on every response; authenticated responses are not cached" |
| I9 | Another website reads API responses in a victim's browser | CORS allowlist, one reflected origin with `Vary: Origin`; credentials are headers, not cookies, so there is no ambient authority (no CSRF) | `tests/integration/hardening.test.ts` "CORS with several origins reflects the allowed origin only, with Vary: Origin"; `tests/integration/cors.test.ts` |
| I10 | API response rendered as HTML or framed | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, optional HSTS | `tests/integration/hardening.test.ts` "security headers on every response; authenticated responses are not cached" |
| I11 | Token theft through XSS in the storefront | Storefront renders data with `textContent`, CSP `script-src 'self'`; API rejects `javascript:` and `data:` image URLs | `tests/integration/storefront-features.test.ts` "product images: full URL or site path accepted, dangerous or relative-less values rejected"; XSS probe in `storefront/tests/browser.mjs` (step 10) |
| I12 | Log injection through `X-Request-Id` | Accepted only if it matches `[A-Za-z0-9._:-]{1,128}`, otherwise replaced by a UUID | `tests/integration/hardening.test.ts` "every error has a code and the request id; a valid incoming X-Request-Id is kept" |
| I13 | `AUTH_TOKEN_SECRET` leaks | Forgery still needs a live session id (S2); rotation with `AUTH_TOKEN_SECRET_PREVIOUS`; mass revocation in SQL (`docs/RUNBOOK.md`) | `tests/integration/security.test.ts` "secret rotation: ..."; `tests/unit/runtime-pieces.test.ts` "tokens: previous secrets still verify; session claims survive the round trip" |

### Denial of service

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| D1 | Huge request bodies exhaust memory (a 30 MB body used to add 128 MB RSS) | `Content-Length` checked before reading; bytes counted while streaming; 413 and connection close (`BODY_LIMIT_BYTES`, default 1 MiB) | `tests/integration/hardening.test.ts` "a body over the limit is rejected with 413, whether declared or streamed" |
| D2 | Slow clients hold connections (slowloris) | `requestTimeout` 30 s, `headersTimeout` 15 s, `keepAliveTimeout` 5 s | Documented in `src/app.ts`. Not tested |
| D3 | Password hashing used to burn CPU | Limits checked before scrypt; password length capped at 128; invalid bodies rejected before counting | `tests/integration/login-rate-limit.test.ts` "blocked attempts are answered fast (no password hashing)"; `tests/integration/registration-rate-limit.test.ts` "invalid bodies are rejected before counting (typos do not use up the limit)", "a duplicate email still counts - it costs a password hash too" |
| D4 | Mass account creation | 5 registrations per hour per IP, atomic `consume` | `tests/integration/registration-rate-limit.test.ts` "burst: 10 simultaneous registrations from one IP -> exactly 5 created" |
| D5 | Stock held by unpaid online orders | Payment holds: unpaid online orders cancelled and restocked after the provider's `holdSeconds` | `tests/integration/commerce-v2.test.ts` "payment holds: an unpaid online order is cancelled after its hold and its stock comes back" |
| D6 | Checkout or cart-creation floods | Optional per-IP limits (`checkoutRateLimit`, `cartCreationRateLimit`), off by default; proxy-level limits recommended | Documented in `src/app.ts` and `docs/RUNBOOK.md`. Not tested |
| D7 | Runaway queries or forgotten transactions exhaust the pool | `statement_timeout`, `idle_in_transaction_session_timeout`, connection timeout; timeouts become 503 | Documented in `src/db/connection.ts`, `src/db/errors.ts`. Not tested |
| D8 | Deadlocks under concurrent checkout | Fixed lock order plus automatic retry, then 503 `TRANSACTION_CONFLICT` | `tests/integration/concurrency.test.ts` "500 concurrent checkouts over the same two products: 0 server errors, stock reconciles exactly" |
| D9 | Malformed URLs or bodies crash a request | 400 `MALFORMED_URL` / `MALFORMED_JSON`; every error goes through one handler | `tests/integration/hardening.test.ts` "malformed URL encoding is a 400 with code MALFORMED_URL"; `tests/unit/router-v2.test.ts` "fuzz: random paths either match, miss, or raise ValidationError"; `tests/unit/validation-v2.test.ts` "fuzz: any JSON value either validates or throws ValidationError, never anything else" |
| D10 | Metric label explosion | Labels are route patterns; unmatched paths are `unmatched`; unknown methods are `OTHER` | `tests/integration/operations.test.ts` "metrics need the token, and label routes by their pattern, not the raw URL" |
| D11 | Rate-limit storage exhausted by key cycling | Memory store capped by `maxKeys`; Postgres store cleaned hourly | `tests/unit/rate-limiter.test.ts` "memory stays bounded when an attacker cycles through many keys". Postgres store: documented, see residual risks |
| D12 | Slow or failing plugins block or break checkout | Listeners run after commit through the outbox; failures retried per listener; payment failure saves the order as `failed` | `tests/integration/operations.test.ts` "outbox: a failing listener is retried alone; the one that succeeded is not called twice"; `tests/integration/plugins.test.ts` "a failing payment plugin does not lose the order: it is saved with paymentStatus 'failed'"; `tests/integration/multi-instance.test.ts` "each event reaches each listener exactly once with two workers running, even when one instance stops" |

### Elevation of privilege

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| E1 | Customer or guest calls staff or owner routes | Authentication then `requirePermission` on every protected route (RBAC); 401 vs 403 | `tests/unit/access-control.test.ts` "unknown role or anonymous caller gets nothing"; `tests/integration/catalog.test.ts` "writes require authentication and valid input"; `tests/integration/inventory.test.ts` "stock writes are owner-only; negative absolute stock is a 400" |
| E2 | Staff creates a more privileged account | `staff:write` is owner-only; roles limited to staff roles (`owner`, `customer` rejected) | `tests/integration/security.test.ts` "staff roles: admin manages the catalogue but not staff; support cannot refund; courier sees no orders list" |
| E3 | Courier acts on another courier's deliveries or reads all orders | `deliveries:read-own`, `deliveries:update-own`; no `orders:read-all` | `tests/integration/commerce-v2.test.ts` "delivery: assign, pickup, deliver with cash collection; couriers only touch their own; full timeline"; `tests/integration/security.test.ts` "staff roles: ..." |
| E4 | A wrong credential silently becomes anonymous access | Any invalid key or token is 401, even on routes that allow guests | Documented in `src/middleware/auth.ts`; `tests/integration/security.test.ts` "secret rotation: ..." (wrong key is 401), "logout revokes only this device; ..." (revoked token is 401 `INVALID_TOKEN`) |
| E5 | Misconfigured or malicious plugin | Startup checks of unique names, `dependsOn` and `configSchema`; bundled examples restricted to the public API by lint; `npm audit` in CI | `tests/integration/third-party.test.ts` "plugin contract: dependencies, config validation and unique names are checked at startup"; `tests/integration/plugins.test.ts` "duplicate provider ids are rejected at startup". No sandbox: see residual risks |
| E6 | Weak secrets deployed to production | `loadConfig` refuses short or example secrets and reports every problem at once | `tests/unit/runtime-pieces.test.ts` "config: every problem is reported at once, valid values are parsed" |

## Residual risks

Accepted or not yet addressed. Each is a deliberate trade-off or a known gap, not an oversight.

1. **Tokens in browser storage.** The Maa Store storefront keeps customer and staff tokens in
   `localStorage` (the owner key in `sessionStorage`). Any script running on the storefront origin
   can read them. CSP and text-only rendering reduce the chance of such a script; they do not remove
   the exposure. `httpOnly` cookies would, but need CSRF protection across origins.
2. **Coupon redemption limit is soft.** Redemptions are counted by an `order.created` listener after
   commit, and the adjuster reads the coupon outside the checkout transaction, so concurrent checkouts
   can pass the last redemption together (`src/plugins/coupons.ts`).
3. **Per-request session lookup.** Every authenticated request costs a primary-key query (two for
   staff). A database outage blocks all authenticated traffic; at very high request rates this is
   the first query to cache, which would weaken immediate revocation.
4. **At-least-once events.** Listeners can see an event twice and in any order relative to other
   events. Listeners must deduplicate by `meta.id`. Listener identity is its registration index,
   so reordering listeners between deploys can skip or repeat a listener for events mid-retry.
5. **Login limiter race.** Login checks the counter, verifies the password, then records a failure.
   A parallel burst can exceed the threshold by the burst's concurrency.
6. **Account enumeration through registration.** Registering an existing email returns 409
   `DUPLICATE_VALUE`. Rate-limited to 5 per hour per IP; not hidden.
7. **Password reset timing.** The 202 response is identical, but a known email does extra database
   work, so response time can hint that the account exists.
8. **Password change shares the login limiter.** `POST /customers/me/password` and
   `POST /staff/me/password` count wrong current passwords against the login limit (per account),
   tested in `tests/integration/review-fixes.test.ts` "guessing the current password is rate limited
   like logins". With `loginRateLimit: false` there is no limit.
9. **Shared owner key.** One secret, no per-person attribution (`actor_id` is null for the owner in
   the audit log), no MFA. People should use staff accounts; the owner key belongs in automation.
10. **Phone number in the guest tracking URL.** `?phone=` is stripped from Maa's logs, but proxies,
    CDNs and browser history record full URLs.
11. **Guest carts are bearer UUIDs.** Whoever learns a guest cart id can read and change it, and
    claim it into their account at login.
12. **Cash-on-delivery stock reservation.** Orders without an online payment hold reserve stock until
    staff cancel them, and checkout rate limits are off by default.
13. **Public operational endpoints.** `/metrics` is public when `METRICS_TOKEN` is empty;
    `/openapi.json`, `/health`, `/livez` and `/readyz` are always public.
14. **Audit log is not tamper-evident.** Anyone with database write access can alter it, and the row
    is written after the response; a write failure is logged, not retried.
15. **Plugins are fully trusted.** In-process, with the shared pool; there is no permission model for
    plugin code.
16. **Late payment after a hold expired.** If the provider confirms payment after
    `orders.releaseExpiredHolds` cancelled the order, the payment is recorded (the money did arrive),
    the order stays `cancelled`, the timeline says "Paid after the order was cancelled: refund it" and a
    warning is logged. Staff must issue the refund (`POST /orders/:id/refunds`); it is not automatic.
    Tested in `tests/integration/review-fixes.test.ts`.
17. **TLS is outside Maa.** HSTS is opt-in (`HSTS=true`) and must only be enabled behind HTTPS.
18. **Postgres rate-limit table growth.** Key cycling grows `rate_limits` until the hourly cleanup.

## Fixed after the first review

- Idempotency keys are scoped by the real request path (which contains the order id), not the route
  pattern, so one key reused on two orders' refunds runs both.
- Refund restock quantities are reserved before the provider is called; a concurrent cancel cannot
  double-restock, and a refused refund releases both the amount and the reserved quantities.
- Online orders get their payment deadline inside the checkout transaction, so a crash before payment
  initiation cannot leave stock held forever.
- A database outage returns `503 DATABASE_UNAVAILABLE` with `Retry-After`, not `500`.
- Migrations run without `statement_timeout`; `SHUTDOWN_DELAY_MS` lets load balancers notice `/readyz`
  before connections are refused.

All are tested in `tests/integration/review-fixes.test.ts`.

## Mitigations that are documented but not tested

D2 (server timeouts), D6 (checkout and cart-creation limits), D7 (statement and idle timeouts), I1
(generic 500 body), the password-reset rate limit (S8), the staff-login limiter keys (S6), retry
exhaustion to 503 `TRANSACTION_CONFLICT` (D8), and the `rateLimitStore: "memory"` option. These are
candidates for the next tests.

## Keeping this document current

Update it in the same pull request as any change to authentication, authorization, input handling,
money flows, plugin contracts or deployment defaults. A new threat row must name a mitigation and a
test, or be listed above as untested.
