# Architecture

Maa is a single-store, headless commerce backend: one Node.js process type, one PostgreSQL
database, any number of identical instances behind a load balancer. This page explains how the
pieces fit together. The reasons behind each choice are in [`docs/adr/`](adr/README.md).

## Layers

```
src/
  engine/       HTTP server, router, validation, errors, logger, metrics, OpenAPI,
                config, auth tokens, passwords, webhook signatures, access control
  container/    dependency injection (tokens + lazy singletons)
  middleware/   cors, security headers, request logger, metrics, auth, withInput,
                idempotency, audit trail
  db/           pool, Repository base class, transactions with retry, migrations,
                database error translation
  runtime/      everything that keeps several instances correct: sessions, rate limits,
                idempotency store, audit log, transactional outbox, job queue, worker,
                graceful shutdown
  modules/      categories, products, inventory, customers, staff, cart, orders, delivery
  plugins/      cash on delivery, flat/city shipping, coupons, percentage tax
  app.ts        createCommerceApp(): the composition root
  index.ts      the public API (everything else is internal)
```

Dependencies only point downwards, and `npm run lint` enforces it:

| Layer | May import from |
|---|---|
| `engine/`, `container/` | nothing else in `src/` |
| `middleware/` | `engine/` |
| `db/` | `engine/` |
| `runtime/` | `engine/`, `db/`, `middleware/` (interfaces only) |
| `modules/` | everything below |
| `plugins/` | everything below, but only the public parts of modules (`types`, `shared`, `extensions`) |

Middleware never touches the database directly. It depends on small interfaces
(`SessionVerifier`, `IdempotencyStore`, `AuditSink`) that `runtime/` implements over PostgreSQL.
That keeps the HTTP layer testable without a database and swappable in a store.

## A request, end to end

```
client ──► Node http server (engine/http/server.ts)
            │ X-Request-Id (accepted or generated), req.log = logger.child({ requestId })
            │ match system routes (/health /livez /readyz /metrics /openapi.json) at the root,
            │ then API routes under basePath (e.g. /v1)
            ▼
         global middleware, always, even for 404/405:
            cors → securityHeaders → shutdownGuard → httpMetrics → requestLogger → auditTrail
            ▼
         readBody (1 MB limit → 413, raw bytes kept on req.rawBody, bad JSON → 400 MALFORMED_JSON)
            ▼
         route middleware:  authenticate / authenticateOptional  →  requirePermission  →  idempotency
            ▼
         withInput(spec, handler): body + query + params validated together, typed, one 400 for all
            ▼
         handler → service / repository → PostgreSQL
            ▼
         any thrown error → toErrorResponse → { error: { code, message, details, requestId } }
```

No request can crash the process: every error, synchronous or asynchronous, ends in one
`onError`. Server errors are logged with the stack and the request id. The client gets only the
code, a generic message and the same request id.

## Authentication and authorization

| Who | Credential | Identity |
|---|---|---|
| Owner (and automation) | `X-Api-Key` (constant-time compare; previous keys accepted during rotation) | `role: owner` |
| Customer | `Authorization: Bearer <token>` from `/customers/login` | `role: customer`, `sessionId` |
| Staff | `Authorization: Bearer <token>` from `/staff/login` | current role from the `staff` table |

Tokens are HMAC-signed and carry a session id. Every authenticated request checks that the
session in `auth_sessions` is still valid, so logout, "log out everywhere", a password change, a
role change or deactivating a staff account all take effect immediately. Authorization is
permission-based (`products:write`, `orders:refund`, `deliveries:update-own`...). Roles are a table
(`DEFAULT_ROLES`) that a store can replace.

## Checkout: the critical path

```
withTransaction (retried automatically on deadlock / serialization failure)
  1. SELECT cart FOR UPDATE              — a double click waits, then sees "checked_out"
  2. load lines (variant price or product price), reject unavailable ones
  3. price: shipping provider → price adjusters (coupons, tax...) in plugin order
  4. decrement stock line by line, in byStockLockOrder (product id, variant id)
        UPDATE ... SET quantity = quantity - n WHERE quantity - n >= 0
  5. INSERT order + items (price snapshot), timeline row, outbox event "order.created"
  6. mark cart checked_out
COMMIT
then, outside the transaction:
  7. payment provider initiate()  (slow or broken gateways never hold locks)
  8. record the payment result in its own transaction (+ "order.paymentChanged", optional hold)
```

Two facts guarantee correctness under load. Stock never goes below zero, because of the
conditional update plus a `CHECK` constraint. And lock ordering is fixed, so concurrent checkouts
queue up instead of deadlocking. The database also enforces
`total = subtotal + shipping_cost + adjustments_total` and `line_total = unit_price * quantity`.

## Background work without a second system

```
            any request / job                         every instance
   ┌───────────────────────────────┐        ┌──────────────────────────────┐
   │ BEGIN                          │        │ BackgroundWorker (1 s poll,  │
   │   change data                  │        │ nudged right after commits)  │
   │   INSERT INTO outbox_events    │──────► │  claim with lease +          │
   │ COMMIT                         │        │  FOR UPDATE SKIP LOCKED      │
   └───────────────────────────────┘        │  deliver to each listener     │
                                            │  retry with backoff, then     │
   jobs.enqueue / jobs.schedule ──────────► │  dead letter                  │
                                            └──────────────────────────────┘
```

- **Events** are written in the same transaction as the change: no event for a rolled-back
  change, and no lost event if the process dies after commit. Delivery is at-least-once, and
  each listener is retried on its own.
- **Jobs**: recurring schedules (`cart.cleanupAbandoned`, `orders.releaseExpiredHolds`,
  `system.cleanup`) are deduplicated across instances by a `dedupe_key` per time bucket.
- **Rate limits** are atomic upserts in `rate_limits`, shared by every instance.
- **Idempotency keys** and **sessions** live in PostgreSQL too.

The result: horizontal scaling needs no Redis, no queue broker and no sticky sessions.
`tests/integration/multi-instance.test.ts` runs two instances on one database to prove it.

## Extension points

Modules and plugins receive a `ModuleContext` with the router, container, pool, access control,
logger, authenticators, extensions registry, event publisher, job queue, sessions, audit log,
idempotency middleware, metrics and currency. Plugins can add:

- shipping providers, payment providers (with `holdSeconds` and `refund`), price adjusters;
- event listeners for 12 events;
- routes, migrations, jobs, metrics;
- replacements for any container service (for example a caching repository).

See [`EXTENDING.md`](EXTENDING.md).

## Data model (main tables)

| Area | Tables |
|---|---|
| Catalogue | `categories`, `products`, `product_variants` |
| Stock | `inventory`, `variant_inventory` |
| People | `customers`, `password_resets`, `staff`, `auth_sessions` |
| Buying | `carts`, `cart_items`, `orders`, `order_items`, `order_events`, `refunds` |
| Delivery | `order_deliveries` |
| Runtime | `outbox_events`, `jobs`, `rate_limits`, `idempotency_keys`, `audit_log`, `schema_migrations` |
| Plugins | `coupons`, `coupon_redemptions` |

Money is always an integer in the currency's smallest unit, stored as `BIGINT`, and arrives in
JavaScript as a number. A value above 2^53 raises an error instead of losing precision silently.
