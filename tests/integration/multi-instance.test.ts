import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, createProduct, createCart, CONTACT, registerCustomer, type TestApp } from "../helpers/test-app";
import type { CommercePlugin } from "../../src/index";

/**
 * اختبار الخروج من المرحلة الرابعة: نسختان من الخادم على قاعدة واحدة (كما خلف موازن أحمال).
 *   - حد المحاولات مشترك: المهاجم لا يحصل على ضعف المحاولات بالتنقل بين النسختين.
 *   - كل حدث يصل لكل مستمع مرة واحدة، مع أن العاملين في النسختين يعملان معاً.
 *   - إيقاف نسخة في منتصف العمل لا يضيع أي حدث.
 */
const deliveries = new Map<string, number>();
const counter: CommercePlugin = {
  name: "delivery-counter",
  setup({ extensions }) {
    extensions.on("order.created", (_payload, meta) => {
      deliveries.set(meta.id, (deliveries.get(meta.id) ?? 0) + 1);
    });
  },
};

let one: TestApp;
let two: TestApp;
before(async () => {
  one = await startTestApp({ plugins: [counter], loginRateLimit: { maxFailures: 4, windowSeconds: 600 }, workers: { pollIntervalMs: 50 } });
  two = await startTestApp({ plugins: [counter], loginRateLimit: { maxFailures: 4, windowSeconds: 600 }, workers: { pollIntervalMs: 50 }, resetDatabase: false });
});
after(async () => {
  await one.close().catch(() => undefined);
  await two.close();
});

test("rate limits are shared across instances", async () => {
  const c = await registerCustomer(one.base);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const base = i % 2 ? two.base : one.base;
    statuses.push((await api(base, "POST", "/customers/login", { body: { email: c.email, password: "wrong-password" } })).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
});

test("each event reaches each listener exactly once with two workers running, even when one instance stops", async () => {
  const productId = await createProduct(one.base, { stock: 1000 });
  const place = async (base: string) => {
    const cartId = await createCart(base, [{ productId, quantity: 1 }]);
    return (await api(base, "POST", "/orders", { body: { cartId, ...CONTACT } })).status;
  };
  const first = await Promise.all(Array.from({ length: 20 }, (_, i) => place(i % 2 ? two.base : one.base)));
  assert.ok(first.every((s) => s === 201));
  // النسخة الأولى تتوقف الآن، والطلبات تستمر على الثانية.
  const stopping = one.close();
  const second = await Promise.all(Array.from({ length: 10 }, () => place(two.base)));
  await stopping;
  assert.ok(second.every((s) => s === 201));

  for (let i = 0; i < 100; i++) {
    const { rows } = await two.app.pool.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE event = 'order.created' AND processed_at IS NULL");
    if (rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const { rows } = await two.app.pool.query("SELECT id::text AS id FROM outbox_events WHERE event = 'order.created'");
  assert.equal(rows.length, 30);
  for (const { id } of rows) assert.equal(deliveries.get(id), 1, `event ${id} delivered ${deliveries.get(id) ?? 0} times`);
});
