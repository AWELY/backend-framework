import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startTestApp, api, createProduct, createCart, registerCustomer, CONTACT, OWNER_KEY, TOKEN_SECRET, type TestApp } from "../helpers/test-app";
import { cashOnDelivery, createCommerceApp, Logger, ORDERS_SERVICE, signWebhookPayload } from "../../src/index";
import { hostedGateway } from "../../examples/plugins/hosted-gateway";

/**
 * انحدار لعيوب وجدتها مراجعة الكود بعد المراحل الخمس: كل اختبار يثبت إصلاحاً واحداً.
 */
let failRefund = false;
let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [
      cashOnDelivery(),
      hostedGateway({
        checkoutUrl: "https://pay.example/checkout",
        webhookSecret: "whsec",
        holdSeconds: 600,
        refund: async () => {
          if (failRefund) throw new Error("refused");
          return "GW-OK";
        },
      }),
    ],
    loginRateLimit: { maxFailures: 3, windowSeconds: 600 },
  });
});
after(async () => {
  await t.close();
});

async function paidOrder(productId: string, quantity: number, paymentMethod = "cod") {
  const cartId = await createCart(t.base, [{ productId, quantity }]);
  const order = (await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod } })).body;
  await t.app.container.resolve(ORDERS_SERVICE).setPaymentStatus(order.id, "paid");
  return order;
}

test("the same Idempotency-Key on two different orders' refunds runs both (scope includes the path)", async () => {
  const productId = await createProduct(t.base, { price: 1000 });
  const a = await paidOrder(productId, 1);
  const b = await paidOrder(productId, 1);
  const headers = { "idempotency-key": "refund-1" };
  const ra = await api(t.base, "POST", `/orders/${a.id}/refunds`, { owner: true, body: { amount: 500 }, headers });
  const rb = await api(t.base, "POST", `/orders/${b.id}/refunds`, { owner: true, body: { amount: 500 }, headers });
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.equal(rb.headers.get("idempotency-replayed"), null);
  assert.equal(rb.body.order.id, b.id);
});

test("refund restock is reserved before the money moves: a later cancel restocks only the rest, totals stay exact", async () => {
  const productId = await createProduct(t.base, { price: 1000, stock: 10 });
  const order = await paidOrder(productId, 3);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 7);
  const refund = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: 1000, restock: [{ productId, quantity: 1 }] } });
  assert.equal(refund.status, 201);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 8);
  const cancelled = await api(t.base, "PATCH", `/orders/${order.id}/status`, { owner: true, body: { status: "cancelled" } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.items[0].restockedQuantity, 3);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 10, "every item came back exactly once");
});

test("a refused gateway refund releases the reserved restock and the reserved amount", async () => {
  const productId = await createProduct(t.base, { price: 2000, stock: 5 });
  const order = await paidOrder(productId, 2, "hosted");
  failRefund = true;
  const res = await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: 1000, restock: [{ productId, quantity: 1 }] } });
  failRefund = false;
  assert.equal(res.status, 502);
  const after = (await api(t.base, "GET", `/orders/${order.id}`, { owner: true })).body;
  assert.equal(after.refundedTotal, 0);
  assert.equal(after.items[0].restockedQuantity, 0);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 3);
  const refunds = (await api(t.base, "GET", `/orders/${order.id}/refunds`, { owner: true })).body;
  assert.deepEqual(refunds.map((r: { status: string }) => r.status), ["failed"]);
});

test("an online order has a payment deadline from the moment it is created", async () => {
  const productId = await createProduct(t.base);
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = (await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "hosted" } })).body;
  // حدث order.created يُكتب داخل معاملة الشراء، قبل بدء الدفع: وجود المهلة فيه يثبت أنها تُضبط هناك،
  // فلو توقف الخادم قبل بدء الدفع، يبقى للطلب موعد إلغاء.
  const { rows } = await t.app.pool.query(
    "SELECT payload->'order'->>'paymentExpiresAt' AS deadline FROM outbox_events WHERE event = 'order.created' AND payload->'order'->>'id' = $1",
    [order.id]
  );
  assert.ok(rows[0]?.deadline, "the deadline is already in the order.created snapshot");
});

test("a payment that arrives after the order was cancelled is recorded and flagged for a refund", async () => {
  const productId = await createProduct(t.base, { stock: 2 });
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = (await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "hosted" } })).body;
  await t.app.pool.query("UPDATE orders SET payment_expires_at = now() - interval '1 second' WHERE id = $1", [order.id]);
  assert.equal(await t.app.container.resolve(ORDERS_SERVICE).releaseExpiredHolds(), 1);
  const body = JSON.stringify({ orderId: order.id, status: "paid" });
  const hook = await api(t.base, "POST", "/payments/hosted/webhook", { raw: body, headers: { "x-signature": signWebhookPayload(body, "whsec") } });
  assert.equal(hook.status, 200);
  const events = (await api(t.base, "GET", `/orders/${order.id}/events`, { owner: true })).body;
  assert.ok(events.some((e: { type: string; to: string; note: string }) => e.type === "payment" && e.to === "paid" && /refund/.test(e.note)));
});

test("order lines keep their order after a restock updates them", async () => {
  const a = await createProduct(t.base, { name: "Line A" });
  const b = await createProduct(t.base, { name: "Line B" });
  const cartId = await createCart(t.base, [{ productId: a, quantity: 2 }, { productId: b, quantity: 2 }]);
  const order = (await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "cod" } })).body;
  await t.app.container.resolve(ORDERS_SERVICE).setPaymentStatus(order.id, "paid");
  await api(t.base, "POST", `/orders/${order.id}/refunds`, { owner: true, body: { amount: 1, restock: [{ productId: a, quantity: 1 }] } });
  const names = (await api(t.base, "GET", `/orders/${order.id}`, { owner: true })).body.items.map((i: { productName: string }) => i.productName);
  assert.deepEqual(names, ["Line A", "Line B"]);
});

test("guessing the current password is rate limited like logins", async () => {
  const c = await registerCustomer(t.base);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await api(t.base, "POST", "/customers/me/password", { token: c.token, body: { currentPassword: "wrong-one", newPassword: "whatever-123" } })).status);
  }
  assert.deepEqual(statuses, [400, 400, 400, 429]);
});

test("the database being down is a 503 DATABASE_UNAVAILABLE, not a 500", async () => {
  const app = createCommerceApp({
    databaseUrl: "postgresql://nobody@127.0.0.1:1/none",
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    logger: new Logger("error"),
    workers: false,
    database: { connectionTimeoutMs: 1000 },
  });
  await app.listen(0);
  try {
    const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    const res = await api(base, "GET", "/products");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "DATABASE_UNAVAILABLE");
    assert.equal(res.headers.get("retry-after"), "5");
  } finally {
    await app.close();
  }
});

test("shutdownDelayMs: /readyz turns 503 while connections are still accepted", async () => {
  const app = await startTestApp({ resetDatabase: false, shutdownDelayMs: 400 });
  const closing = app.close();
  await new Promise((r) => setTimeout(r, 50));
  const ready = await api(app.base, "GET", "/readyz");
  assert.equal(ready.status, 503);
  assert.deepEqual(ready.body, { status: "shutting_down" });
  await closing;
});
