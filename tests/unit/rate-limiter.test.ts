// اختبارات وحدة لحد المحاولات (engine/rate-limiter.ts) ولعنوان العميل (engine/http/client-ip.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { FailureLimiter, clientIp } from "../../src/index";

/**
 * ساعة وهمية نتحكم بها: now() ترجع الوقت الحالي، و advance(ms) تقدّمه.
 * بها نختبر "مرور 45 ثانية" أو "انتهاء النافذة" فوراً، دون انتظار حقيقي.
 */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

// فشلان: ليس محظوراً بعد (0). الثالث: محظور 60 ثانية. وبعد 45 ثانية يبقى 15.
test("blocks after maxFailures within the window, with the right Retry-After", () => {
  const c = clock();
  const limiter = new FailureLimiter({ maxFailures: 3, windowSeconds: 60 }, c.now);
  for (let i = 0; i < 2; i++) limiter.recordFailure("ip:1");
  assert.equal(limiter.retryAfter("ip:1"), 0);
  limiter.recordFailure("ip:1");
  assert.equal(limiter.retryAfter("ip:1"), 60);
  c.advance(45_000);
  assert.equal(limiter.retryAfter("ip:1"), 15);
});

// بعد انتهاء النافذة يبدأ العد من جديد: فشل واحد في النافذة الجديدة لا يحظر.
test("the window expires and counting starts over", () => {
  const c = clock();
  const limiter = new FailureLimiter({ maxFailures: 2, windowSeconds: 10 }, c.now);
  limiter.recordFailure("k");
  limiter.recordFailure("k");
  assert.ok(limiter.retryAfter("k") > 0);
  c.advance(10_001);
  assert.equal(limiter.retryAfter("k"), 0);
  limiter.recordFailure("k");
  assert.equal(limiter.retryAfter("k"), 0, "a single failure in the new window is not a block");
});

// كل مفتاح مستقل عن غيره، و reset يمسح مفتاحاً واحداً فقط.
test("keys are independent and reset() clears one", () => {
  const limiter = new FailureLimiter({ maxFailures: 1, windowSeconds: 60 });
  limiter.recordFailure("email:a");
  assert.ok(limiter.retryAfter("email:a") > 0);
  assert.equal(limiter.retryAfter("email:b"), 0);
  limiter.reset("email:a");
  assert.equal(limiter.retryAfter("email:a"), 0);
});

// مهاجم يغيّر المفتاح 10000 مرة: الذاكرة لا تتجاوز الحد (100 مفتاح هنا).
test("memory stays bounded when an attacker cycles through many keys", () => {
  const limiter = new FailureLimiter({ maxFailures: 5, windowSeconds: 60, maxKeys: 100 });
  for (let i = 0; i < 10_000; i++) limiter.recordFailure(`ip:${i}`);
  assert.ok(limiter.size <= 100, `size was ${limiter.size}`);
});

/** طلب وهمي فيه فقط ما تحتاجه clientIp: عنوان الاتصال، وترويسة X-Forwarded-For اختيارياً. */
function fakeReq(remote: string, forwarded?: string): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} } as unknown as IncomingMessage;
}

// افتراضياً نأخذ عنوان الاتصال نفسه، ونتجاهل الترويسة لأن العميل يستطيع كتابة ما يشاء فيها.
test("clientIp: socket address by default; X-Forwarded-For ignored unless trustProxy", () => {
  assert.equal(clientIp(fakeReq("10.0.0.1", "6.6.6.6"), false), "10.0.0.1");
});

// خلف proxy: نأخذ آخر عنوان في الترويسة، لأنه الوحيد الذي أضافه الـ proxy.
// وبلا ترويسة أصلاً: نرجع إلى عنوان الاتصال.
test("clientIp with trustProxy takes the LAST X-Forwarded-For entry (the one our proxy added)", () => {
  // العميل أرسل عنواناً مزوراً "1.1.1.1"، و nginx أضاف العنوان الحقيقي في الآخر.
  assert.equal(clientIp(fakeReq("127.0.0.1", "1.1.1.1, 203.0.113.7"), true), "203.0.113.7");
  assert.equal(clientIp(fakeReq("127.0.0.1"), true), "127.0.0.1");
});
