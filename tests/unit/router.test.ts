// اختبارات الوحدة (Unit tests) للـ Router: تختبر الصنف وحده، دون خادم ولا قاعدة بيانات.
// تستخدم مكتبة الاختبار المدمجة في Node (node:test)، ودوال التأكد assert:
//   assert.ok(x)            : x صحيحة
//   assert.equal(a, b)      : a تساوي b
//   assert.deepEqual(a, b)  : الكائنان متطابقان في كل حقولهما
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../../src/index";

// معالج لا يفعل شيئاً: يكفي لتسجيل مسار، فهنا نختبر المطابقة فقط.
const noop = () => undefined;

// المسار الثابت يطابق، والمتغير يُلتقط ويُفك ترميزه ("a%20b" تصبح "a b").
test("matches static and :param routes and decodes params", () => {
  const r = new Router();
  r.get("/products", noop);
  r.get("/products/:id", noop);
  assert.ok(r.match("GET", "/products"));
  assert.deepEqual(r.match("GET", "/products/a%20b")?.params, { id: "a b" });
});

// جزء زائد بعد المسار لا يطابق (بفضل $ في التعبير النمطي)، والطريقة المختلفة لا تطابق.
test("does not match extra segments or other methods", () => {
  const r = new Router();
  r.get("/products/:id", noop);
  assert.equal(r.match("GET", "/products/1/extra"), null);
  assert.equal(r.match("POST", "/products/1"), null);
});

// المعالجات قبل الأخير تُحفظ كـ middleware، والأخير كـ handler (انظر add في router.ts).
test("route-level middleware is kept separate from the final handler", () => {
  const r = new Router();
  const mw = () => undefined;
  const handler = () => undefined;
  r.post("/x", mw, handler);
  const match = r.match("POST", "/x");
  assert.deepEqual(match?.route.middleware, [mw]);
  assert.equal(match?.route.handler, handler);
});
