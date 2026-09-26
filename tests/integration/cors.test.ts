import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "../helpers/test-app";

// Regression tests for a bug found by driving a real browser against the AMA
// website: the server matched routes BEFORE running global middleware, so a
// CORS preflight (OPTIONS - no route) got a bare 404 and the browser blocked
// every JSON request from the website (e.g. "add to cart").
let t: TestApp;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.close();
});

const ORIGIN = "http://localhost:5173";

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

test("preflight works for paths with no route at all, too", async () => {
  const res = await fetch(`${t.base}/does-not-exist`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
});

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
