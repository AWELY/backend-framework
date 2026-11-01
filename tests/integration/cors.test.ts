import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "../helpers/test-app";

// اختبارات انحدار (Regression tests) لخطأ حقيقي اكتُشف بتشغيل متصفح حقيقي على موقع متجر ماء
// (الخطأ رقم 1 في جدول 6.5): كان الخادم يبحث عن المسار قبل تشغيل المعالجات العامة، فكان طلب
// CORS التمهيدي (OPTIONS، ولا مسار له) يحصل على 404 مجرد، فيمنع المتصفح كل طلب JSON من الموقع
// (مثل "أضف إلى السلة"). هذه الاختبارات تضمن ألا يعود الخطأ أبداً.
let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

// عنوان الموقع، كما يرسله المتصفح في ترويسة Origin.
const ORIGIN = "http://localhost:5173";

// الطلب التمهيدي لـ POST بـ JSON: الرد 204 مع ترويسات السماح (الطرق والترويسات).
test("CORS preflight for a JSON POST is answered 204 with the CORS headers", async () => {
  const res = await fetch(`${t.base}/carts/00000000-0000-0000-0000-000000000000/items`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get("access-control-allow-origin"));
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /Content-Type/i);
});

// حتى مسار غير موجود أصلاً: الطلب التمهيدي يأخذ 204، لأن cors يعمل قبل الـ 404.
test("preflight works for paths with no route at all, too", async () => {
  const res = await fetch(`${t.base}/does-not-exist`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
});

// ردود الأخطاء (404، و 400 لـ JSON معطوب) تحمل ترويسة CORS، فيستطيع الموقع قراءة رسالة الخطأ.
test("error responses carry CORS headers, so a website can read them", async () => {
  const notFound = await fetch(`${t.base}/no-such-route`, { headers: { Origin: ORIGIN } });
  assert.equal(notFound.status, 404);
  assert.ok(notFound.headers.get("access-control-allow-origin"), "404 without CORS header");

  const badJson = await fetch(`${t.base}/carts`, {
    method: "POST",
    headers: { Origin: ORIGIN, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(badJson.status, 400);
  assert.ok(badJson.headers.get("access-control-allow-origin"), "400 without CORS header");
});

// طلب كتابة حقيقي من موقع آخر يصل إلى المسار (لم يُحجب): المنتج غير موجود فالرد 404 من المسار نفسه.
test("a real cross-origin JSON write still works end to end", async () => {
  const cart = (await (await fetch(`${t.base}/carts`, { method: "POST", headers: { Origin: ORIGIN } })).json()) as { id: string };
  const res = await fetch(`${t.base}/carts/${cart.id}/items`, {
    method: "POST",
    headers: { Origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ productId: "00000000-0000-0000-0000-000000000000", quantity: 1 }),
  });
  assert.equal(res.status, 404, "unknown product -> 404 (reached the route, not blocked)");
  assert.ok(res.headers.get("access-control-allow-origin"));
});
