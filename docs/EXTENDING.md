# Extending Maa

Everything a store adds goes through a **plugin**: an object with a name and a `setup(context)`
function. Plugins can do anything the built-in modules do, using only the public API
(`require("maa")`). The examples on this page are real, tested code:

| Example | What it shows | Tested in |
|---|---|---|
| [`src/plugins/coupons.ts`](../src/plugins/coupons.ts) | migrations, admin routes, a price adjuster, idempotent event listeners | `tests/integration/commerce-v2.test.ts` |
| [`src/plugins/percentage-tax.ts`](../src/plugins/percentage-tax.ts) | a price adjuster that runs after discounts | `tests/integration/commerce-v2.test.ts` |
| [`examples/plugins/hosted-gateway.ts`](../examples/plugins/hosted-gateway.ts) | a payment gateway: redirect, signed webhook, payment hold, refunds | `tests/integration/third-party.test.ts` |
| [`examples/plugins/cached-products.ts`](../examples/plugins/cached-products.ts) | replacing a service through the DI container | `tests/integration/third-party.test.ts` |
| [`storefront/api/plugins/demo-card-gateway.js`](../storefront/api/plugins/demo-card-gateway.js) | the same gateway pattern in plain JavaScript | `storefront/tests/browser.mjs` |
| [`storefront/api/plugins/dev-mailbox.js`](../storefront/api/plugins/dev-mailbox.js) | notifications from events (password reset links, order updates) | `storefront/tests/browser.mjs` |

## The plugin contract

```ts
import type { CommercePlugin } from "maa";

export function loyaltyPoints(options: { pointsPerDinar: number }): CommercePlugin {
  return {
    name: "loyalty-points",          // unique; a duplicate name stops startup
    version: "1.0.0",
    dependsOn: ["orders"],           // modules or plugins that must be installed before this one
    configSchema: { pointsPerDinar: { type: "number", integer: true, min: 1 } },
    config: options,                 // validated against configSchema at startup, not at first use
    migrations: [{ id: "1200_loyalty_points", up: "CREATE TABLE loyalty_points (...)" }],
    setup(context) { /* register providers, listeners, routes, jobs */ },
    onStart: async (context) => {},  // before the server starts listening
    onStop: async (context) => {},   // on graceful shutdown, in reverse plugin order
  };
}
```

Install it with `createCommerceApp({ ...options, plugins: [loyaltyPoints({ pointsPerDinar: 1 })] })`.
Its migrations run with `app.migrate()` / `npm run migrate`, together with everything else.

Migration ids are global and sorted as strings. Pick a range for your plugin (`1200_...`) and
never edit a migration that has already been applied: add a new one.

## What `context` gives you

| Field | Use it to |
|---|---|
| `router` | add routes (`router.post(path, ...handlers)`) |
| `authenticate`, `authenticateOptional` | require or detect a logged-in owner, customer or staff member |
| `accessControl` + `requirePermission` | check permissions such as `"coupons:write"` |
| `withInput` (from `maa`) | validate body, query and params, and get typed input |
| `pool`, `withTransaction` (from `maa`) | query PostgreSQL |
| `container` | resolve module services (`ORDERS_SERVICE`, `PRODUCTS_REPOSITORY`...) or replace them |
| `extensions` | add shipping and payment providers, price adjusters, event listeners |
| `events` | publish events inside your own transactions (`events.publish(client, ...)`, then `events.notify()`) |
| `jobs` | `define`, `enqueue`, `schedule` background work |
| `sessions`, `audit`, `limiters`, `idempotency`, `metrics`, `logger`, `currency`, `clientIp` | the rest of the runtime |

## Shipping providers

```ts
extensions.addShippingProvider({
  id: "pickup",
  name: "Pick up in store",
  quote: ({ subtotal, shippingCity }) => 0,  // integer, minor units; throw ValidationError for "city not served"
});
```

Providers appear in `GET /checkout/options`. They are called inside the checkout transaction,
so keep them fast and side-effect free.

## Payment providers

```ts
extensions.addPaymentProvider({
  id: "card",
  name: "Card",
  holdSeconds: 15 * 60,                  // unpaid orders are cancelled and restocked after 15 minutes
  initiate: (order) => ({ status: "pending", redirectUrl: `https://pay.example/${order.id}` }),
  refund: async (order, amount) => ({ reference: await gateway.refund(order.paymentReference, amount) }),
});
```

- `initiate` runs **after** the order is committed. A failing gateway leaves the order saved with
  `paymentStatus: "failed"`.
- Report results from your webhook with
  `container.resolve(ORDERS_SERVICE).setPaymentStatus(orderId, "paid", reference)`. Repeating the
  same status is a no-op, so duplicate webhooks are safe.
- Verify webhooks on the raw bytes:
  `verifyWebhookSignature({ payload: req.rawBody, header: req.headers["x-signature"], secret })`.
  For gateways with their own scheme, use `hmacSha256Hex` and `safeEqual`.
- `refund` is called by `POST /orders/:id/refunds`. If it throws, the refund is rolled back and the
  client gets `502 PAYMENT_PROVIDER_ERROR`.

## Price adjusters (discounts, tax, fees)

```ts
extensions.addPriceAdjuster({
  id: "free-gift-wrap",
  adjust: ({ subtotal, couponCode, adjustments }) =>
    subtotal > 300_000 ? [{ code: "GIFT_WRAP", label: "Free gift wrap", type: "discount", amount: 5_000 }] : [],
});
```

Adjusters run in plugin order, both in `POST /checkout/quote` and inside the checkout
transaction. Each one sees what the previous ones added (tax usually goes after discounts).
Amounts are positive integers, and `type` decides the sign. Throw
`new ValidationError(message, [{ field: "couponCode", message }], "INVALID_COUPON")` to refuse a
code. The result is stored on the order as `adjustments` and `adjustmentsTotal`.

## Events

```ts
extensions.on("order.created", async ({ order }, meta) => {
  // meta: { id, event, version, occurredAt, attempt }
  await sendSms(order.contactPhone, `Order ${order.id.slice(0, 8)} received`);
});
```

| Event | Payload |
|---|---|
| `order.created` | `{ order }` (before payment; the result arrives in `order.paymentChanged`) |
| `order.statusChanged` | `{ order, from, reason? }` |
| `order.paymentChanged` | `{ order, from }` |
| `order.refunded` | `{ order, refund }` |
| `order.deliveryChanged` | `{ order, delivery }` |
| `product.created` / `product.updated` | `{ product }` |
| `product.deleted` | `{ productId }` |
| `inventory.changed` | `{ productId, variantId, quantity, reason }` |
| `customer.registered` | `{ customer }` |
| `customer.passwordResetRequested` | `{ customer, token, expiresAt }`, deleted from the database after delivery |

Delivery is **at-least-once**, from the transactional outbox, shortly after the commit. A listener
can therefore run twice for the same event in rare crash cases. Make it idempotent with
`meta.id`, or with a unique key like `coupon_redemptions.order_id`. A throwing listener is
retried alone with exponential backoff. After 10 attempts the event is marked dead and logged.

To publish your own events atomically, write them in your transaction:

```ts
await withTransaction(pool, async (client) => {
  await client.query("UPDATE loyalty_points SET ...");
  await events.publish(client, "inventory.changed", { productId, variantId: null, quantity, reason: "loyalty" });
});
events.notify();
```

## Background jobs

```ts
jobs.define("loyalty.expire", async (payload, { logger, attempt }) => { /* ... */ }, { maxAttempts: 5 });
jobs.schedule("loyalty.expire", 24 * 60 * 60 * 1000);           // once a day, on one instance only
await jobs.enqueue("loyalty.expire", { customerId }, { runAt: new Date(Date.now() + 60_000) });
```

Failed jobs retry with backoff. After `maxAttempts` they are marked dead, with the last error kept.

## Routes in a plugin

```ts
import { withInput, requirePermission } from "maa";

router.get(
  "/loyalty/me",
  authenticate,
  withInput({ summary: "My loyalty points" }, async (req, res) => {
    res.json({ points: await pointsOf(req.auth!.userId!) });
  })
);
```

Routes declared with `withInput` and the authenticators appear in `/openapi.json` automatically,
with their schemas, security and permissions. Owner and staff writes to your routes are recorded
in the audit log automatically.

## Replacing a service

Modules resolve their services from the container on every request, and plugins run after
modules, so registering the same token replaces the implementation:

```ts
setup({ container, pool }) {
  container.register(PRODUCTS_REPOSITORY, () => new CachedProductsRepository(pool, 30_000));
}
```

See `examples/plugins/cached-products.ts` for cache invalidation through events.

## Roles and permissions

Pass your own table to give new roles or plugin permissions:

```ts
import { AccessControl, DEFAULT_ROLES } from "maa";

createCommerceApp({
  ...options,
  accessControl: new AccessControl({
    ...DEFAULT_ROLES,
    support: [...DEFAULT_ROLES.support, "coupons:read"],
    warehouse: ["inventory:*", "products:read", "orders:read-all"],
  }),
});
```

Any role other than `owner` and `customer` can be given to a staff account (`GET /staff/roles`).
