import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "../helpers/test-app";

// اختبارات حد إنشاء الحسابات، بالحد الافتراضي: 5 محاولات في الساعة لكل عنوان IP.
// trustProxy يسمح للاختبار بانتحال عناوين IP مختلفة عبر X-Forwarded-For.
let t: TestApp;
before(async () => {
  t = await startTestApp({ trustProxy: true });
});
after(async () => {
  await t.close();
});

// عدّاد يجعل كل بريد جديداً (user1، user2...)، إلا إن مُرّر جسم محدد.
let n = 0;
const register = (ip: string, body?: Record<string, unknown>) =>
  fetch(`${t.base}/customers/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body ?? { email: `user${++n}@example.ly`, password: "a-good-password", name: "U" }),
  });

// 5 حسابات تنجح، والسادس 429 مع Retry-After قريب من ساعة (بين 3000 و 3600 ثانية).
// وعنوان آخر لا يتأثر.
test("5 registrations per IP, the 6th gets 429 with Retry-After; another IP is unaffected", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await register("198.51.100.20")).status, 201);
  const blocked = await register("198.51.100.20");
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 3000 && retryAfter <= 3600, `Retry-After was ${retryAfter}`);
  assert.equal((await register("198.51.100.21")).status, 201);
});

// 10 محاولات بجسم غير صالح (400) لا تُعدّ، لأن validateBody يرفضها قبل كود العدّ.
// فبعدها ما زال التسجيل الصحيح ممكناً.
test("invalid bodies are rejected before counting (typos do not use up the limit)", async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await register("198.51.100.30", { email: "not-an-email", password: "x", name: "" })).status, 400);
  }
  assert.equal((await register("198.51.100.30")).status, 201);
});

// البريد المكرر (409) يُعدّ أيضاً، لأنه كلّف الخادم حساب hash لكلمة المرور.
// 1 ناجح + 4 مكررة = 5، فالمحاولة السادسة محظورة.
test("a duplicate email still counts - it costs a password hash too", async () => {
  const body = { email: "dup@example.ly", password: "a-good-password", name: "D" };
  assert.equal((await register("198.51.100.40", body)).status, 201);
  for (let i = 0; i < 4; i++) assert.equal((await register("198.51.100.40", body)).status, 409);
  assert.equal((await register("198.51.100.40")).status, 429);
});

// 10 تسجيلات في نفس اللحظة من عنوان واحد: 5 بالضبط تنجح و 5 تُحظر. يثبت أن الفحص والعدّ
// يحدثان قبل أي await (انظر customers/index.ts)، فلا تمر الطلبات المتوازية كلها من الفحص معاً.
test("burst: 10 simultaneous registrations from one IP -> exactly 5 created", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => register("198.51.100.50")));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 5, statuses.join(","));
  assert.equal(statuses.filter((s) => s === 429).length, 5, statuses.join(","));
});
