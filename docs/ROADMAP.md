# Roadmap: from graduation project to production framework

Scope (the line we hold): **a single-store, headless commerce backend on one PostgreSQL
database, for small and medium stores.** Non-goals: multi-tenancy, GraphQL, microservices,
Redis or any second storage system.

Compatibility rule for every phase: the existing HTTP contract keeps working (Maa Store
(formerly AMA), the demo store and CLI-generated stores run unchanged). New behaviour is
additive or opt-in. Anything that had to break is listed in `CHANGELOG.md`.

Each phase ends with an exit test that proves it is done.

## Phase 1: Correctness

- [x] Checkout locks stock rows in product-id order (no deadlocks); cancel does the same
- [x] Transactions retry automatically on deadlock / serialization failure (40P01, 40001); 503 when exhausted
- [x] Request body limit (413), checked against Content-Length first
- [x] Malformed percent-encoding in a URL is a 400, not a 500
- [x] Validator `nullable`: PATCH can clear a field (`{"categoryId": null}`)
- [x] Request log writes the path without the query string (no phone numbers in logs)
- [x] Raw request body kept on `req.rawBody` (webhook signatures)
- [x] Owner key compared in constant time
- [x] 405 with `Allow` for a known path with the wrong method; HEAD served by GET routes
- [x] Payment status has allowed transitions; repeating the same status is an idempotent no-op
- [x] Database invariants: `total = subtotal + shipping_cost + adjustments_total`, `line_total = unit_price * quantity`
- [x] Failure tests: 500 concurrent checkouts reconcile stock exactly, double checkout, router and validator fuzzing

**Exit test:** `tests/integration/concurrency.test.ts`: 500 concurrent checkouts, 0 server errors,
`initial stock = remaining stock + sold quantity`.

## Phase 2: API contract

- [x] Machine-readable error codes (`error.code`) and `error.requestId` on every error
- [x] `X-Request-Id` accepted or generated, echoed, and attached to every log line
- [x] Validator v2: nested objects, arrays, `nullable`, query and route-param validation with coercion
- [x] `withInput()` typed handlers: modules use no `req.body as` casts (enforced by `npm run lint`)
- [x] `Idempotency-Key` on `POST /orders`
- [x] Optimistic concurrency on products and categories: `ETag` + `If-Match` (412)
- [x] `basePath` option (`/v1`); system routes (health, metrics) stay at the root
- [x] `X-Total-Count` on list endpoints (arrays stay arrays)
- [x] OpenAPI 3.1 generated from route schemas (`npm run openapi`, checked in CI)
- [x] `CHANGELOG.md` and `docs/VERSIONING.md` (semver and deprecation policy)

**Exit test:** the storefront needs no change; `docs/openapi.json` is regenerated in CI and must match.

## Phase 3: Security

- [x] Server-side sessions: every token carries a session id; logout, logout-all, password change and reset revoke sessions
- [x] Password reset flow (delivery through an event, so a plugin sends the email/SMS)
- [x] Staff accounts with roles (`admin`, `manager`, `support`), managed by the owner
- [x] Automatic audit log of every owner/staff write, readable with `audit:read`
- [x] Secret rotation: previous token secrets and owner keys are still accepted
- [x] `verifyWebhookSignature()` helper (HMAC, timestamp tolerance, constant time)
- [x] Security headers; CORS with several origins, `Vary: Origin` and exposed headers
- [x] `docs/THREAT-MODEL.md`: every threat maps to a test or a documented mitigation

**Exit test:** every row of the threat model points to a test or a mitigation.

## Phase 4: Operations

- [x] JSON logs with request id, child loggers and redaction of sensitive fields
- [x] `/metrics` (Prometheus): request rate, errors, latency histogram, pool gauges, job and outbox counters
- [x] `/livez` and `/readyz` (503 while shutting down or with pending migrations); `/health` unchanged
- [x] Graceful shutdown (`installShutdownHandlers`), server timeouts
- [x] Config validated at startup, every problem reported at once
- [x] Pool size, `statement_timeout`, `idle_in_transaction_session_timeout`, connection timeout
- [x] Transactional outbox + event worker (at-least-once, retries, dead letters)
- [x] Postgres job queue (`SKIP LOCKED`) with recurring jobs: cart cleanup, payment-hold release, key and session cleanup
- [x] Rate limits stored in Postgres (work across instances), plus limits on checkout, cart creation and password reset
- [x] Dockerfile, docker-compose, `docs/RUNBOOK.md`

**Exit test:** `tests/integration/multi-instance.test.ts`: two app instances on one database share
rate limits, deliver every event exactly once per listener even when one instance stops mid-run.

## Phase 5: Extensibility and domain

- [x] Plugin contract: `version`, `dependsOn`, `configSchema` (validated at startup), `onStart` / `onStop`
- [x] More events (product, inventory, customer, refund) with metadata (id, version, time, attempt)
- [x] Pricing adjusters: discounts, tax and fees as plugins, stored on the order
- [x] Product variants and SKUs with their own price and stock
- [x] Payment holds: unpaid online orders are cancelled and restocked after the provider's hold time
- [x] Refunds: partial, optional restock, provider refund hook
- [x] Guest cart merged into the customer's cart at login / registration
- [x] Money as `BIGINT` plus a `currency` column
- [x] Third-party examples built only on the public API: coupons plugin, hosted payment gateway, DI override
- [x] `docs/EXTENDING.md`

**Exit test:** `tests/integration/third-party.test.ts` runs the coupon and gateway plugins end to end.

## Throughout

- [x] CI: type-check, lint, tests on Postgres with a coverage gate, `npm run verify`, OpenAPI drift check
- [x] Architecture decision records in `docs/adr/`
- [x] English docs: architecture, extending, runbook, threat model, versioning, contributing
- [ ] License: a decision for the authors (`package.json` is still `UNLICENSED`)

## Phase 6: Delivery and a full storefront

- [x] Delivery module: `courier` role, assign orders to couriers, pickup / deliver / failed attempt, cash collection for cash on delivery
- [x] Order timeline (`order_events`): every status, payment, refund and delivery change, shown to the customer
- [x] Storefront rebuilt on every framework feature, three sides:
  - customer: catalogue with variants, cart, coupons, checkout with idempotency, account, sessions, password reset, tracking with timeline
  - courier: assigned deliveries, pickup, deliver with cash collection, failed attempts
  - admin: orders, courier assignment, payments, refunds, catalogue with variants and stock, coupons, staff, audit log, customers
- [x] Browser test covering the three sides

## Phase 7: Name and developer experience

- [x] Framework renamed to **maa** (package, CLI, docs); storefront renamed to **Maa Store**
- [x] README rewritten for developers: quick start, concepts, recipes, configuration reference, API overview
- [x] `docs/EXAMPLES.md`: a working example (request, response, code) for every single feature

## Status (2026-11-02)

Everything above is implemented and verified, except the license.

- `npm test`: 156 tests pass on PostgreSQL 17 (the Phase 1, 4 and 5 exit tests included).
- `npm run test:coverage`: lines 95%, branches 86%, functions 81% (gate: 90 / 80 / 75).
- `npm run verify`: all checks pass (build, tests, CLI store, demo store, storefront).
- `storefront/tests/browser.mjs`: customer, admin and courier flows pass in headless Chrome, with no console errors or CSP violations.

Fixed after the code review that came with the documentation (tests in `tests/integration/review-fixes.test.ts`): idempotency keys scoped by the real path; refund restock reserved before the provider call and released on failure; payment deadline set inside the checkout transaction; payments arriving after a cancellation flagged for refund; stable order-line order; password change rate-limited; database outages return 503; migrations without statement timeout; `SHUTDOWN_DELAY_MS`.

Fixed after the documentation review: the demo card gateway is now installed only in `DEMO_MODE`; the coupons plugin returns 409 for a duplicate code and 400 (not 500) for an out-of-range percent or an invalid date; the courier delivery routes now declare their permission in OpenAPI.
