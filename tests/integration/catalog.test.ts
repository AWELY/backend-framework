// اختبارات تكامل (Integration tests) للأقسام والمنتجات: الخادم الحقيقي، والقاعدة الحقيقية،
// والطلبات عبر HTTP، تماماً كما يستخدمها الموقع.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

// before: مرة واحدة قبل كل اختبارات الملف (تشغيل التطبيق على قاعدة نظيفة).
// after: مرة واحدة بعدها (إغلاق الخادم والاتصالات).
let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

// المسار /health يصل إلى القاعدة فعلاً.
test("health check reaches the database", async () => {
  const res = await api(t.base, "GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.database, "ok");
});

// المالك ينشئ قسماً (201)، و slug مكرر يُرفض (409 من قيد UNIQUE)، والقراءة عامة.
test("categories: owner creates, public reads, slug is unique", async () => {
  const created = await api(t.base, "POST", "/categories", { owner: true, body: { name: "Mugs", slug: "mugs" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, "mugs");

  const dup = await api(t.base, "POST", "/categories", { owner: true, body: { name: "Other", slug: "mugs" } });
  assert.equal(dup.status, 409);

  const read = await api(t.base, "GET", `/categories/${created.body.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.name, "Mugs");
});

// الكتابة تحتاج مفتاح المالك (بدونه أو بمفتاح خاطئ: 401)، و slug بشكل خاطئ أو حقل زائد: 400.
test("writes require authentication and valid input", async () => {
  assert.equal((await api(t.base, "POST", "/categories", { body: { name: "A", slug: "a" } })).status, 401);
  assert.equal(
    (await api(t.base, "POST", "/categories", { body: { name: "A", slug: "a" }, headers: { "x-api-key": "wrong" } })).status,
    401
  );
  const bad = await api(t.base, "POST", "/categories", { owner: true, body: { name: "A", slug: "Not A Slug" } });
  assert.equal(bad.status, 400);
  const extra = await api(t.base, "POST", "/categories", { owner: true, body: { name: "A", slug: "a", id: "x" } });
  assert.equal(extra.status, 400);
});

// قسم غير موجود يُرفض (400 من المفتاح الأجنبي). والمنتج غير النشط مخفي عن العامة في القائمة
// وفي صفحته (404)، والمالك يراه. والتصفية بالقسم ترجع منتجات القسم فقط.
test("products: category must exist, inactive products are hidden from the public", async () => {
  const cat = await api(t.base, "POST", "/categories", { owner: true, body: { name: "Plates", slug: "plates" } });

  const missingCat = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "X", slug: "x", price: 1, categoryId: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(missingCat.status, 400);

  const p = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Plate", slug: "plate", price: 25000, categoryId: cat.body.id },
  });
  assert.equal(p.status, 201);
  assert.equal(p.body.price, 25000);
  assert.equal(p.body.isActive, true);

  const hidden = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Secret", slug: "secret", price: 1, isActive: false },
  });

  const publicList = await api(t.base, "GET", "/products");
  assert.ok(publicList.body.some((x: { id: string }) => x.id === p.body.id));
  assert.ok(!publicList.body.some((x: { id: string }) => x.id === hidden.body.id));

  const ownerList = await api(t.base, "GET", "/products", { owner: true });
  assert.ok(ownerList.body.some((x: { id: string }) => x.id === hidden.body.id));

  assert.equal((await api(t.base, "GET", `/products/${hidden.body.id}`)).status, 404);
  assert.equal((await api(t.base, "GET", `/products/${hidden.body.id}`, { owner: true })).status, 200);

  const byCategory = await api(t.base, "GET", `/products?categoryId=${cat.body.id}`);
  assert.deepEqual(
    byCategory.body.map((x: { id: string }) => x.id),
    [p.body.id]
  );
});

// PATCH يغيّر الحقل المرسل فقط (السعر)، والاسم يبقى. ورقم ليس UUID يعطي 404، لا 500.
test("products: PATCH updates only sent fields; bad ids are 404, not 500", async () => {
  const p = await api(t.base, "POST", "/products", { owner: true, body: { name: "Cup", slug: "cup", price: 100 } });
  const patched = await api(t.base, "PATCH", `/products/${p.body.id}`, { owner: true, body: { price: 150 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.price, 150);
  assert.equal(patched.body.name, "Cup");

  assert.equal((await api(t.base, "GET", "/products/not-a-uuid")).status, 404);
  assert.equal((await api(t.base, "DELETE", "/products/not-a-uuid", { owner: true })).status, 404);
});

// حذف القسم لا يحذف منتجاته، بل يجعل categoryId فيها null (ON DELETE SET NULL).
test("deleting a category keeps its products and clears their categoryId", async () => {
  const cat = await api(t.base, "POST", "/categories", { owner: true, body: { name: "Temp", slug: "temp" } });
  const p = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Bowl", slug: "bowl", price: 5, categoryId: cat.body.id },
  });
  assert.equal((await api(t.base, "DELETE", `/categories/${cat.body.id}`, { owner: true })).status, 204);
  const after = await api(t.base, "GET", `/products/${p.body.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.categoryId, null);
});
