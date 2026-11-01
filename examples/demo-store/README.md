# Demo store

A demo e-commerce API built **on top of** the Maa framework, used as a library
(`"maa": "file:../.."`, then `require("maa")`) exactly as any store project would
use it. Its only framework-specific code is `buildApp` in `app.js` (about 20 lines
of configuration): cash on delivery and two delivery options (standard, free over
200 LYD, and express). Everything else - catalogue with variants, stock, customer
accounts and sessions, staff accounts, carts, checkout, orders with their timeline,
payments and refunds, delivery, the audit log, health and metrics endpoints - comes
from the framework. The full contract is in `../../docs/API.md`.

| File | What it does |
|---|---|
| `app.js` | `buildApp()`: `loadConfig()` + `createCommerceApp()` with the store's plugins |
| `index.js` | `npm start`: builds the app and listens on `PORT` |
| `migrate.js` | `npm run migrate`: creates or updates every table (framework runtime tables and all modules) |
| `seed.js` | `npm run seed`: 3 categories and 7 products, through the repositories resolved from the DI container (no SQL, no HTTP) |
| `scenario.js` | `npm run scenario`: a 16-step shopping journey over the public HTTP API only |

## Run it

```bash
npm run build                 # in the framework root, once
cd examples/demo-store
npm install
cp .env.example .env          # set the two secrets and DATABASE_URL (a separate database)
npm run migrate
npm run seed                  # sample Libyan catalogue (safe to run twice)
npm start
```

In a second terminal:

```bash
npm run scenario              # a full shopping journey, printed step by step
```

The framework is installed as a real copy in `node_modules` (`install-links=true`
in `.npmrc`), so after rebuilding the framework run `npm install` here again.

Note: each scenario run registers a new customer, and the framework allows 5 new
accounts per hour per IP. After 5 runs within an hour the scenario stops with a
clear message. The counter is stored in PostgreSQL (table `rate_limits`), so
restarting the demo store does **not** reset it: wait for the hour to pass, or, on
this development database only, clear it with
`DELETE FROM rate_limits WHERE key LIKE 'register:%';`.
