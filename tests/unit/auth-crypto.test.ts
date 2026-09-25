import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, signToken, verifyToken } from "../../src/index";

const SECRET = "unit-test-secret-that-is-long-enough-123";

test("password: correct password verifies, wrong one does not", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.ok(hash.startsWith("scrypt$"));
  assert.ok(!hash.includes("correct horse battery"));
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("password: same password hashes differently each time (random salt)", async () => {
  assert.notEqual(await hashPassword("same-password"), await hashPassword("same-password"));
});

test("password: malformed stored hash is simply 'no match'", async () => {
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
});

test("token: round trip carries the claims", () => {
  const token = signToken({ sub: "customer-1", role: "customer" }, SECRET, 60);
  const payload = verifyToken(token, SECRET);
  assert.equal(payload?.sub, "customer-1");
  assert.equal(payload?.role, "customer");
});

test("token: tampering with the payload is detected", () => {
  const token = signToken({ sub: "customer-1", role: "customer" }, SECRET, 60);
  const [, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "customer-1", role: "owner", exp: 9_999_999_999 })).toString(
    "base64url"
  );
  assert.equal(verifyToken(`${forged}.${signature}`, SECRET), null);
});

test("token: wrong secret or expiry makes it invalid", () => {
  const now = Date.now();
  const token = signToken({ sub: "c", role: "customer" }, SECRET, 60, now);
  assert.equal(verifyToken(token, "a-different-secret-that-is-long-enough"), null);
  assert.equal(verifyToken(token, SECRET, now + 61_000), null);
  assert.ok(verifyToken(token, SECRET, now + 59_000));
});

test("token: garbage input returns null instead of throwing", () => {
  for (const bad of ["", "abc", "a.b.c", "....", "x.y"]) assert.equal(verifyToken(bad, SECRET), null);
});
