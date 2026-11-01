# Maa by example

Every feature of the framework, each with three parts:
1. **the HTTP exchange**;
2. **the real code in Maa Store** ([`storefront/`](../storefront/)) that uses it, with the file path, so you can open it and run it;
3. where it applies, **the framework side** (how to configure or extend it).

Run the store to try everything live:

```bash
cd storefront && npm install && npm run setup && npm run migrate && npm run seed && npm start
# site: http://localhost:5173   courier app: /courier.html   admin: /admin.html   API: http://localhost:3000
```

`npm run seed` prints development accounts: `admin@maa.ly / maa-admin-2026`,
`courier1@maa.ly / maa-courier-2026`, and the others. Amounts are integers in dirhams
(1 LYD = 1000).

## Contents

1. [Building a store app](#1-building-a-store-app)
2. [Errors, error codes and request ids](#2-errors-error-codes-and-request-ids)
3. [Catalogue: search, sort, pagination](#3-catalogue-search-sort-pagination)
4. [Products by slug and variants](#4-products-by-slug-and-variants)
5. [Stock per product and per variant](#5-stock-per-product-and-per-variant)
6. [Cart](#6-cart)
7. [Checkout options and quotes (shipping, coupons, tax)](#7-checkout-options-and-quotes)
8. [Placing an order safely (Idempotency-Key)](#8-placing-an-order-safely)
9. [Online payment: redirect, signed webhook, payment hold](#9-online-payment)
10. [Customer accounts and sessions](#10-customer-accounts-and-sessions)
11. [Password reset through an event](#11-password-reset-through-an-event)
12. [Order tracking and timeline](#12-order-tracking-and-timeline)
13. [Staff login, roles and owner mode](#13-staff-login-roles-and-owner-mode)
14. [Managing orders: status, payment, refunds](#14-managing-orders)
15. [Delivery: assigning couriers and the courier app](#15-delivery)
16. [Editing products without lost updates (ETag / If-Match)](#16-editing-without-lost-updates)
17. [Clearing a field (nullable PATCH)](#17-clearing-a-field)
18. [Coupons](#18-coupons)
19. [Customers, staff and the audit log in the admin](#19-customers-staff-and-the-audit-log)
20. [Events and notifications](#20-events-and-notifications)
21. [Background jobs](#21-background-jobs)
22. [Rate limits](#22-rate-limits)
23. [Health, readiness, metrics and logs](#23-health-readiness-metrics-and-logs)
24. [Graceful shutdown](#24-graceful-shutdown)
25. [Configuration and secret rotation](#25-configuration-and-secret-rotation)
26. [API versioning with basePath](#26-api-versioning-with-basepath)
27. [OpenAPI](#27-openapi)
28. [Security headers and CORS](#28-security-headers-and-cors)
29. [Typed handlers with withInput](#29-typed-handlers-with-withinput)
30. [Transactions, retries and the outbox in your own code](#30-transactions-retries-and-the-outbox-in-your-own-code)
31. [Replacing a service through DI](#31-replacing-a-service-through-di)
32. [Testing your store](#32-testing-your-store)

---

## 1. Building a store app

The whole Maa Store API is one call. `optionsFromConfig` maps the validated `.env` to framework
options. The store adds only what is specific to it.

**Storefront:** [`storefront/api/app.js`](../storefront/api/app.js)

```js
const app = createCommerceApp({
  ...optionsFromConfig(config, new Logger(logLevel ?? config.logLevel, { format: config.logFormat })),
  checkoutRateLimit: { maxFailures: 30, windowSeconds: 10 * 60 },
  cartCreationRateLimit: { maxFailures: 200, windowSeconds: 60 * 60 },
  plugins: [
    cityRateShipping({ name: "توصيل للمنزل", rates: DELIVERY_RATES, freeOver: 500000 }),
    flatRateShipping({ id: "pickup", name: "استلام من المحل - تاجوراء", rate: 0 }),
    cashOnDelivery({ name: "الدفع نقداً عند الاستلام", instructions: "ادفع نقداً للمندوب..." }),
    demoCardGateway({ payPageUrl: `${webOrigin}/pay.html`, webhookSecret }),   // a third-party plugin in plain JS
    coupons(),
    devMailbox({ webOrigin, enabled: demoMode }),                               // another one
  ],
});
```

`npm run migrate` ([`storefront/api/migrate.js`](../storefront/api/migrate.js)) builds the same
app and calls `app.migrate()`. That applies the framework's runtime tables, every module's tables
and every plugin's tables, in id order, under an advisory lock, each in its own transaction.

## 2. Errors, error codes and request ids

Every error has the same shape. The `code` is a stable contract; the `message` is for humans.

```http
POST /carts/7e1c…/items
{"productId":"5ff6…","quantity":5}

HTTP/1.1 409 Conflict
X-Request-Id: 3f2a9c1e-…
{"error":{"code":"INSUFFICIENT_STOCK","message":"Insufficient stock",
          "details":{"productId":"5ff6…","variantId":null,"available":2,"requested":5},
          "requestId":"3f2a9c1e-…"}}
```

**Storefront:** [`storefront/web/js/api.js`](../storefront/web/js/api.js) turns every failure
into an `ApiError` carrying `code` and `requestId`.
[`storefront/web/js/ui.js`](../storefront/web/js/ui.js) maps codes to Arabic messages, never
message text:

```js
switch (err.code) {
  case "INSUFFICIENT_STOCK": {
    const available = err.details?.available;
    return available !== undefined ? `الكمية غير متوفرة. المتوفر حالياً: ${available}` : "...";
  }
  case "VARIANT_REQUIRED": return "اختر النوع (اللون أو المقاس) أولاً.";
  case "INVALID_COUPON":   return couponMessage(err.message);
  case "PRECONDITION_FAILED": return "عدّل شخص آخر هذا العنصر قبلك...";
  // ...
}
return `حدث خطأ غير متوقع، حاول مرة أخرى. (رقم المرجع: ${err.requestId.slice(0, 8)})`;
```

When a customer reports "reference 3f2a9c1e", search the logs for `requestId=3f2a9c1e…`. Every
log line of that request carries it. Send your own `X-Request-Id` from a proxy or client to trace
across systems.

**Framework side:** throw `AppError` subclasses with a code:
`throw new ConflictError("...", details, "MY_CODE")`. The full list is `ErrorCodes` in
[`src/engine/errors.ts`](../src/engine/errors.ts).

## 3. Catalogue: search, sort, pagination

```http
GET /products?q=باور&sort=price_asc&limit=12&offset=0&categoryId=1fd1…

HTTP/1.1 200 OK
X-Total-Count: 2
[{"id":"…","name":"باور بانك 10000 مللي أمبير","price":65000,"version":1,…}, …]
```

Sorts: `newest` (the default), `price_asc`, `price_desc`, `name`. `limit` is 1–100 and `offset`
is 0 or more; anything else returns `400` with `field: "query.limit"`. The owner and staff also
see inactive products.

**Storefront:** [`storefront/web/js/pages/home.js`](../storefront/web/js/pages/home.js)

```js
const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), sort });
if (categoryId) query.set("categoryId", categoryId);
if (search) query.set("q", search);
const { items: products, total } = await apiPage(`/products?${query}`);   // total from X-Total-Count
const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
```

The category tiles count products cheaply, with `limit=1` and the header:

```js
const { items, total } = await apiPage(`/products?categoryId=${encodeURIComponent(c.id)}&limit=1`);
```

## 4. Products by slug and variants

```http
GET /products/by-slug/sport-smartwatch

HTTP/1.1 200 OK
ETag: "1"
{"id":"…","name":"ساعة ذكية رياضية","price":250000,
 "variants":[{"id":"…","sku":"WATCH-SPT-42","title":"مقاس 42 ملم","price":null,"isActive":true,"position":0},
             {"id":"…","sku":"WATCH-SPT-46","title":"مقاس 46 ملم","price":270000,"isActive":true,"position":1}]}
```

A variant with `price: null` uses the product price. A product that has active variants can only
be added to a cart with a `variantId`; otherwise you get `400 VARIANT_REQUIRED`.

**Storefront:** [`storefront/web/js/pages/product.js`](../storefront/web/js/pages/product.js)
renders a chip per variant with its own price and stock, then sends the chosen variant:

```js
const priceOf = (v) => (v && v.price !== null ? v.price : product.price);
const quantityOf = (v) => (variants.length ? (v ? (variantStock.get(v.id) ?? 0) : 0) : stock.quantity);
await addToCart(product.id, quantity(), selected?.id);
```

**Admin:** [`storefront/web/js/staff/admin-catalog.js`](../storefront/web/js/staff/admin-catalog.js)
adds, hides and deletes variants:

```js
await sapi(`/products/${id}/variants`, { method: "POST",
  body: { title: "أسود", sku: "CASE-BLK", position: 0, price: toDirhams("27.5") } });
await sapi(`/products/${id}/variants/${variantId}`, { method: "PATCH", body: { isActive: false } });
```

## 5. Stock per product and per variant

```http
GET /inventory/5ff6…
{"productId":"5ff6…","quantity":0,"inStock":false,
 "variants":[{"variantId":"…","sku":"CASE-SIL-BLK","quantity":25,"inStock":true}, …]}

PUT  /inventory/5ff6…                      {"quantity":40}     (inventory:write)
POST /inventory/5ff6…/adjust               {"delta":-1}
PUT  /inventory/variants/<variantId>       {"quantity":25}
POST /inventory/variants/<variantId>/adjust {"delta":10}
```

Decrements are atomic (`UPDATE … WHERE quantity + delta >= 0`), so the last item is never sold
twice. Every manual change publishes `inventory.changed`.

**Storefront:** the product card shows "choose variant (3)" when the level has variants
([`ui.js` → `productCard`](../storefront/web/js/ui.js)). The admin saves variant stock on change:

```js
input.addEventListener("change", () =>
  run(() => sapi(`/inventory/variants/${input.dataset.vstock}`, { method: "PUT", body: { quantity: Number(input.value) } }), "تم حفظ مخزون الشكل"));
```

## 6. Cart

```http
POST /carts                                         → 201 {"id":"671451ae-…","items":[],"total":0,…}
POST /carts/671451ae-…/items  {"productId":"…","variantId":"…","quantity":1}
PUT  /carts/671451ae-…/items/<productId>?variantId=<variantId>   {"quantity":3}   (0 removes the line)
DELETE /carts/671451ae-…/items/<productId>?variantId=<variantId>
GET  /carts/mine        (logged-in customer: the open cart, or 204 when there is none)
```

Lines carry `variantId`, `sku`, `variantTitle`, the current `unitPrice` and `available: false`
when a product was hidden after being added.

**Storefront:** [`storefront/web/js/api.js`](../storefront/web/js/api.js). A logged-in
customer finds their cart on any device:

```js
if (getToken()) {
  const mine = await api("/carts/mine");   // 204 arrives as null
  if (mine) { setCartId(mine.id); return mine; }
}
```

[`storefront/web/js/pages/cart.js`](../storefront/web/js/pages/cart.js) addresses each line by
product and variant:

```js
export function linePath(cartId, productId, variantId) {
  return `/carts/${cartId}/items/${encodeURIComponent(productId)}${variantId ? `?variantId=${encodeURIComponent(variantId)}` : ""}`;
}
```

## 7. Checkout options and quotes

```http
GET /checkout/options
{"currency":"LYD","couponsEnabled":true,
 "shippingMethods":[{"id":"city-rate","name":"توصيل للمنزل","cities":["تاجوراء","طرابلس",…]},{"id":"pickup",…}],
 "paymentMethods":[{"id":"cod","name":"الدفع نقداً عند الاستلام"},{"id":"card","name":"بطاقة مصرفية (تجريبي)"}]}

POST /checkout/quote
{"cartId":"…","shippingAddress":"لحساب سعر التوصيل","shippingMethod":"city-rate","shippingCity":"طرابلس","couponCode":"WELCOME10"}

{"currency":"LYD","subtotal":270000,"shippingMethod":"city-rate","shippingCost":10000,
 "adjustments":[{"code":"COUPON:WELCOME10","label":"Coupon WELCOME10 (10%)","type":"discount","amount":27000,"source":"coupons"}],
 "adjustmentsTotal":-27000,"total":253000}
```

A quote never changes anything. An invalid coupon returns `400 INVALID_COUPON`.

**Storefront:** [`storefront/web/js/pages/checkout.js`](../storefront/web/js/pages/checkout.js)
re-quotes on every change and renders the adjustment lines:

```js
const quote = await api("/checkout/quote", { method: "POST", body: {
  cartId: cart.id, shippingAddress: QUOTE_ADDRESS, shippingMethod: method?.id,
  ...(method?.cities ? { shippingCity: citySelect.value } : {}),
  ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
} });
adjustmentsEl.innerHTML = quote.adjustments.map((a) => `<div class="line adjustment ${esc(a.type)}">…−${money(a.amount)}</div>`).join("");
```

**Framework side:** shipping comes from shipping providers, coupons and tax from price
adjusters. See [EXTENDING.md](EXTENDING.md#price-adjusters-discounts-tax-fees). Add tax with
`percentageTax({ ratePercent: 5 })`.

## 8. Placing an order safely

```http
POST /orders
Idempotency-Key: 0b3f6c1e-8a1d-4e3f-9f0a-2c3d4e5f6a7b
{"cartId":"…","contactName":"أحمد الورفلي","contactPhone":"0913334455","shippingAddress":"حي الأندلس…",
 "shippingCity":"طرابلس","shippingMethod":"city-rate","paymentMethod":"cod","couponCode":"WELCOME10"}

HTTP/1.1 201 Created
{"id":"d3ac…","status":"pending","total":253000,"paymentStatus":"pending","paymentExpiresAt":null,
 "adjustments":[…],"items":[{"sku":"WATCH-SPT-46","variantTitle":"مقاس 46 ملم",…}],
 "payment":{"status":"pending","instructions":"ادفع نقداً للمندوب…"}}
```

Send the same request with the same key again (a retry after a timeout) and you get the same
`201` and the same order, plus `Idempotency-Replayed: true`. Without the key, the second request
gets `409 CART_CHECKED_OUT`. The same key with a different body gets
`409 IDEMPOTENCY_KEY_REUSED`.

**Storefront:** [`storefront/web/js/pages/checkout.js`](../storefront/web/js/pages/checkout.js)
keeps one key per attempt and rotates it when the form changes:

```js
let idempotencyKey = newKey();
form.addEventListener("input", () => { idempotencyKey = newKey(); });
const order = await api("/orders", { method: "POST", idempotencyKey, body: { cartId: cart.id, … } });
if (order.payment?.redirectUrl) { location.href = order.payment.redirectUrl; return; }
```

Under the hood, checkout locks the cart, prices it, decrements stock in a fixed order (no
deadlocks: 500 concurrent checkouts in `tests/integration/concurrency.test.ts`), stores a price
snapshot, writes the timeline and the `order.created` event, and commits. Only then does it call
the payment provider.

## 9. Online payment

The card gateway is a plugin in plain JavaScript that uses only the public API:
[`storefront/api/plugins/demo-card-gateway.js`](../storefront/api/plugins/demo-card-gateway.js).

```js
extensions.addPaymentProvider({
  id: "card",
  holdSeconds,                                  // stock held 15 minutes; unpaid orders are cancelled and restocked
  initiate: (order) => ({ status: "pending", reference: `DEMO-${order.id.slice(0, 8)}`,
                          redirectUrl: `${payPageUrl}?order=${order.id}&phone=${order.contactPhone}` }),
  refund: async (order, amount) => ({ reference: `DEMO-RF-${Date.now().toString(36).toUpperCase()}` }),
});

router.post("/payments/card/webhook", async (req, res) => {
  const ok = verifyWebhookSignature({ payload: req.rawBody, header: req.headers["x-demo-signature"], secret: webhookSecret });
  if (!ok) throw new UnauthorizedError("Invalid webhook signature");
  const body = validate(webhookSchema, req.body);
  const order = await container.resolve(ORDERS_SERVICE).setPaymentStatus(body.orderId, body.status, body.reference);
  res.json({ ok: true, paymentStatus: order.paymentStatus });
});
```

The webhook flow:
1. The bank page ([`web/pay.html`](../storefront/web/pay.html) and
   [`js/pages/pay.js`](../storefront/web/js/pages/pay.js)) posts the card result to `/payments/card/simulate`.
2. That endpoint stands in for the bank's servers: it sends a real HTTP webhook, signed with
   `signWebhookPayload`.
3. The webhook verifies the signature on the raw bytes and marks the order paid.
4. A duplicate webhook changes nothing: repeating the same status is a no-op.

```http
POST /payments/card/webhook
X-Demo-Signature: t=1730500000,v1=5b1d…
{"orderId":"d3ac…","status":"paid","reference":"DEMO-PAY-MVYFZZ55"}
→ 200 {"ok":true,"paymentStatus":"paid"}            (paying also clears paymentExpiresAt)
```

If the customer never pays, the `orders.releaseExpiredHolds` job (every minute) cancels the
order. Stock comes back, and the timeline says `status: cancelled (payment_expired)`. The track
page shows a "pay now" button until then
([`order-view.js`](../storefront/web/js/order-view.js)).

## 10. Customer accounts and sessions

```http
POST /customers/register  {"email":"mariam@example.ly","password":"…","name":"مريم","phone":"0917778899","guestCartId":"671451ae-…"}
→ 201 {"customer":{…},"token":"eyJ…","cartId":"671451ae-…"}       (the guest cart now belongs to the account)

POST /customers/login     {"email":"…","password":"…","guestCartId":"…"}  → {"customer":{…},"token":"…","cartId":"…"}
GET  /customers/me/sessions   → [{"id":"…","createdAt":"…","userAgent":"Mozilla/…","current":true}, …]
POST /customers/logout        → 204   (this device)
POST /customers/logout-all    → 204   (every device)
POST /customers/me/password   {"currentPassword":"…","newPassword":"…"} → 204 (other devices are logged out)
```

Tokens carry a session id that is checked on every request. A revoked token gets
`401 INVALID_TOKEN` immediately, with no waiting for expiry. A wrong password and an unknown
email give the same `401 INVALID_CREDENTIALS`, in the same time.

**Storefront:** [`storefront/web/js/pages/account.js`](../storefront/web/js/pages/account.js)

```js
const guestCartId = getCartId();
const result = await api(path, { method: "POST", body: { ...data, ...(guestCartId ? { guestCartId } : {}) } });
saveSession(result.token, result.customer);
if (result.cartId) setCartId(result.cartId);
```

Logout revokes the session on the server before forgetting the token
([`api.js` → `logoutCustomer`](../storefront/web/js/api.js)):

```js
await api(everywhere ? "/customers/logout-all" : "/customers/logout", { method: "POST" }).catch(() => undefined);
clearSession();
```

## 11. Password reset through an event

```http
POST /customers/password-reset          {"email":"mariam@example.ly"}   → 202 {"status":"accepted"}   (also for unknown emails)
POST /customers/password-reset/confirm  {"token":"g08SSF…","password":"new-password"} → 200 {"status":"ok"}
```

The framework never sends email itself. It publishes `customer.passwordResetRequested` with the
token, and a plugin delivers it. The token is stored hashed, works once, and expires in 30
minutes. The event payload is wiped from the outbox after delivery.

**Storefront:** the dev mailbox plugin
([`storefront/api/plugins/dev-mailbox.js`](../storefront/api/plugins/dev-mailbox.js)) is where
a real store would send an email or SMS:

```js
extensions.on("customer.passwordResetRequested", ({ customer, token }, meta) => {
  send(meta, customer.email, "استعادة كلمة المرور", `${webOrigin}/reset.html?token=${encodeURIComponent(token)}`);
});
```

[`reset.js`](../storefront/web/js/pages/reset.js) confirms with the token. In demo mode,
[`account.js`](../storefront/web/js/pages/account.js) shows the link from `GET /dev/mailbox`.

## 12. Order tracking and timeline

```http
GET /orders/51dc…?phone=0925556677             (guest: order id + the phone used, both required)
GET /orders/51dc…/events?phone=0925556677
[{"at":"…","type":"created","to":"pending","actorType":"guest"},
 {"type":"payment","from":"unpaid","to":"pending","actorType":"system"},
 {"type":"status","from":"pending","to":"confirmed","actorType":"staff","note":"Confirmed on assignment"},
 {"type":"delivery","to":"assigned","actorType":"staff"},
 {"type":"status","to":"shipped","actorType":"staff"}, {"type":"delivery","to":"picked_up"},
 {"type":"status","to":"delivered"}, {"type":"payment","to":"paid"}, {"type":"delivery","to":"delivered"}]
GET /orders/51dc…/delivery?phone=0925556677
{"status":"delivered","courierName":"سالم المندوب","courierPhone":"0920000001",…}
```

**Storefront:** [`storefront/web/js/order-view.js`](../storefront/web/js/order-view.js), used by
both [`track.js`](../storefront/web/js/pages/track.js) and
[`orders.js`](../storefront/web/js/pages/orders.js):

```js
const [events, delivery] = await Promise.all([
  api(`/orders/${order.id}/events${q}`).catch(() => []),
  ["confirmed", "shipped", "delivered"].includes(order.status) ? api(`/orders/${order.id}/delivery${q}`).catch(() => null) : null,
]);
```

A logged-in customer pages through their orders with
`GET /orders?limit=10&offset=…` (only their own) and `X-Total-Count`.

## 13. Staff login, roles and owner mode

```http
POST /staff/login {"email":"admin@maa.ly","password":"maa-admin-2026"}
→ {"staff":{"id":"…","name":"مدير المتجر","role":"admin",…},"token":"…"}
GET  /staff/roles   → ["admin","manager","support","courier"]
```

| Role | Can |
|---|---|
| `admin` | catalogue, stock, all orders including refunds and assignment, deliveries, coupons, read customers, staff and audit |
| `manager` | catalogue, stock, orders (no refunds), assignment, read deliveries, coupons and customers |
| `support` | read orders and change their status and payment, read customers |
| `courier` | only their own deliveries |
| owner (API key) | everything, including creating staff (`staff:write`) |

Changing a role or deactivating an account revokes its sessions at once.

**Storefront:** [`storefront/web/js/staff/common.js`](../storefront/web/js/staff/common.js). The
admin dashboard and the courier app share the login. The owner can log in with the API key,
which is kept in `sessionStorage` only:

```js
const result = await api("/staff/login", { method: "POST", auth: "none", body: { email, password } });
if (allowedRoles && !allowedRoles.includes(result.staff.role)) { /* log the session out again */ }
saveStaffSession(result.token, result.staff);
```

The UI hides what a role cannot do (`can("orders:refund")`). The server enforces it either way.

## 14. Managing orders

```http
GET   /orders?status=pending&paymentStatus=failed&q=0925&limit=20&offset=0      (orders:read-all; q = id prefix, name or phone)
PATCH /orders/:id/status   {"status":"confirmed","note":"اتصلنا بالزبون"}            (orders:write)
PATCH /orders/:id/payment  {"status":"paid","reference":"CASH-123"}                 (pending | paid | failed)
POST  /orders/:id/refunds  Idempotency-Key: …
      {"amount":100000,"reason":"إرجاع الساعة","restock":[{"productId":"…","variantId":"…","quantity":1}]}   (orders:refund)
→ 201 {"order":{"paymentStatus":"partially_refunded","refundedTotal":100000,…},
       "refund":{"status":"succeeded","reference":"DEMO-RF-MVYG2JL3",…}}
GET   /orders/:id/refunds
```

The rules:
- Invalid status moves return `409 INVALID_STATUS_TRANSITION` and list the allowed targets.
- Payment follows its own state machine: `paid → pending` is `409 INVALID_PAYMENT_TRANSITION`.
- A refund larger than what is left returns `409 REFUND_EXCEEDS_PAID`.
- When the gateway refuses a refund, you get `502 PAYMENT_PROVIDER_ERROR` and nothing changes.

**Storefront:** [`storefront/web/js/staff/admin-orders.js`](../storefront/web/js/staff/admin-orders.js)
shows only the transitions that are allowed now, and refunds with an idempotency key:

```js
const key = newKey();   // two quick clicks never refund twice
await sapi(`/orders/${id}/refunds`, { method: "POST", idempotencyKey: key,
  body: { amount: toDirhams(refundForm.amount.value), reason, ...(restock.length ? { restock } : {}) } });
```

## 15. Delivery

```http
POST /orders/:id/delivery         {"courierId":"…"}         (orders:assign; a pending order is confirmed)
GET  /deliveries?status=assigned                          (a courier sees only their own; staff see all)
[{"orderId":"…","status":"assigned","courierName":"سالم المندوب",
  "order":{"contactName":"فاطمة الزنتاني","contactPhone":"0925556677","shippingAddress":"…","total":225000,"paymentStatus":"pending","itemCount":2}}]
POST /deliveries/:orderId/pickup                          → order becomes shipped
POST /deliveries/:orderId/deliver {"cashCollected":225000,"note":"سُلّم للحارس"}   → delivered; cash orders become paid
POST /deliveries/:orderId/fail    {"note":"الزبون لا يرد على الهاتف"}            → can be reassigned
```

For an unpaid order, `cashCollected` must equal the order total. A courier touching someone
else's delivery gets `404`.

**Courier app:** [`storefront/web/courier.html`](../storefront/web/courier.html) and
[`js/staff/courier.js`](../storefront/web/js/staff/courier.js), built phone-first:

```js
const pages = await Promise.all(["assigned", "picked_up", "failed"].map((s) => sapiPage(`/deliveries?status=${s}&limit=100`)));
await sapi(`/deliveries/${orderId}/pickup`, { method: "POST" });
await sapi(`/deliveries/${job.orderId}/deliver`, { method: "POST", body: { cashCollected: toDirhams(form.cash.value) } });
```

**Admin:** the order detail lists active couriers from `GET /staff?role=courier` and assigns
with one click ([`admin-orders.js`](../storefront/web/js/staff/admin-orders.js)).

## 16. Editing without lost updates

```http
GET   /products/:id                      → ETag: "1"
PATCH /products/:id   If-Match: "1"      → 200, ETag: "2"
PATCH /products/:id   If-Match: "1"      → 412 {"error":{"code":"PRECONDITION_FAILED","details":{"currentVersion":2},…}}
DELETE /products/:id  If-Match: "2"      → 204
```

This works the same for categories. `If-Match` is optional: without it, the last write wins, as
before.

**Storefront:** [`storefront/web/js/staff/admin-catalog.js`](../storefront/web/js/staff/admin-catalog.js)

```js
const res = await srequest(`/products/${id}`);
etag = res.headers.get("ETag");
// ... on save:
run(() => sapi(`/products/${id}`, { method: "PATCH", body: data, ifMatch: etag }), "تم حفظ المنتج");
// on 412: reload the latest version and tell the user someone else changed it first
```

## 17. Clearing a field

`null` clears a nullable field. A missing field stays untouched.

```http
PATCH /products/:id  {"categoryId":null,"imageUrl":null}
PATCH /customers/me  {"phone":null}
```

**Storefront:** the product form sends `categoryId: f.categoryId.value || null`
([`admin-catalog.js`](../storefront/web/js/staff/admin-catalog.js)). The profile form sends
`phone: phone || null` ([`account.js`](../storefront/web/js/pages/account.js)).

## 18. Coupons

The built-in [`coupons()`](../src/plugins/coupons.ts) plugin:

```http
POST   /coupons  {"code":"ramadan15","kind":"percent","value":15,"minSubtotal":100000,"maxRedemptions":200,"expiresAt":"2027-03-30T23:59:59Z"}
GET    /coupons            → [{"code":"RAMADAN15","redeemedCount":0,…}]   with X-Total-Count
PATCH  /coupons/RAMADAN15  {"isActive":false}
DELETE /coupons/RAMADAN15
```

- Codes are stored in upper case.
- Usage is counted from `order.created` (idempotent per order) and released when the order is
  cancelled.
- Fixed coupons never discount more than the subtotal.

**Storefront:** the checkout field (section 7), and the admin coupons page (`couponsView` in
[`admin.js`](../storefront/web/js/staff/admin.js)):

```js
const body = { code, kind: f.kind.value,
  value: f.kind.value === "percent" ? Math.round(Number(f.value.value)) : toDirhams(f.value.value), … };
await sapi("/coupons", { method: "POST", body });
```

## 19. Customers, staff and the audit log

```http
GET   /customers?q=mariam                     (customers:read)
POST  /staff   {"email":"courier3@maa.ly","password":"…","name":"…","role":"courier","phone":"0920000003"}   (owner only)
PATCH /staff/:id  {"role":"manager"} | {"isActive":false} | {"password":"…"}     (each revokes the member's sessions)
GET   /audit-log?action=PATCH%20/orders&limit=50
[{"at":"…","actorType":"staff","actorRole":"admin","action":"POST /orders/:id/refunds","statusCode":201,
  "params":{"id":"…"},"body":{"amount":100000,…},"requestId":"5a6ec87f-…","ip":"::1"}, …]
```

Every write by the owner or a staff member is recorded automatically, including failed attempts
and staff logins. Passwords and tokens are redacted.

**Storefront:** `customersView`, `staffView` and `auditView` in
[`admin.js`](../storefront/web/js/staff/admin.js).

## 20. Events and notifications

**Storefront:** the dev mailbox listens to three events and turns them into messages
([`dev-mailbox.js`](../storefront/api/plugins/dev-mailbox.js)):

```js
extensions.on("order.created", ({ order }, meta) => {
  send(meta, order.contactPhone, "تم استلام طلبك", `رقم الطلب ${order.id.slice(0, 8)} — تتبّعه: …`);
});
extensions.on("order.deliveryChanged", ({ order, delivery }, meta) => {
  send(meta, order.contactPhone, "تحديث التوصيل", { picked_up: `طلبك في الطريق إليك مع ${delivery.courierName}`, … }[delivery.status]);
});
// send() ignores a meta.id it has already seen: at-least-once delivery made idempotent.
```

All 12 events and the delivery guarantees are in
[EXTENDING.md → Events](EXTENDING.md#events). In tests, call `await app.drainBackgroundWork()`
to deliver everything that is pending before you assert.

## 21. Background jobs

The framework schedules its own jobs:
- `orders.releaseExpiredHolds`: every minute;
- `cart.cleanupAbandoned`: daily, deletes guest carts untouched for 30 days;
- `system.cleanup`: hourly, expires keys, sessions and processed events.

Add yours:

```js
setup({ jobs, pool }) {
  jobs.define("reports.dailySales", async (_payload, { logger }) => {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total FROM orders WHERE created_at > now() - interval '1 day'");
    logger.info("Daily sales", rows[0]);
  });
  jobs.schedule("reports.dailySales", 24 * 60 * 60 * 1000);   // runs once per day across all instances
}
```

## 22. Rate limits

The counters live in PostgreSQL, so every instance shares them:

| Limit | Default | Option |
|---|---|---|
| Failed logins (customer and staff), per IP and per email | 10 / 15 min | `loginRateLimit` |
| Registrations per IP | 5 / hour | `registrationRateLimit` |
| Password reset requests per IP and per email | 5 / hour | `passwordResetRateLimit` |
| Orders per IP | off | `checkoutRateLimit` |
| Carts per IP | off | `cartCreationRateLimit` |

A blocked request returns `429 RATE_LIMITED` with `Retry-After`. Maa Store enables the last two
([`app.js`](../storefront/api/app.js)) and shows the wait in minutes
([`ui.js`](../storefront/web/js/ui.js) → `RATE_LIMITED`). Behind a reverse proxy, set
`TRUST_PROXY=true`, or every customer shares the proxy's IP.

## 23. Health, readiness, metrics and logs

```http
GET /health   → {"status":"ok","database":"ok"}                 (503 when the database is down)
GET /livez    → {"status":"ok"}                                  (process alive; does not touch the database)
GET /readyz   → {"status":"ready"}  or 503 {"status":"migrations_pending","pending":["0990_…"]} or {"status":"shutting_down"}
GET /metrics  (Authorization: Bearer $METRICS_TOKEN when set)
http_requests_total{method="GET",route="/products/:id",status="200"} 42
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/products/:id"} 40
db_pool_connections{state="waiting"} 0
outbox_events_total{event="order.created",result="delivered"} 7
jobs_total{name="orders.releaseExpiredHolds",result="done"} 60
```

Routes are labelled by pattern (`/products/:id`), never by raw URL. With `LOG_FORMAT=json`, every
line is structured:

```json
{"time":"2026-11-02T01:10:44.120Z","level":"info","msg":"POST /orders 201 38ms","requestId":"3f2a…","method":"POST","path":"/orders","route":"/orders","status":201,"durationMs":38.4}
```

Query strings are never logged, so the phone numbers in tracking links stay out of the logs.

## 24. Graceful shutdown

**Storefront:** [`storefront/api/index.js`](../storefront/api/index.js)

```js
await app.listen(config.port);
installShutdownHandlers(app, { timeoutMs: config.shutdownTimeoutMs });
```

On SIGTERM (`docker stop`) or Ctrl+C, in order:
1. `/readyz` turns 503 and new connections are refused.
2. In-flight requests finish, up to the timeout.
3. The background worker finishes its current cycle.
4. Plugins stop in reverse order.
5. The database pool closes.

A second Ctrl+C exits immediately.

## 25. Configuration and secret rotation

```bash
$ PORT=abc LOG_LEVEL=verbose TRUST_PROXY=yes node dist/dev-server.js
Invalid configuration:
  - PORT must be an integer between 0 and 65535, got "abc"
  - LOG_LEVEL must be one of debug, info, warn, error, got "verbose"
  - TRUST_PROXY must be "true" or "false", got "yes"
```

To rotate without logging anyone out:

```bash
AUTH_TOKEN_SECRET=<new>        AUTH_TOKEN_SECRET_PREVIOUS=<old>    # new tokens use <new>, old tokens still work
OWNER_API_KEY=<new>            OWNER_API_KEY_PREVIOUS=<old>        # update your tools, then remove PREVIOUS
```

## 26. API versioning with basePath

```bash
API_BASE_PATH=/v1
```

```http
GET /v1/products   → 200
GET /products      → 404
GET /health        → 200   (system routes stay at the root, for load balancers and Prometheus)
```

## 27. OpenAPI

`GET /openapi.json` returns OpenAPI 3.1, generated from the route schemas, authenticators,
permissions and headers. It cannot drift from the code. `npm run openapi` writes
[`docs/openapi.json`](openapi.json), and CI fails if it is stale. Import it into Postman, or
generate a typed client from it.

## 28. Security headers and CORS

Every API response carries `X-Content-Type-Options: nosniff`, a `default-src 'none'` CSP,
`X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Authenticated responses also get
`Cache-Control: no-store`, and `HSTS=true` adds `Strict-Transport-Security` behind HTTPS.

```bash
CORS_ORIGIN=https://shop.ly,https://admin.shop.ly
```

The allowed origin is reflected back with `Vary: Origin`. `X-Total-Count`, `ETag`,
`X-Request-Id`, `Retry-After` and `Idempotency-Replayed` are exposed to browser code. Maa Store's
own web server adds a strict CSP for the pages
([`storefront/web-server.js`](../storefront/web-server.js)), and its browser test fails on any
CSP violation and checks that product names are rendered as text (XSS).

## 29. Typed handlers with withInput

```ts
import { withInput, requirePermission, type Schema } from "maa";

const noteSchema = { text: { type: "string", minLength: 1, maxLength: 500 }, pinned: { type: "boolean", optional: true } } as const satisfies Schema;

router.post(
  "/orders/:id/notes",
  authenticate,
  requirePermission(accessControl, "orders:write"),
  withInput({ params: { id: { type: "string" } }, body: noteSchema, summary: "Add a note" }, async (req, res, { params, body }) => {
    // body: { text: string; pinned?: boolean }, typed from the schema; no casts
    res.status(201).json(await notes.add(params.id, body.text, body.pinned ?? false));
  })
);
```

The validator supports:
- `string`, `number`, `boolean`, `object` (nested) and `array`;
- `optional` and `nullable`;
- `oneOf`, which is typed as a literal union;
- min, max and pattern constraints.

Unknown fields are rejected at every level. Body, query and params problems come back together
in one `400`, with field paths like `restock[1].quantity` and `query.limit`.

## 30. Transactions, retries and the outbox in your own code

```ts
import { withTransaction, ORDERS_SERVICE } from "maa";

const result = await withTransaction(pool, async (client) => {
  // everything here commits together or not at all;
  // on deadlock or serialization failure, the whole function is retried (3 times by default), then 503
  await client.query("UPDATE loyalty_points SET points = points - $2 WHERE customer_id = $1", [customerId, cost]);
  await events.publish(client, "inventory.changed", { productId, variantId: null, quantity, reason: "loyalty" });
});
events.notify();   // deliver now instead of at the next poll
```

Keep calls to the outside world (gateways, email) outside the transaction. A retry re-runs the
function.

## 31. Replacing a service through DI

[`examples/plugins/cached-products.ts`](../examples/plugins/cached-products.ts):

```ts
setup({ container, pool, extensions }) {
  const repo = new CachedProductsRepository(pool, options.ttlMs ?? 30_000);
  container.register(PRODUCTS_REPOSITORY, () => repo);                 // every product read now goes through the cache
  extensions.on("product.updated", ({ product }) => repo.forget(product.id));
  extensions.on("product.deleted", ({ productId }) => repo.forget(productId));
}
```

## 32. Testing your store

The framework's own helpers show the pattern
([`tests/helpers/test-app.ts`](../tests/helpers/test-app.ts)): a real server on a random port
against a disposable database whose name contains `test`.

```ts
const t = await startTestApp({ plugins: [cashOnDelivery(), coupons()] });
const productId = await createProduct(t.base, { price: 10_000, stock: 5 });
const cartId = await createCart(t.base, [{ productId, quantity: 2 }]);
const order = await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "cod" } });
await t.app.drainBackgroundWork();          // deliver events before asserting on listeners
await t.close();
```

The storefront's browser test ([`storefront/tests/browser.mjs`](../storefront/tests/browser.mjs))
drives headless Chrome through the customer, admin and courier flows with no extra dependencies.
