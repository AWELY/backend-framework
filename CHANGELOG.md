# Changelog

All notable changes to Maa. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/); what counts as breaking is defined in
[`docs/VERSIONING.md`](docs/VERSIONING.md).

## [1.0.0] - Unreleased

The production hardening of the graduation-project baseline, in five phases: correctness, API
contract, security, operations, extensibility and domain (`docs/ROADMAP.md`). Decisions behind the
larger changes are recorded in [`docs/adr/`](docs/adr/README.md).

### Breaking changes

Read these before upgrading a 0.1.0 store.

- **Package renamed** from `commerce-framework` to `maa`; the CLI binary from `commerce-cli` to
  `maa`. Change `require("commerce-framework")` to `require("maa")` and the dependency name in
  `package.json`.
- **Tokens now require a server-side session.** Every token must carry a session id (`sid`) that
  matches a live row in `auth_sessions` (ADR 0006). Tokens issued by 0.1.0 have none and are rejected
  with 401 `INVALID_TOKEN` ("Invalid or expired token"), so **every logged-in customer must log in
  again** after the upgrade. Clients that clear the stored token on that error (as the storefront
  does) recover on their own.
- **`ModuleContext.issueCustomerToken(customerId, req?)` is async** and returns `Promise<string>`,
  because it creates a session row. Add `await`.
- **`ModuleContext.loginLimiter` and `registrationLimiter` are typed `Limiter | null`** (were
  `FailureLimiter | null`). `Limiter` methods may return promises, so `await` every call. The default
  store is now PostgreSQL; pass `rateLimitStore: "memory"` for the old in-process behaviour.
- **`PATCH /orders/:id/payment` accepts only `pending`, `paid` or `failed`**, and only transitions
  allowed by the payment state machine; anything else is 409 `INVALID_PAYMENT_TRANSITION` (an
  unlisted value is 400). Refunds go through **`POST /orders/:id/refunds`**, which records the amount
  and sets `partially_refunded` or `refunded`. Repeating the current status is a 200 no-op without an
  event. `PaymentStatus` gains `partially_refunded`.
- **Event listeners run asynchronously after commit**, delivered by the transactional outbox
  (ADR 0007), instead of inline before the response. A listener can no longer affect or delay the
  HTTP response, may run on another instance, may be called more than once for the same event
  (deduplicate by `meta.id`), and receives `EventMeta` as a second argument. Tests that inspect
  listener effects right after a request should `await app.drainBackgroundWork()` first.
- **`order.created` carries the order before payment starts** (`paymentStatus` is `unpaid`). The
  payment outcome arrives in `order.paymentChanged`. Listeners that read the payment status from
  `order.created` must move to `order.paymentChanged`.
- **Invalid pagination parameters return 400** `VALIDATION_FAILED` (`limit` outside 1-100, negative or
  non-integer `offset`) instead of silently falling back to the defaults.
- **`GET /carts/mine` returns 204 with no body** when the logged-in customer has no open cart. In
  0.1.0 the same path matched `GET /carts/:id` and returned 404.
- **`withTransaction` re-runs the work function** on deadlock or serialization failure (up to 3
  retries, then 503 `TRANSACTION_CONFLICT`). Custom code must not perform external side effects
  (HTTP calls, emails) inside it.
- **`loadConfig()` rejects values it used to accept silently**, for example `TRUST_PROXY=yes`,
  `PORT=abc`, `LOG_LEVEL=verbose`, a `CORS_ORIGIN` entry with a path, or an `API_BASE_PATH` with a
  trailing slash. Fix `.env` before upgrading; every problem is reported in one error.
- **`int8` values read through the framework's pool are numbers**, not strings (ADR 0005). Custom
  SQL that relied on `COUNT(*)` or `BIGINT` columns arriving as strings must be updated.

### Added

HTTP engine and API contract

- Request body limit (`BODY_LIMIT_BYTES`, default 1 MiB): `Content-Length` checked before reading,
  bytes counted while streaming, 413 `PAYLOAD_TOO_LARGE`.
- Raw request bytes on `req.rawBody`, for webhook signatures.
- `X-Request-Id`: a valid incoming id is kept, otherwise a UUID is generated; echoed on the response,
  added to every log line and to every error body.
- Machine-readable `error.code` (`ErrorCodes`) and `error.requestId` on every error. New error
  classes: `MethodNotAllowedError`, `PreconditionFailedError`, `PayloadTooLargeError`,
  `BadGatewayError`, `ServiceUnavailableError`.
- 405 with `Allow` for a known path with the wrong method; `HEAD` served by `GET` routes.
- `basePath` option (`API_BASE_PATH`, for example `/v1`); system routes stay at the root.
- Validator v2: nested objects, arrays, `nullable`, query and route-parameter validation with
  coercion (`validateQuery`), and `withInput()` typed handlers (ADR 0004).
- `Idempotency-Key` on `POST /orders` and `POST /orders/:id/refunds`, with `Idempotency-Replayed: true`
  on replays, 409 `IDEMPOTENCY_IN_PROGRESS` and `IDEMPOTENCY_KEY_REUSED`.
- Optimistic concurrency on products and categories: `ETag`, `If-Match`, 412 `PRECONDITION_FAILED`
  (ADR 0013).
- `X-Total-Count` on list endpoints; product search (`q`) and sort; order filters (`status`,
  `paymentStatus`, `q`); customer and staff search.
- OpenAPI 3.1 generated from route schemas: `GET /openapi.json`, `docs/openapi.json`,
  `npm run openapi` and `npm run openapi:check`.

Security

- Server-side sessions (`auth_sessions`, `SessionManager`): `POST /customers/logout`,
  `POST /customers/logout-all`, `GET /customers/me/sessions`.
- Password change (`POST /customers/me/password`, signs out other devices) and password reset
  (`POST /customers/password-reset`, `POST /customers/password-reset/confirm`). The code reaches the
  customer through the `customer.passwordResetRequested` event, so a plugin sends the email or SMS.
- Staff accounts with roles `admin`, `manager`, `support`, `courier` (`/staff` routes), managed by the
  owner only (`staff:write`). Role changes and deactivation take effect immediately.
- Automatic audit log of every owner and staff write, plus staff logins; `GET /audit-log` with
  `audit:read`.
- Secret rotation: `OWNER_API_KEY_PREVIOUS` and `AUTH_TOKEN_SECRET_PREVIOUS`.
- `verifyWebhookSignature()`, `signWebhookPayload()`, `hmacSha256Hex()`, `safeEqual()`.
- `securityHeaders()` middleware and the `HSTS` option; CORS with several origins.

Operations

- JSON logs (`LOG_FORMAT`, default `json` in production) with child loggers and redaction of
  sensitive fields.
- Prometheus `GET /metrics` (`METRICS_TOKEN` optional): request counts and latency histogram by route
  pattern, pool gauges, event-loop lag, memory, outbox and job counters.
- `GET /livez` and `GET /readyz` (503 while shutting down, with pending migrations, or without a
  database). `/health` is unchanged.
- `installShutdownHandlers()` and `SHUTDOWN_TIMEOUT_MS`; HTTP server timeouts.
- Pool settings: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`,
  `DB_CONNECTION_TIMEOUT_MS`.
- `pendingMigrations()`; `CommerceApp.migrate()` and `pendingMigrations()`.
- Transactional outbox with a background worker in every instance (ADR 0007).
- PostgreSQL job queue with recurring jobs (ADR 0008): `system.cleanup` (hourly),
  `orders.releaseExpiredHolds` (every minute), `cart.cleanupAbandoned` (daily).
- `PostgresLimiter` (ADR 0010); new limits on password reset (on by default), checkout and cart
  creation (opt-in).
- `Dockerfile`, `docker-compose.yml`, GitHub Actions CI (`.github/workflows/ci.yml`).

Extensibility and domain

- Plugin contract: `version`, `dependsOn`, `configSchema` and `config` validated at startup, `onStart`
  and `onStop`; modules may define `onStart` and `onStop` too.
- Events with metadata (`EventMeta`: id, version, time, attempt) and new events: `order.refunded`,
  `order.deliveryChanged`, `product.created`, `product.updated`, `product.deleted`,
  `inventory.changed`, `customer.registered`, `customer.passwordResetRequested`.
- Pricing adjusters (`PriceAdjuster`): discounts, tax and fees computed at checkout and stored on the
  order (`adjustments`, `adjustmentsTotal`).
- Product variants with SKU, price override and their own stock; `GET /products/by-slug/:slug`.
- Payment holds: `PaymentProvider.holdSeconds`; unpaid online orders are cancelled and restocked when
  the hold expires.
- Refunds: partial, optional restock, provider refund hook (`PaymentProvider.refund`), two-phase so
  money is never refunded twice.
- Order timeline (`order_events`, `GET /orders/:id/events`).
- Delivery module: courier assignment, pickup, delivery with cash collection, failed attempts.
- Guest cart merged into the customer's cart at registration and login (`guestCartId`);
  `GET /carts/mine`.
- `currency` on orders (`CURRENCY`).
- Bundled plugins `coupons()` and `percentageTax()`.
- Third-party examples built only on the public API: `examples/plugins/hosted-gateway.ts` and
  `examples/plugins/cached-products.ts` (a repository replaced through the DI container).

Tooling and documentation

- `npm run lint` (`scripts/lint.js`: layer rules, no request-input casts, no `any`, no `console`, no
  `.only`), `npm run check`, coverage gate (lines 90%, branches 80%, functions 75%).
- The test suite grew from 77 to 156 tests on a real PostgreSQL, including 500 concurrent
  checkouts, two instances sharing one database, and router and validator fuzzing.
- `docs/ARCHITECTURE.md`, `docs/EXTENDING.md`, `docs/EXAMPLES.md`, `docs/RUNBOOK.md`,
  `docs/THREAT-MODEL.md`, `docs/VERSIONING.md`, `docs/adr/`, `CONTRIBUTING.md`.
- `SHUTDOWN_DELAY_MS` / `shutdownDelayMs`: keep accepting connections for a moment after `/readyz`
  turns 503, so load balancers stop routing first.
- Password change counts wrong current passwords against the login limiter.

### Changed

- Money columns are `BIGINT` (migrations 0910, 0911), returned as JSON numbers; a value above 2^53 - 1
  raises an error instead of losing precision.
- Order totals are `subtotal + shippingCost + adjustmentsTotal`, enforced by CHECK constraints.
- Rate-limit counters live in PostgreSQL by default and are shared by all instances.
- Limits that count every attempt (registration, password reset, checkout, cart creation) use an
  atomic `consume()`.
- The request log writes the path without the query string.
- Deadlocks and serialization failures are retried, then answered 503 `TRANSACTION_CONFLICT` with
  `Retry-After` (were 500); statement timeouts are 503 `QUERY_TIMEOUT`.
- Every response carries security headers, including `Content-Security-Policy: default-src 'none'`,
  which also applies to custom routes added to the router. Requests with `Authorization` or
  `X-Api-Key` get `Cache-Control: no-store`.
- CORS exposes `X-Request-Id`, `X-Total-Count`, `ETag`, `Retry-After` and `Idempotency-Replayed`, and
  allows the `Idempotency-Key`, `If-Match` and `X-Request-Id` request headers.
- A known path with the wrong method is 405 (was 404).
- The validator rejects unknown fields at every nesting level.
- `/health` moved to the system router: same response, and it stays at the root under `basePath`.
- The storefront is renamed from "AMA" to **Maa Store** (متجر ماء) and rebuilt with customer,
  courier and admin sides.

### Fixed

- Checkout deadlocks: with opposite product order, 51 to 54 of 60 concurrent checkouts failed with
  500 "deadlock detected". Stock rows are now locked in a fixed order (`byStockLockOrder`) and
  conflicts are retried: 500 concurrent checkouts finish with 0 errors and stock reconciles exactly.
  Cancellation and refund restock use the same order.
- Unbounded request bodies: a 30 MB body was buffered whole (RSS grew by 128 MB). Now 413.
- Malformed percent-encoding in a URL is 400 `MALFORMED_URL` (was 500).
- `PATCH` can clear a field: `null` on a nullable field (for example `categoryId`) is written.
- The guest tracking phone number (`?phone=`) no longer appears in request logs.
- Payment status could be set to any value in any order, and a repeated webhook emitted a second
  event; it now follows a state machine and repeats are no-ops.
- Field names such as `constructor` were accepted by the validator as if they were schema fields
  (`in` operator); now checked with `Object.hasOwn`.
- An idle database connection dropping (for example on a database restart) crashed the process; the
  pool's `error` event is now handled and logged.

- Idempotency keys are scoped by the real request path, so one key reused on two orders' refunds
  runs both instead of replaying the first.
- Refund restock quantities are reserved before the payment provider is called and released if it
  refuses; a concurrent cancel can no longer restock the same items twice or fail the refund after
  the money moved. Failed-refund cleanup is atomic.
- Online orders get their payment deadline inside the checkout transaction, so a crash before payment
  initiation cannot hold stock forever.
- A payment confirmed after its order was cancelled is recorded and flagged in the timeline for a refund.
- A database outage returns `503 DATABASE_UNAVAILABLE` with `Retry-After` instead of `500`.
- Order lines keep a stable order (`line_no`) after restock updates.
- Migrations run without `statement_timeout`.
- Coupons: a duplicate code returns `409 DUPLICATE_VALUE`; an out-of-range percent or invalid date
  returns `400` instead of `500`.
- The storefront's demo card gateway is installed only in `DEMO_MODE`.

### Security

- Sessions are revocable: logout, logout everywhere, password change and reset, staff deactivation
  and role changes take effect immediately.
- Owner key compared in constant time (SHA-256 digests with `timingSafeEqual`); was `===`.
- Password-reset codes are random 32-byte values stored as SHA-256, single use, valid 30 minutes; the
  request answers 202 for any email; the outbox payload holding the code is erased after delivery.
- Staff roles follow least privilege; only the owner manages staff.
- Audit trail for every privileged write, with secrets redacted.
- Webhook signature helper with timestamp tolerance and secret rotation.
- Body size limit, strict `X-Request-Id` format, CORS `Vary: Origin`, security headers, optional
  metrics token.
- CI runs `npm audit --omit=dev --audit-level=high`.

### Upgrade notes

1. Rename the dependency and fix `.env` (see "Breaking changes").
2. Run migrations before starting the new version: `0900_runtime_tables`, `0910` to `0990`, and
   `1100_coupons` if you install the coupons plugin. Use your store's migration script, which builds
   the app with your plugins. `0910` and `0911` rewrite the `products`, `orders` and `order_items`
   tables under an exclusive lock: run them in a quiet window. `/readyz` answers 503 until every
   migration is applied (`docs/RUNBOOK.md`).
3. Expect every customer to log in again.
4. Review custom listeners (idempotency, `order.created` payment status), custom `withTransaction`
   work, and any code that sets payment status to `refunded`.

## [0.1.0] - 2026-11-01

The graduation-project baseline (College of Electronic Technology, Tripoli), published as
`commerce-framework`.

- Own HTTP server, router and middleware pipeline on `node:http`; central error handler with
  `{ "error": { "message", "details" } }` bodies.
- Schema validator for flat request bodies, rejecting unknown fields.
- Dependency-injection container, configuration loader (secrets of at least 32 characters), text
  logger, role-based access control with `owner` and `customer` roles.
- Modules: categories, products (with image URLs), inventory (atomic stock adjustments), customers
  (scrypt passwords, stateless HMAC tokens), carts (guest and customer), orders (checkout in one
  transaction, status state machine, guest order lookup by phone).
- Plugins: `cashOnDelivery`, `flatRateShipping`, `cityRateShipping`; events dispatched inline through
  `ExtensionRegistry.emit`.
- In-memory rate limits for login (10 failures per 15 minutes per IP and per email) and registration
  (5 per hour per IP).
- Migration runner with an advisory lock (migrations `0100` to `0810`), money as `INTEGER` minor
  units.
- CLI `commerce-cli create`, the demo store, the AMA storefront, 77 tests on a real PostgreSQL, and
  Arabic documentation.
