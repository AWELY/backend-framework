import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";

// Small limit so the test is quick: 3 failures per 60 s. trustProxy lets the
// test pretend to be different client IPs through X-Forwarded-For.
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

const login = (email: string, password: string, ip: string) =>
  fetch(`${t.base}/customers/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });

test("one IP: 3 failures, then blocked (429 + Retry-After) - even with the correct password", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login("other@example.ly", "wrong", "198.51.100.1")).status, 401);

  const blocked = await login("other@example.ly", "the-right-password", "198.51.100.1");
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After was ${retryAfter}`);

  // The same IP is blocked for every account, not just the one it attacked.
  assert.equal((await login("victim@example.ly", "the-right-password", "198.51.100.1")).status, 429);
  // A different IP is unaffected.
  assert.equal((await login("victim@example.ly", "the-right-password", "198.51.100.2")).status, 200);
});

test("one account attacked from many IPs is blocked too (per-email counter)", async () => {
  await login("victim@example.ly", "wrong", "203.0.113.1");
  await login("victim@example.ly", "wrong", "203.0.113.2");
  await login("victim@example.ly", "wrong", "203.0.113.3");
  assert.equal((await login("victim@example.ly", "the-right-password", "203.0.113.4")).status, 429);
});

test("a successful login clears the email counter", async () => {
  await login("attacker@example.ly", "wrong", "192.0.2.10");
  await login("attacker@example.ly", "wrong", "192.0.2.11");
  assert.equal((await login("attacker@example.ly", "the-right-password", "192.0.2.12")).status, 200);
  // Counter was reset: two more failures do not reach the limit of 3.
  await login("attacker@example.ly", "wrong", "192.0.2.13");
  await login("attacker@example.ly", "wrong", "192.0.2.14");
  assert.equal((await login("attacker@example.ly", "the-right-password", "192.0.2.15")).status, 200);
});

test("blocked attempts are answered fast (no password hashing)", async () => {
  const started = performance.now();
  for (let i = 0; i < 20; i++) await login("other@example.ly", "wrong", "198.51.100.1");
  const perRequest = (performance.now() - started) / 20;
  assert.ok(perRequest < 20, `a blocked attempt took ${perRequest.toFixed(1)} ms on average`);
});
