import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, createProduct, createCart, CONTACT, type TestApp } from "../helpers/test-app";

/**
 * اختبار الخروج من المرحلة الأولى: الصحة تحت التزامن.
 * قبل الإصلاح، 60 شراء متزامن بترتيب منتجات معاكس فشل منها 51 بـ 500 (deadlock).
 */
let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

async function inBatches<T>(count: number, size: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < count; start += size) {
    results.push(...(await Promise.all(Array.from({ length: Math.min(size, count - start) }, (_, k) => make(start + k)))));
  }
  return results;
}

test("500 concurrent checkouts over the same two products: 0 server errors, stock reconciles exactly", async () => {
  const INITIAL = 1000;
  const N = 500;
  const a = await createProduct(t.base, { stock: INITIAL, price: 100 });
  const b = await createProduct(t.base, { stock: INITIAL, price: 200 });
  // نصف السلال A ثم B، والنصف الآخر B ثم A: أسوأ حالة لترتيب الأقفال.
  const carts = await inBatches(N, 50, (i) =>
    createCart(t.base, i % 2 ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }] : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }])
  );

  const statuses = await Promise.all(carts.map((cartId) => api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT } }).then((r) => r.status)));
  const tally = statuses.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
  assert.deepEqual(tally, { 201: N }, JSON.stringify(tally));

  for (const productId of [a, b]) {
    const stock = (await api(t.base, "GET", `/inventory/${productId}`)).body.quantity as number;
    const { rows } = await t.app.pool.query<{ sold: number }>(
      "SELECT COALESCE(SUM(quantity), 0)::int AS sold FROM order_items WHERE product_id = $1",
      [productId]
    );
    assert.equal(stock + (rows[0]?.sold ?? 0), INITIAL, "initial stock = remaining + sold");
    assert.equal(stock, INITIAL - N);
  }
});

test("the last items are never oversold: 30 buyers, 10 in stock -> exactly 10 orders", async () => {
  const productId = await createProduct(t.base, { stock: 10 });
  const carts = await inBatches(30, 30, () => createCart(t.base, [{ productId, quantity: 1 }]));
  const results = await Promise.all(carts.map((cartId) => api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT } })));
  assert.equal(results.filter((r) => r.status === 201).length, 10);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(conflicts.length, 20);
  assert.ok(conflicts.every((r) => r.body.error.code === "INSUFFICIENT_STOCK"));
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 0);
});

test("the same cart checked out 5 times at once: one order, four CART_CHECKED_OUT", async () => {
  const productId = await createProduct(t.base);
  const cartId = await createCart(t.base, [{ productId, quantity: 2 }]);
  const results = await Promise.all(Array.from({ length: 5 }, () => api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT } })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "CART_CHECKED_OUT"));
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 98);
});

test("cancelling orders concurrently restocks exactly once each", async () => {
  const productId = await createProduct(t.base, { stock: 50 });
  const orders = await inBatches(10, 10, async () => {
    const cartId = await createCart(t.base, [{ productId, quantity: 2 }]);
    return (await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT } })).body.id as string;
  });
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 30);
  // كل طلب يُلغى مرتين بالتوازي: مرة تنجح، والثانية 409، والمخزون يعود مرة واحدة فقط.
  const results = await Promise.all(
    orders.flatMap((id) => [0, 1].map(() => api(t.base, "PATCH", `/orders/${id}/status`, { owner: true, body: { status: "cancelled" } })))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 10);
  assert.equal(results.filter((r) => r.status === 409).length, 10);
  assert.equal((await api(t.base, "GET", `/inventory/${productId}`)).body.quantity, 50);
});
