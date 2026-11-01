import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { startTestApp, api, createProduct, createCart, CONTACT, type TestApp } from "../helpers/test-app";
import { cashOnDelivery } from "../../src/index";

let t: TestApp;
before(async () => {
  t = await startTestApp({
    bodyLimitBytes: 4096,
    corsOrigin: ["http://a.test", "http://b.test"],
    plugins: [cashOnDelivery()],
  });
  // مسار يعيد بصمة الجسم الخام، ليثبت أن req.rawBody هو البايتات كما وصلت.
  t.app.router.post("/test/raw", (req, res) => {
    res.json({ sha256: createHash("sha256").update(req.rawBody ?? "").digest("hex"), parsed: req.body });
  });
});
after(async () => {
  await t.close();
});

test("a body over the limit is rejected with 413, whether declared or streamed", async () => {
  const big = await api(t.base, "POST", "/categories", { owner: true, raw: JSON.stringify({ name: "x".repeat(10_000), slug: "big" }) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, "PAYLOAD_TOO_LARGE");

  // دون Content-Length (chunked): يُعدّ أثناء الوصول.
  const status = await new Promise<number>((resolve, reject) => {
    const url = new URL("/categories", t.base);
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    for (let i = 0; i < 10; i++) req.write("x".repeat(1000));
    req.end();
  });
  assert.equal(status, 413);
});

test("malformed URL encoding is a 400 with code MALFORMED_URL", async () => {
  const res = await api(t.base, "GET", "/products/%E0%A4%A");
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "MALFORMED_URL");
});

test("405 with an Allow header for a known path with the wrong method; HEAD works like GET without a body", async () => {
  const res = await api(t.base, "DELETE", "/health");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
  assert.equal(res.body.error.code, "METHOD_NOT_ALLOWED");
  const head = await fetch(`${t.base}/health`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("every error has a code and the request id; a valid incoming X-Request-Id is kept", async () => {
  const res = await api(t.base, "GET", "/products/00000000-0000-0000-0000-000000000000", { headers: { "x-request-id": "trace-abc.123" } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-request-id"), "trace-abc.123");
  assert.deepEqual(res.body, { error: { code: "NOT_FOUND", message: "Product not found", details: null, requestId: "trace-abc.123" } });
  const generated = await api(t.base, "GET", "/nope", { headers: { "x-request-id": "bad id with spaces" } });
  assert.match(generated.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(generated.body.error.requestId, generated.headers.get("x-request-id"));
});

test("security headers on every response; authenticated responses are not cached", async () => {
  const pub = await api(t.base, "GET", "/categories");
  assert.equal(pub.headers.get("x-content-type-options"), "nosniff");
  assert.equal(pub.headers.get("x-frame-options"), "DENY");
  assert.match(pub.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(pub.headers.get("cache-control"), null);
  const owner = await api(t.base, "GET", "/categories", { owner: true });
  assert.equal(owner.headers.get("cache-control"), "no-store");
});

test("CORS with several origins reflects the allowed origin only, with Vary: Origin", async () => {
  const allowed = await api(t.base, "GET", "/categories", { headers: { origin: "http://b.test" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://b.test");
  assert.equal(allowed.headers.get("vary"), "Origin");
  assert.match(allowed.headers.get("access-control-expose-headers") ?? "", /X-Total-Count/);
  const other = await api(t.base, "GET", "/categories", { headers: { origin: "http://evil.test" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("PATCH with null clears a nullable field", async () => {
  const cat = await api(t.base, "POST", "/categories", { owner: true, body: { name: "Phones", slug: "phones", description: "All phones" } });
  const product = await api(t.base, "POST", "/products", {
    owner: true,
    body: { name: "Case", slug: "case-null", price: 1000, categoryId: cat.body.id, imageUrl: "/images/case.webp" },
  });
  const cleared = await api(t.base, "PATCH", `/products/${product.body.id}`, { owner: true, body: { categoryId: null, imageUrl: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.categoryId, null);
  assert.equal(cleared.body.imageUrl, null);
  const catCleared = await api(t.base, "PATCH", `/categories/${cat.body.id}`, { owner: true, body: { description: null } });
  assert.equal(catCleared.body.description, null);
});

test("optimistic concurrency: ETag on read, 412 for a stale If-Match, success with the current one", async () => {
  const created = await api(t.base, "POST", "/products", { owner: true, body: { name: "Charger", slug: "charger-etag", price: 5000 } });
  const read = await api(t.base, "GET", `/products/${created.body.id}`, { owner: true });
  const tag = read.headers.get("etag");
  assert.equal(tag, '"1"');

  const first = await api(t.base, "PATCH", `/products/${created.body.id}`, { owner: true, body: { price: 5500 }, headers: { "if-match": tag as string } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("etag"), '"2"');
  // زميل قرأ النسخة 1 ويحاول الحفظ الآن: 412 بدل أن يكتب فوق التعديل.
  const stale = await api(t.base, "PATCH", `/products/${created.body.id}`, { owner: true, body: { price: 4000 }, headers: { "if-match": tag as string } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.code, "PRECONDITION_FAILED");
  assert.equal(stale.body.error.details.currentVersion, 2);
  assert.equal((await api(t.base, "PATCH", `/products/${created.body.id}`, { owner: true, body: { price: 1 }, headers: { "if-match": "nonsense" } })).status, 412);
  assert.equal((await api(t.base, "DELETE", `/products/${created.body.id}`, { owner: true, headers: { "if-match": '"1"' } })).status, 412);
  assert.equal((await api(t.base, "DELETE", `/products/${created.body.id}`, { owner: true, headers: { "if-match": '"2"' } })).status, 204);
});

test("lists carry X-Total-Count; search, sort and strict pagination", async () => {
  for (const [name, price] of [["Zeta speaker", 3000], ["Alpha speaker", 9000], ["Mid cable", 100]] as const) {
    await api(t.base, "POST", "/products", { owner: true, body: { name, slug: name.toLowerCase().replace(/ /g, "-"), price } });
  }
  const page = await api(t.base, "GET", "/products?q=speaker&sort=price_asc&limit=1");
  assert.equal(page.headers.get("x-total-count"), "2");
  assert.deepEqual(page.body.map((p: { name: string }) => p.name), ["Zeta speaker"]);
  const second = await api(t.base, "GET", "/products?q=speaker&sort=price_asc&limit=1&offset=1");
  assert.deepEqual(second.body.map((p: { name: string }) => p.name), ["Alpha speaker"]);
  const beyond = await api(t.base, "GET", "/products?q=speaker&limit=1&offset=10");
  assert.deepEqual(beyond.body, []);
  assert.equal(beyond.headers.get("x-total-count"), "2");
  const bad = await api(t.base, "GET", "/products?limit=1000");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details[0].field, "query.limit");
});

test("raw body is kept byte for byte for webhook signatures", async () => {
  const raw = '{ "b": 1,   "a": "علي" }';
  const res = await api(t.base, "POST", "/test/raw", { raw });
  assert.equal(res.body.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(res.body.parsed, { b: 1, a: "علي" });
});

test("payment status follows its state machine; repeating the same status is a no-op", async () => {
  const productId = await createProduct(t.base, { price: 2000 });
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "cod" } });
  assert.equal(order.body.paymentStatus, "pending");
  const paid = await api(t.base, "PATCH", `/orders/${order.body.id}/payment`, { owner: true, body: { status: "paid" } });
  assert.equal(paid.body.paymentStatus, "paid");
  const again = await api(t.base, "PATCH", `/orders/${order.body.id}/payment`, { owner: true, body: { status: "paid" } });
  assert.equal(again.status, 200);
  const back = await api(t.base, "PATCH", `/orders/${order.body.id}/payment`, { owner: true, body: { status: "pending" } });
  assert.equal(back.status, 409);
  assert.equal(back.body.error.code, "INVALID_PAYMENT_TRANSITION");
  assert.deepEqual(back.body.error.details.allowed, ["partially_refunded", "refunded"]);
  assert.equal((await api(t.base, "PATCH", `/orders/${order.body.id}/payment`, { owner: true, body: { status: "refunded" } })).status, 400);
});

test("Idempotency-Key: a retry returns the original order; a different body with the same key is refused", async () => {
  const productId = await createProduct(t.base, { price: 1500 });
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const body = { cartId, ...CONTACT, paymentMethod: "cod" };
  const key = "checkout-7f3c2a";
  const first = await api(t.base, "POST", "/orders", { body, headers: { "idempotency-key": key } });
  assert.equal(first.status, 201);
  const retry = await api(t.base, "POST", "/orders", { body, headers: { "idempotency-key": key } });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(retry.headers.get("idempotency-replayed"), "true");
  // بدون المفتاح: نفس السلة اشتُريت، فـ 409 كما كان دائماً.
  assert.equal((await api(t.base, "POST", "/orders", { body })).status, 409);
  const reused = await api(t.base, "POST", "/orders", { body: { ...body, contactName: "Someone else" }, headers: { "idempotency-key": key } });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await api(t.base, "POST", "/orders", { body, headers: { "idempotency-key": "has spaces" } })).status, 400);
});

test("a coupon code is refused when the store has no price adjusters", async () => {
  const productId = await createProduct(t.base);
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const quote = await api(t.base, "POST", "/checkout/quote", { body: { cartId, shippingAddress: "Tripoli center", couponCode: "SAVE10" } });
  assert.equal(quote.status, 400);
  assert.equal(quote.body.error.details[0].field, "couponCode");
});

test("basePath puts the API under /v1 while system routes stay at the root", async () => {
  const v1 = await startTestApp({ basePath: "/v1", resetDatabase: false });
  try {
    assert.equal((await api(v1.base, "GET", "/v1/categories")).status, 200);
    assert.equal((await api(v1.base, "GET", "/categories")).status, 404);
    assert.equal((await api(v1.base, "GET", "/health")).status, 200);
    const doc = await api(v1.base, "GET", "/openapi.json");
    assert.ok(doc.body.paths["/v1/products/{id}"]);
    assert.ok(doc.body.paths["/health"]);
  } finally {
    await v1.close();
  }
});

test("OpenAPI describes inputs, security and headers of the real routes", async () => {
  const doc = (await api(t.base, "GET", "/openapi.json")).body;
  assert.equal(doc.openapi, "3.1.0");
  const checkout = doc.paths["/orders"].post;
  assert.ok(checkout.parameters.some((p: { name: string }) => p.name === "Idempotency-Key"));
  assert.ok(checkout.requestBody.content["application/json"].schema.required.includes("cartId"));
  const patch = doc.paths["/products/{id}"].patch;
  assert.match(patch.description, /products:write/);
  assert.deepEqual(patch.security, [{ ownerKey: [] }, { bearer: [] }]);
});
