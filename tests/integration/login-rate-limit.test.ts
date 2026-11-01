import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

// اختبارات حد محاولات الدخول، بحد صغير ليكون الاختبار سريعاً: 3 محاولات فاشلة كل 60 ثانية.
// trustProxy: true يسمح للاختبار بانتحال عناوين IP مختلفة عبر ترويسة X-Forwarded-For
// (كأن الطلبات تمر بـ proxy)، فنختبر عدّاد العنوان وعدّاد البريد كلاً على حدة.
let t: TestApp;
before(async () => {
  t = await startTestApp({ loginRateLimit: { maxFailures: 3, windowSeconds: 60 }, trustProxy: true });
  for (const email of ["victim@example.ly", "other@example.ly", "attacker@example.ly"]) {
    await api(t.base, "POST", "/customers/register", { body: { email, password: "the-right-password", name: "X" } });
  }
});
after(async () => {
  await t.close();
});

/** محاولة دخول من عنوان IP معين. */
const login = (email: string, password: string, ip: string) =>
  fetch(`${t.base}/customers/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });

// 3 محاولات فاشلة من عنوان واحد، ثم يُحظر (429 مع Retry-After)، حتى بكلمة المرور الصحيحة.
test("one IP: 3 failures, then blocked (429 + Retry-After) - even with the correct password", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login("other@example.ly", "wrong", "198.51.100.1")).status, 401);

  const blocked = await login("other@example.ly", "the-right-password", "198.51.100.1");
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After was ${retryAfter}`);

  // نفس العنوان محظور لكل الحسابات، لا للحساب الذي هاجمه فقط.
  assert.equal((await login("victim@example.ly", "the-right-password", "198.51.100.1")).status, 429);
  // وعنوان آخر لا يتأثر.
  assert.equal((await login("victim@example.ly", "the-right-password", "198.51.100.2")).status, 200);
});

// حساب واحد يُهاجم من عناوين كثيرة (كل محاولة من عنوان مختلف): يُحظر أيضاً، بعدّاد البريد.
test("one account attacked from many IPs is blocked too (per-email counter)", async () => {
  await login("victim@example.ly", "wrong", "203.0.113.1");
  await login("victim@example.ly", "wrong", "203.0.113.2");
  await login("victim@example.ly", "wrong", "203.0.113.3");
  assert.equal((await login("victim@example.ly", "the-right-password", "203.0.113.4")).status, 429);
});

// الدخول الناجح يمسح عدّاد البريد: بعده، فشلان جديدان لا يصلان إلى الحد (3).
test("a successful login clears the email counter", async () => {
  await login("attacker@example.ly", "wrong", "192.0.2.10");
  await login("attacker@example.ly", "wrong", "192.0.2.11");
  assert.equal((await login("attacker@example.ly", "the-right-password", "192.0.2.12")).status, 200);
  // العدّاد صُفّر: فشلان آخران لا يبلغان الحد.
  await login("attacker@example.ly", "wrong", "192.0.2.13");
  await login("attacker@example.ly", "wrong", "192.0.2.14");
  assert.equal((await login("attacker@example.ly", "the-right-password", "192.0.2.15")).status, 200);
});

// المحاولة المحظورة يُرد عليها بسرعة (أقل من 20 ملي ثانية في المتوسط)، لأن الحظر يُفحص قبل
// حساب hash كلمة المرور المكلف (حوالي 35 ملي ثانية). هذا ما يمنع سيل المحاولات من إنهاك الخادم.
test("blocked attempts are answered fast (no password hashing)", async () => {
  const started = performance.now();
  for (let i = 0; i < 20; i++) await login("other@example.ly", "wrong", "198.51.100.1");
  const perRequest = (performance.now() - started) / 20;
  assert.ok(perRequest < 20, `a blocked attempt took ${perRequest.toFixed(1)} ms on average`);
});
