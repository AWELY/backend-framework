# Contributing to Maa

How to work on the framework itself. To build a store on Maa, start with `README.md` and
`docs/EXTENDING.md` instead.

## Setup

Requirements: Node.js 24+, PostgreSQL 15+ (CI uses 17), npm.

```bash
npm install
npm run setup                     # creates .env from .env.example with random OWNER_API_KEY and AUTH_TOKEN_SECRET
```

`npm run setup -- --db-password <pw>` also fills `DATABASE_URL` and `TEST_DATABASE_URL` for a user
`commerce_app` and databases `commerce_dev` / `commerce_test`. Otherwise set them yourself. You need
two databases:

- a development database for `DATABASE_URL`;
- a **separate test database** for `TEST_DATABASE_URL` whose name contains `test`. Tests drop and
  recreate its `public` schema on every run.

```bash
createdb maa_dev && createdb maa_test
npm run build
npm run migrate                   # runtime + core module tables in DATABASE_URL
npm start                         # reference server on http://localhost:3000 (no plugins)
```

Alternatively `docker compose up --build` runs PostgreSQL, the migrations and the API (see the comment
at the top of `docker-compose.yml` for the required variables).

## The checks

| Command | What it does | When |
|---|---|---|
| `npm run lint` | Layer rules and code rules (below) | Constantly |
| `npm test` | Compiles to `build-test/` and runs every unit and integration test | Before every push |
| `npm run check` | `lint` + `build` + `openapi:check` + `test:coverage` | Before opening a pull request |
| `npm run verify` | End to end: prerequisites, build, all tests, a CLI-generated store (create, install, migrate, start, call), the demo store's 16-step scenario, and the Maa Store API and website | Before a pull request that touches the CLI, templates, examples or storefront; always before a release |
| `npm run openapi` | Regenerates `docs/openapi.json` from the route schemas (run after `npm run build`) | After changing any route, schema or permission |

CI (`.github/workflows/ci.yml`) runs lint, build, the OpenAPI drift check, the tests with the coverage
gate, `npm audit --omit=dev --audit-level=high`, `npm run verify`, and a Docker build. The coverage gate
is lines 90%, branches 80%, functions 75%, measured over `build-test/src`.

`npm run verify` uses `TEST_DATABASE_URL` for every step (it is wiped) and deletes its temporary
directories whether it passes or fails. The storefront's browser test is separate:
`cd storefront && npm run test:browser` (needs a local Chrome, Edge or Chromium).

## Layer rules (`scripts/lint.js`)

`src/` is layered. Each folder may import only from the folders listed:

| Folder | May import from |
|---|---|
| `engine/` | nothing else in `src` |
| `container/` | nothing else in `src` |
| `middleware/` | `engine` |
| `db/` | `engine` |
| `runtime/` | `engine`, `db`, `middleware` (interfaces); never `modules` |
| `plugins/` | anything except module internals: `modules/types`, `modules/shared`, `modules/extensions` are fine, `modules/orders/orders.service` is not |
| `modules/`, `app.ts`, `index.ts` | not restricted by lint; modules use each other only through DI tokens and exported types |

Other rules, all enforced by `npm run lint`:

- No `req.body as ...` or `req.params.x as ...` in modules and plugins: use `withInput()`, which types
  the input from the schema.
- No `any` in `src` (use `unknown` and narrow it).
- No `console.*` in `src` except `dev-server.ts`, `migrate.ts` and `engine/logger.ts`: use the
  `Logger`.
- No `.only` in tests.
- `examples/plugins/*` import only from `./maa` (the public API shim) and `node:` built-ins. This is
  what proves a third party can write them.

TypeScript runs with `strict` and `noUncheckedIndexedAccess`.

## Adding a module

A module is a `CommerceModule`: `{ name, migrations, register(context), onStart?, onStop? }`.

1. Create `src/modules/<name>/` with:
   - `<name>.schema.ts`: migrations, request schemas (`as const satisfies Schema`) and API types;
   - `<name>.repository.ts`: a `Repository` subclass with explicit SQL, and its DI token
     (`createToken<...>("...")`);
   - `<name>.service.ts` if an operation spans several tables (wrap it in `withTransaction`);
   - `index.ts`: the module object. `register()` registers repositories in the container and routes
     in the router.
2. Routes: `authenticate` or `authenticateOptional`, then `requirePermission(accessControl, "...")`,
   then `withInput({ body, query, params, summary, successStatus }, handler)`. Lists use
   `PAGINATION_QUERY` and `sendPage()` (bare array plus `X-Total-Count`). Register static paths
   before parameterized ones (`/customers/me` before `/customers/:id`).
3. Permissions: add them to `DEFAULT_ROLES` in `src/engine/access-control.ts`.
4. Events: add the event to `CommerceEvents` in `src/modules/extensions.ts`; publish with
   `context.events.publish(client, ...)` inside the transaction and call `context.events.notify()`
   after commit.
5. Locking: any transaction that touches several stock rows sorts them with `byStockLockOrder`
   (ADR 0011). No external calls inside `withTransaction`: it may run the work more than once.
6. Add the module to `coreModules` in `src/modules/index.ts`, after the modules it depends on, and
   export the module, its token and its public types from `src/index.ts`. Exports are public API
   (`docs/VERSIONING.md`).
7. `npm run build && npm run openapi`, then commit `docs/openapi.json`.
8. Integration tests in `tests/integration/<name>.test.ts`, a `CHANGELOG.md` entry, and an update to
   `docs/THREAT-MODEL.md` if the module handles credentials, money or personal data.

## Adding a plugin

Bundled plugins live in `src/plugins/` and are exported from `src/plugins/index.ts` and
`src/index.ts`. A plugin is a factory returning a `CommercePlugin`:

- `name` (unique among modules and plugins), `version`, `dependsOn` (modules or plugins that must be
  installed first), `configSchema` and `config` (validated at startup), `migrations`, `setup(context)`,
  and optional `onStart` / `onStop` (stopped in reverse order).
- Use only the extension points: `extensions.addShippingProvider`, `addPaymentProvider`,
  `addPriceAdjuster`, `extensions.on`, `router`, `jobs.define` / `jobs.schedule`, the container.
- Listeners are called at least once: make them idempotent with `meta.id`, and register them in a
  stable order (completion is tracked by registration index).
- Payment providers: `initiate()` runs after the checkout commits; webhooks must verify
  `verifyWebhookSignature()` over `req.rawBody` before trusting anything.
- Price adjusters and shipping quotes return non-negative integer amounts in minor units.

`docs/EXTENDING.md` covers each extension point with examples. A plugin written as a third party would
write it belongs in `examples/plugins/`, importing only from `./maa`, with a test in
`tests/integration/third-party.test.ts`.

## Adding a migration

A migration is `{ id, up }` in the module's or plugin's `migrations` array. The runner
(`src/db/migrations.ts`) sorts all ids as strings, applies the missing ones in order, each in its own
transaction, records them in `schema_migrations`, and holds an advisory lock while doing so. Duplicate
ids fail before anything touches the database.

- **Id format:** four digits, underscore, snake_case description: `0995_orders_notes`.
- **Numbering:** a new id must sort after every id that has already been released, so fresh installs
  and upgraded databases apply migrations in the same order. Current ranges: `0100`-`0990` core
  modules, `0900` runtime tables, `1100` the coupons plugin. The next core migrations take `0991`
  onwards; leave gaps so a fix can be inserted before the next release.
- **Never edit, renumber or delete a migration that has been released.** Databases that already
  applied it will never run the new text, so fresh and upgraded installs would diverge. Change the
  schema with a new migration.
- No down migrations: roll forward.
- Prefer additive changes and expand/contract (`docs/RUNBOOK.md`, section 5). Add constraints that old
  rows might violate as `NOT VALID`, then `VALIDATE` them (see `0920_orders_pricing_currency`).
- `CREATE INDEX CONCURRENTLY` cannot run inside the runner's transaction; see the runbook for large
  tables.
- `npm run migrate` in this repository applies only runtime and core module migrations. Plugin
  migrations run through `app.migrate()`.

## Tests

- Runner: `node:test`, compiled by `tsc -p tsconfig.test.json` into `build-test/`, files run one at a
  time (`--test-concurrency=1`) because they share the test database.
- **Integration tests use a real PostgreSQL**, never mocks: constraints, transactions and locks are
  what is being tested. `startTestApp()` (`tests/helpers/test-app.ts`) refuses to run unless the
  database name in `TEST_DATABASE_URL` contains `test`, drops the `public` schema, runs every
  migration and starts a real server on a random port. Never point `TEST_DATABASE_URL` at data you
  want to keep.
- Helpers: `api()` sends real HTTP requests (`owner: true` adds the owner key, `token` a bearer token);
  `createProduct()`, `createCart()`, `registerCustomer()`, `createStaff()`, `CONTACT`.
- Background work: call `await t.app.drainBackgroundWork()` to deliver events and run jobs
  deterministically; move `available_at` or `run_at` to `now()` in SQL to skip a backoff.
- A second instance on the same database: `startTestApp({ resetDatabase: false })`.
- Turn off rate limits in tests that are not about them (`loginRateLimit: false`, ...).
- Unit tests (`tests/unit/`) do not touch the database.
- Test names are sentences describing the behaviour ("logout revokes only this device; logout-all
  revokes every device"). The phase exit tests (`concurrency`, `multi-instance`, `third-party`) must
  keep passing.

## Comments and language

- **Code comments are in Arabic.** They explain why, often with a concrete example, and they are part
  of the project's teaching value. Keep them when you change code, update them when behaviour changes,
  and write new comments in Arabic in the same style.
- Identifiers, log messages, error messages, test names, commit messages, `README.md` and the docs in
  `docs/` (except `API.md`, `PROJECT-MAP.md`, the setup guides and the study material) are in English.
- Error messages are for humans; programs branch on `error.code`. Do not change an existing code.

## Pull requests

- One topic per pull request. Run `npm run check` (and `npm run verify` when relevant).
- Add an entry under "Unreleased" in `CHANGELOG.md`. If it breaks anything defined in
  `docs/VERSIONING.md`, list it under "Breaking changes" with upgrade steps.
- A change to a recorded decision needs a new ADR in `docs/adr/` (`docs/adr/README.md`).
- Security-relevant changes update `docs/THREAT-MODEL.md`; operational changes update
  `docs/RUNBOOK.md`.
