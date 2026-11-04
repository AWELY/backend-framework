# Commerce Framework

Lightweight, modular backend framework for headless e-commerce systems, built with
Node.js 24 and TypeScript, on a single PostgreSQL database. Graduation project,
College of Electronic Technology - Tripoli.

## Status

Every Must-Have item of the proposal's framework scope is implemented and
tested against a real PostgreSQL 17 database:

- Core: HTTP layer, REST routing, middleware pipeline, dependency injection,
  validation, centralized error handling, logging, configuration.
- Auth: owner API key + customer accounts (scrypt passwords, signed tokens),
  role/permission access control, rate limiting on login (per IP and per email)
  and on registration (per IP).
- Database: connection pool, Repository pattern (raw parameterized SQL, no ORM),
  transactions, migrations.
- Modules: Categories, Products, Inventory, Customers, Cart, Orders
  (guest and customer checkout).
- Plugin/Extension System: shipping providers, payment providers, order events,
  plugin routes. Built-in: cash on delivery, flat-rate shipping.
- CLI: `create <name>` scaffolds a working store project.
- Tests: 77 unit + integration tests (`npm test`) + a real-browser test of the website.
- Demo E-Commerce API: `examples/demo-store` (see its README).
- **Project map** (`docs/PROJECT-MAP.md`, Arabic): where every feature, route, table and test lives.
- **AMA storefront** (`storefront/`): a real Arabic e-commerce website (electronics &
  phone accessories, Tripoli - Tajoura) built on the framework - plain HTML/CSS/JS,
  city-based delivery, cash on delivery, guest and customer checkout, plus an admin dashboard
  and a courier app built as store plugins on the framework's public extension points.
  See `storefront/README.md`.
- Documentation (Arabic): `docs/API.md` (API contract), `docs/PERFORMANCE.md`
  (performance evaluation, `npm run bench`).

## Requirements

- Node.js 24+
- PostgreSQL 17 (one database for development, a separate one whose name
  contains `test` for the integration tests)

## Setup

Step-by-step guide for a new machine (Arabic): `docs/SETUP.md` (Windows) or
`docs/SETUP-LINUX.md` (Ubuntu/Debian, with notes for other distributions).

```bash
npm install
npm run setup -- --db-password <commerce_app password>   # writes .env with random secrets
npm run build
npm run migrate             # creates the tables (safe to re-run)
npm start                   # dev server on PORT (default 3000)
npm test                    # unit + integration tests (wipes TEST_DATABASE_URL)
```

## Verify everything

One command checks the whole project end to end (about 25 seconds):

```bash
npm run verify
```

| Step | What it proves |
|---|---|
| prerequisites | Node 24+, `.env` present, the test database is reachable |
| build | the TypeScript compiles |
| tests | all unit + integration tests pass on real PostgreSQL |
| CLI | a freshly generated store installs, migrates, starts and serves its plugins |
| demo store | migrate + seed + the 16-step shopping scenario, with no server errors |

It only touches `TEST_DATABASE_URL` (wiped) and deletes its temporary folders.
Exit code 0 = everything passed. Run it before every commit or submission.

## API

The full contract (every route, request/response shape, error format, status
codes, permissions) is in `docs/API.md`. Resource groups:

- `/health`
- `/categories`, `/products`, `/inventory/:productId`
- `/customers/register`, `/customers/login`, `/customers/me`, `/customers`
- `/carts`, `/carts/:id/items`
- `/checkout/options`, `/checkout/quote`, `/orders`, `/orders/:id/status`, `/orders/:id/payment`

Owner requests send `X-Api-Key`; customers send `Authorization: Bearer <token>`.
Amounts are integers in the currency's smallest unit (dirhams for LYD).

## Scaffold a new store project

```bash
npm run cli -- create my-store     # creates ../my-store next to this repo
cd ../my-store
npm install
cp .env.example .env               # set OWNER_API_KEY and DATABASE_URL
npm run migrate
npm start
```

## Layout

```
src/
  engine/       HTTP layer, router, middleware pipeline, validation, access control,
                password hashing, auth tokens, errors, config, logger
                (depends on nothing else in src/)
  container/    dependency injection container (depends on nothing else in src/)
  middleware/   cors, request-logger, auth, validate (depends on engine/)
  db/           pool, Repository, transactions, migrations, DB-error translation
                (depends on engine/ errors only)
  modules/      the six commerce modules (each = migrations + repository + routes)
                and extensions.ts (the plugin extension points)
  plugins/      built-in plugins: cash on delivery, flat-rate shipping
  app.ts        createCommerceApp(): wires everything - what store projects call
  index.ts      public library entry point (no side effects)
  dev-server.ts / migrate.ts   this repo's own scripts
cli/            scaffolding tool (commander) + templates; never imports src/
tests/          unit/ and integration/ (node:test, real PostgreSQL)
examples/       demo-store: a store built on the framework as a library
storefront/     AMA: the store's API (api/, plugins/) + website, admin, courier app (web/) + browser test
bench/          performance evaluation (npm run bench)
docs/           API contract and performance report (Arabic)
```
