# Maa

**A production-ready backend framework for headless e-commerce: Node.js 24, TypeScript, and one PostgreSQL database.**

Maa gives a store a complete, tested REST API in a few lines of code:
- **Catalogue:** products, variants, categories and stock.
- **Buying:** carts, guest and customer checkout, coupons and tax, payments with holds and refunds.
- **Delivery:** courier assignment and tracking.
- **People:** customer accounts with real sessions, and staff roles.
- **Operations:** an audit log, metrics, and safe multi-instance operation, with no Redis or message broker.

It was built as a graduation project at the College of Electronic Technology, Tripoli, then
hardened to production standards. The complete store that ships with it, **Maa Store**
([`storefront/`](storefront/)), uses every feature: a customer website, a courier app and an
admin dashboard.

```js
const { createCommerceApp, loadConfig, optionsFromConfig, installShutdownHandlers, cashOnDelivery, coupons } = require("maa");

const config = loadConfig();                       // reads and validates .env, every problem reported at once
const app = createCommerceApp({ ...optionsFromConfig(config), plugins: [cashOnDelivery(), coupons()] });
await app.migrate();                               // creates the tables (safe to re-run)
await app.listen(config.port);                     // 73 API operations, /health, /metrics, /openapi.json
installShutdownHandlers(app);                      // SIGTERM: finish in-flight requests, then stop
```

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Your first store](#your-first-store)
- [Concepts in five minutes](#concepts-in-five-minutes)
- [API overview](#api-overview)
- [Configuration](#configuration)
- [Maa Store: the reference storefront](#maa-store-the-reference-storefront)
- [Scripts](#scripts)
- [Quality](#quality)
- [Documentation](#documentation)
- [Project layout](#project-layout)

## Features

| Area | What you get |
|---|---|
| **Catalogue** | Categories and products with search, sorting and pagination; variants (SKU, own price, own stock); readable slugs |
| **Stock** | Atomic, oversell-proof stock per product and per variant; restock on cancel and refund |
| **Cart & checkout** | Guest and customer carts, merged at login; shipping and payment from plugins; coupon and tax pricing; `Idempotency-Key` |
| **Orders** | State machine, payment state machine, timeline, refunds (partial, with restock), automatic cancellation of unpaid online orders |
| **Delivery** | Assign orders to couriers; pickup, deliver with cash collection, failed attempts; customers see the courier and the timeline |
| **Accounts** | Customer registration and login, server-side sessions (logout, log out everywhere), password change and reset |
| **Staff** | Email/password staff accounts with roles (`admin`, `manager`, `support`, `courier`), managed by the owner; permission-based access |
| **Security** | scrypt passwords, signed revocable tokens, secret rotation, rate limits, body limits, security headers, audit log, webhook signatures |
| **Operations** | JSON logs with request ids, Prometheus metrics, `/livez` `/readyz`, graceful shutdown, configurable timeouts, Docker |
| **Reliability** | Deadlock-free checkout with automatic retries, transactional outbox for events, Postgres job queue, multi-instance safe |
| **Developer experience** | Typed handlers from schemas, machine-readable error codes, generated OpenAPI 3.1, plugins, DI, a CLI scaffold |

## Quick start

**Requirements:** Node.js 24+, PostgreSQL 15+ (17 recommended).

```bash
git clone <this repo> maa && cd maa
npm install
npm run setup -- --db-password <your postgres password>   # writes .env with random secrets
npm run build
npm run migrate          # creates every table
npm start                # http://localhost:3000
```

Then:

```bash
curl localhost:3000/readyz                                      # {"status":"ready"}
curl localhost:3000/openapi.json | head                         # the full API description
curl -X POST localhost:3000/categories -H "X-Api-Key: $OWNER_API_KEY" \
     -H "Content-Type: application/json" -d '{"name":"Phones","slug":"phones"}'
```

**With Docker:**

```bash
OWNER_API_KEY=$(openssl rand -hex 32) AUTH_TOKEN_SECRET=$(openssl rand -hex 32) docker compose up --build
```

This starts PostgreSQL, runs the migrations once, then starts the API with JSON logs and a
health check.

Step-by-step setup guides in Arabic: [`docs/SETUP.md`](docs/SETUP.md) (Windows) and
[`docs/SETUP-LINUX.md`](docs/SETUP-LINUX.md).

## Your first store

The CLI scaffolds a ready-to-run store that uses Maa as a library:

```bash
npm run cli -- create my-store     # creates ../my-store
cd ../my-store && npm install
# set DATABASE_URL in .env
npm run migrate && npm start
```

A store is a single file. Add plugins, roles and limits on top of the configuration:

```js
const { createCommerceApp, loadConfig, optionsFromConfig, installShutdownHandlers,
        cashOnDelivery, cityRateShipping, coupons, percentageTax } = require("maa");

const config = loadConfig();
const app = createCommerceApp({
  ...optionsFromConfig(config),
  checkoutRateLimit: { maxFailures: 30, windowSeconds: 600 },
  plugins: [
    cityRateShipping({ rates: { Tripoli: 10_000, Benghazi: 40_000 }, freeOver: 500_000 }),
    cashOnDelivery(),
    coupons(),
    percentageTax({ ratePercent: 5, label: "VAT" }),
  ],
});
await app.listen(config.port);
installShutdownHandlers(app, { timeoutMs: config.shutdownTimeoutMs });
```

## Concepts in five minutes

**Amounts are integers in the smallest currency unit.** 35.5 LYD is `35500` (dirhams). They are
stored as `BIGINT`, so there are no floating-point surprises.

**Three kinds of callers:**

| Caller | Sends | Gets |
|---|---|---|
| The owner (and automation) | `X-Api-Key: <OWNER_API_KEY>` | everything |
| A staff member | `Authorization: Bearer <token>` from `POST /staff/login` | what their role allows |
| A customer | `Authorization: Bearer <token>` from `POST /customers/login` | their own cart, orders and profile |
| A guest | nothing | the catalogue, guest carts, checkout, tracking by order id + phone |

Tokens carry a server-side session, so logging out, changing a password or deactivating a staff
account takes effect immediately.

**Every error looks the same, and has a code you can switch on:**

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock",
             "details": { "productId": "…", "available": 2, "requested": 3 }, "requestId": "7f3c…" } }
```

The full list is in [`src/engine/errors.ts`](src/engine/errors.ts) (`ErrorCodes`). The
`requestId` is also in the `X-Request-Id` header and on every log line for that request.

**Lists are arrays; the total is in a header.** `GET /products?limit=12&offset=12` returns an
array, with `X-Total-Count: 16`.

**Safe retries.** Send `Idempotency-Key: <uuid>` with `POST /orders`. A retry after a network
failure returns the original order instead of a duplicate.

**No lost updates.** `GET /products/:id` returns `ETag: "3"`. Send `If-Match: "3"` with your
`PATCH`. If someone else saved first, you get `412 PRECONDITION_FAILED` instead of overwriting
their change.

**Events after commit.** Listeners (`order.created`, `order.deliveryChanged`…) run from a
transactional outbox shortly after the change commits, at least once each. They never slow down
or break the request that caused them.

## API overview

The machine-readable contract is generated from the code: `GET /openapi.json`
([`docs/openapi.json`](docs/openapi.json), checked in CI). The human-readable contract (Arabic)
is [`docs/API.md`](docs/API.md).

| Group | Routes |
|---|---|
| System (at the root) | `/health`, `/livez`, `/readyz`, `/metrics`, `/openapi.json` |
| Catalogue | `/categories`, `/products`, `/products/by-slug/:slug`, `/products/:id/variants`, `/inventory/:productId`, `/inventory/variants/:variantId` |
| Customers | `/customers/register`, `/customers/login`, `/customers/logout(-all)`, `/customers/me`, `/customers/me/sessions`, `/customers/me/password`, `/customers/password-reset(/confirm)`, `/customers` |
| Staff | `/staff/login`, `/staff/logout`, `/staff/me`, `/staff/me/password`, `/staff/roles`, `/staff`, `/staff/:id` |
| Cart | `/carts`, `/carts/mine`, `/carts/:id`, `/carts/:id/items(/:productId)` |
| Checkout & orders | `/checkout/options`, `/checkout/quote`, `/orders`, `/orders/:id`, `/orders/:id/events`, `/orders/:id/status`, `/orders/:id/payment`, `/orders/:id/refunds` |
| Delivery | `/orders/:id/delivery`, `/deliveries`, `/deliveries/:orderId/pickup`, `/deliver`, `/fail` |
| Plugins | `/coupons` (coupons plugin) |
| Audit | `/audit-log` |

Set `API_BASE_PATH=/v1` to serve the API under `/v1`. System routes stay at the root.

**Every feature with a working example** (request, response and the storefront code that uses
it): [`docs/EXAMPLES.md`](docs/EXAMPLES.md).

## Configuration

Everything comes from environment variables (`.env`), validated at startup. A typo like
`PORT=abc` or `TRUST_PROXY=yes` stops the server with a clear message that lists every problem
at once. The full commented list is in [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgresql://user:pass@host:5432/db` |
| `OWNER_API_KEY` | required | 32+ random characters; `OWNER_API_KEY_PREVIOUS` during rotation |
| `AUTH_TOKEN_SECRET` | required | 32+ random characters; `AUTH_TOKEN_SECRET_PREVIOUS` during rotation |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` switches logs to JSON by default |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | `debug`…`error` / `pretty` or `json` |
| `CORS_ORIGIN` | `*` | `*`, one origin, or a comma-separated list |
| `TRUST_PROXY` | `false` | `true` only behind exactly one trusted reverse proxy |
| `API_BASE_PATH` | (empty) | e.g. `/v1` |
| `BODY_LIMIT_BYTES` | `1048576` | larger bodies get `413` |
| `CURRENCY` | `LYD` | ISO 4217 code |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | `10`, `15000`, `30000`, `5000` | pool and timeouts |
| `METRICS_TOKEN` | (empty) | protects `/metrics` with a bearer token |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | grace period for in-flight requests on SIGTERM |
| `SHUTDOWN_DELAY_MS` | `0` | behind a load balancer: time between `/readyz` turning 503 and closing the listener |
| `HSTS` | `false` | `Strict-Transport-Security`; enable only behind HTTPS |

Options that are code rather than configuration (plugins, roles, rate limits, workers) are passed
to `createCommerceApp`; see `CommerceAppOptions` in [`src/app.ts`](src/app.ts).

## Maa Store: the reference storefront

[`storefront/`](storefront/) is a real Arabic store (electronics and phone accessories, Tripoli)
built only on the public API, in plain HTML, CSS and JavaScript:

- **Customer site:** catalogue with variants and search, cart, checkout with coupons and card or
  cash payment, accounts with sessions and password reset, order tracking with a live timeline.
- **Courier app** (`courier.html`): assigned deliveries, call and map links, pickup, delivery with
  cash collection, failed attempts.
- **Admin dashboard** (`admin.html`): orders, courier assignment, payments, refunds, products and
  variants with conflict-safe editing, stock, categories, coupons, customers, staff and the audit log.

```bash
cd storefront && npm install
npm run setup && npm run migrate && npm run seed      # seed prints the development staff accounts
npm start                                             # API :3000 + website :5173
npm run test:browser                                  # drives all three sides in headless Chrome
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | compile TypeScript to `dist/` |
| `npm start` | run the reference server (`dist/dev-server.js`) |
| `npm run migrate` | apply pending migrations |
| `npm test` | unit and integration tests on a real PostgreSQL (`TEST_DATABASE_URL`, wiped) |
| `npm run test:coverage` | the same, with the coverage gate (lines 90%, branches 80%, functions 75%) |
| `npm run lint` | layer rules, no request-input casts, no `any`, no `console` |
| `npm run openapi` / `openapi:check` | regenerate / verify `docs/openapi.json` |
| `npm run check` | lint + build + OpenAPI check + coverage |
| `npm run verify` | end to end: tests, a CLI-generated store, the demo store, the storefront |
| `npm run bench` | performance evaluation ([`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)) |
| `npm run cli -- create <name>` | scaffold a new store |

## Quality

- **156 tests** on real PostgreSQL, including:
  - 500 concurrent checkouts with exact stock reconciliation;
  - two instances sharing one database;
  - fuzzing of the router and validator;
  - third-party plugins built only on the public API.
- **CI** (`.github/workflows/ci.yml`): lint, build, OpenAPI drift, coverage gate, dependency
  audit, full verification, Docker build.
- **A browser test** drives the storefront's customer, admin and courier flows, and fails on any
  console error or CSP violation.

## Documentation

| Document | For |
|---|---|
| [`docs/EXAMPLES.md`](docs/EXAMPLES.md) | every feature, with a working example from the storefront |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the pieces fit, request lifecycle, checkout, background work |
| [`docs/EXTENDING.md`](docs/EXTENDING.md) | writing plugins: shipping, payments, pricing, events, jobs, routes |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | operating in production: deploys, migrations, alerts, rotation, incidents |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | threats and the mitigation or test for each |
| [`docs/adr/`](docs/adr/README.md) | architecture decision records |
| [`docs/VERSIONING.md`](docs/VERSIONING.md), [`CHANGELOG.md`](CHANGELOG.md) | compatibility policy and changes |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | working on Maa itself |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | the hardening plan and its status |
| [`docs/API.md`](docs/API.md), [`docs/PROJECT-MAP.md`](docs/PROJECT-MAP.md) | API contract and project map (Arabic) |

## Project layout

```
src/
  engine/       HTTP server, router, validation, errors, logger, metrics, OpenAPI, config, tokens
  container/    dependency injection
  middleware/   cors, security headers, logging, metrics, auth, withInput, idempotency, audit
  db/           pool, repositories, transactions with retry, migrations
  runtime/      sessions, rate limits, outbox, job queue, worker, audit log, graceful shutdown
  modules/      categories, products, inventory, customers, staff, cart, orders, delivery
  plugins/      cash on delivery, flat/city shipping, coupons, percentage tax
  app.ts        createCommerceApp(): the composition root
  index.ts      the public API
cli/            `maa create <name>` and templates
examples/       demo-store (a store as a library) and third-party plugin examples
storefront/     Maa Store: API, customer site, courier app, admin dashboard, browser test
tests/          unit/ and integration/ (node:test, real PostgreSQL)
scripts/        verify, lint, openapi, setup
docs/           everything above
```

## License

Not chosen yet: `package.json` says `UNLICENSED`, which means nobody else may use the code. The
authors should pick one (MIT is the usual choice for a reusable framework) before publishing.
