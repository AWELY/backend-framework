import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { FailureLimiter, clientIp } from "../../src/index";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

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

test("keys are independent and reset() clears one", () => {
  const limiter = new FailureLimiter({ maxFailures: 1, windowSeconds: 60 });
  limiter.recordFailure("email:a");
  assert.ok(limiter.retryAfter("email:a") > 0);
  assert.equal(limiter.retryAfter("email:b"), 0);
  limiter.reset("email:a");
  assert.equal(limiter.retryAfter("email:a"), 0);
});

test("memory stays bounded when an attacker cycles through many keys", () => {
  const limiter = new FailureLimiter({ maxFailures: 5, windowSeconds: 60, maxKeys: 100 });
  for (let i = 0; i < 10_000; i++) limiter.recordFailure(`ip:${i}`);
  assert.ok(limiter.size <= 100, `size was ${limiter.size}`);
});

function fakeReq(remote: string, forwarded?: string): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} } as unknown as IncomingMessage;
}

test("clientIp: socket address by default; X-Forwarded-For ignored unless trustProxy", () => {
  assert.equal(clientIp(fakeReq("10.0.0.1", "6.6.6.6"), false), "10.0.0.1");
});

test("clientIp with trustProxy takes the LAST X-Forwarded-For entry (the one our proxy added)", () => {
  // The client sent a fake "1.1.1.1"; nginx appended the real address.
  assert.equal(clientIp(fakeReq("127.0.0.1", "1.1.1.1, 203.0.113.7"), true), "203.0.113.7");
  assert.equal(clientIp(fakeReq("127.0.0.1"), true), "127.0.0.1");
});
