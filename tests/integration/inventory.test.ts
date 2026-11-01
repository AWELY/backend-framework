// اختبارات تكامل للمخزون، وأهمها اختبار التزامن: لا يُباع أكثر من المخزون أبداً.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

/** ينشئ منتجاً جديداً بالـ slug المعطى، ويرجع رقمه. */
async function newProduct(slug: string): Promise<string> {
  const res = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price: 1000 } });
  assert.equal(res.status, 201);
  return res.body.id as string;
}

// منتج غير موجود: 404. ومنتج لم يُضبط مخزونه أبداً: كميته 0 و inStock = false.
test("unknown products are 404; a never-stocked product has 0", async () => {
  assert.equal((await api(t.base, "GET", "/inventory/00000000-0000-0000-0000-000000000000")).status, 404);
  const id = await newProduct("fresh");
  const res = await api(t.base, "GET", `/inventory/${id}`);
  assert.deepEqual(res.body, { productId: id, quantity: 0, inStock: false });
});

// ضبط 5، ثم إنقاص 3 يعطي 2، ثم إنقاص 3 أخرى مرفوض (409) والكمية تبقى 2 كما هي.
test("set and adjust stock; going below zero is refused with 409", async () => {
  const id = await newProduct("lamp");
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 5 } })).body.quantity, 5);
  assert.equal((await api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -3 } })).body.quantity, 2);
  const over = await api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -3 } });
  assert.equal(over.status, 409);
  assert.equal((await api(t.base, "GET", `/inventory/${id}`)).body.quantity, 2);
});

// تعديل المخزون للمالك فقط (401 بدون مفتاح)، والكمية السالبة مرفوضة من المدقّق (400).
test("stock writes are owner-only; negative absolute stock is a 400", async () => {
  const id = await newProduct("chair");
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { body: { quantity: 5 } })).status, 401);
  assert.equal((await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: -1 } })).status, 400);
});

// اختبار التزامن: 5 قطع في المخزون، و 10 طلبات إنقاص في نفس اللحظة (Promise.all يرسلها معاً).
// المتوقع: 5 تنجح بالضبط، و 5 تُرفض بـ 409، والمخزون ينتهي عند 0، لا بالسالب أبداً.
// هذا يثبت أن الفحص والتعديل في استعلام UPDATE واحد (adjust في inventory.repository.ts) ذريّان.
test("concurrency: 10 simultaneous buyers, 5 in stock -> exactly 5 succeed, stock ends at 0", async () => {
  const id = await newProduct("last-items");
  await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 5 } });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api(t.base, "POST", `/inventory/${id}/adjust`, { owner: true, body: { delta: -1 } }))
  );
  const ok = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 409).length;

  assert.equal(ok, 5);
  assert.equal(refused, 5);
  assert.equal((await api(t.base, "GET", `/inventory/${id}`)).body.quantity, 0);
});

// حذف المنتج يحذف صف مخزونه معه (ON DELETE CASCADE). نتأكد بالسؤال المباشر للقاعدة.
test("deleting a product removes its stock row too", async () => {
  const id = await newProduct("gone");
  await api(t.base, "PUT", `/inventory/${id}`, { owner: true, body: { quantity: 3 } });
  await api(t.base, "DELETE", `/products/${id}`, { owner: true });
  const { rows } = await t.app.pool.query("SELECT count(*)::int AS n FROM inventory WHERE product_id = $1", [id]);
  assert.equal(rows[0].n, 0);
});
