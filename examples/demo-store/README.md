# Demo store

A demo e-commerce API built **on top of** the framework, used as a library
(`"commerce-framework": "file:../.."`) exactly as any store project would use
it. Its only framework-specific code is `app.js` (about 20 lines): the whole
API - catalogue, stock, customer accounts, carts, orders, cash on delivery and
two delivery options - comes from the framework.

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

Note: each scenario run registers a new customer, and the framework allows 5 new
accounts per hour per IP. After 5 runs the scenario stops with a clear message;
restart the demo store (the counter is in memory) to run it again.
