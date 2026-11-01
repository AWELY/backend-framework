import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startTestApp, api, createProduct, createCart, CONTACT, OWNER_KEY, TOKEN_SECRET, type TestApp } from "../helpers/test-app";
import { createCommerceApp, Logger, type CommercePlugin } from "../../src/index";

/** مستمع يفشل في أول محاولة لكل حدث، ثم ينجح: لاختبار الإعادة. */
const calls = { flaky: 0, steady: 0 };
const flakyListeners: CommercePlugin = {
  name: "flaky-listeners",
  setup({ extensions }) {
    // نعدّ فقط منتج هذا الاختبار، فلا تؤثر أحداث منتجات الاختبارات الأخرى على العدّ.
    extensions.on("product.created", ({ product }, meta) => {
      if (product.slug !== "event-retry") return;
      calls.flaky++;
      if (meta.attempt === 1) throw new Error("temporary outage");
    });
    extensions.on("product.created", ({ product }) => {
      if (product.slug === "event-retry") calls.steady++;
    });
  },
};

const lines: string[] = [];
let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [flakyListeners],
    metrics: { token: "metrics-secret" },
    logger: new Logger("info", { format: "json", sink: (_l, line) => lines.push(line) }),
  });
});
after(async () => {
  await t.close();
});

test("liveness and readiness", async () => {
  assert.deepEqual((await api(t.base, "GET", "/livez")).body, { status: "ok" });
  assert.deepEqual((await api(t.base, "GET", "/readyz")).body, { status: "ready" });
  assert.deepEqual((await api(t.base, "GET", "/health")).body, { status: "ok", database: "ok" });
});

test("readiness is 503 while migrations are pending (new code on an old database)", async () => {
  const pending: CommercePlugin = { name: "needs-migration", migrations: [{ id: "9999_not_applied", up: "SELECT 1" }], setup() {} };
  const app = createCommerceApp({
    databaseUrl: process.env.TEST_DATABASE_URL as string,
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    logger: new Logger("error"),
    plugins: [pending],
    workers: false,
  });
  await app.listen(0);
  try {
    const { port } = app.server.address() as AddressInfo;
    const res = await api(`http://localhost:${port}`, "GET", "/readyz");
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: "migrations_pending", pending: ["9999_not_applied"] });
  } finally {
    await app.close();
  }
});

test("metrics need the token, and label routes by their pattern, not the raw URL", async () => {
  const productId = await createProduct(t.base);
  await api(t.base, "GET", `/products/${productId}`);
  assert.equal((await api(t.base, "GET", "/metrics")).status, 401);
  const res = await fetch(`${t.base}/metrics`, { headers: { authorization: "Bearer metrics-secret" } });
  const text = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(text, /http_requests_total\{method="GET",route="\/products\/:id",status="200"\} \d+/);
  assert.ok(!text.includes(productId), "raw ids never become metric labels");
  assert.match(text, /http_request_duration_seconds_bucket/);
  assert.match(text, /db_pool_connections\{state="total"\}/);
  assert.match(text, /outbox_events_total/);
});

test("JSON request logs carry the request id and route, and never the query string", async () => {
  lines.length = 0;
  await api(t.base, "GET", "/orders/00000000-0000-0000-0000-000000000000?phone=0912345678", { headers: { "x-request-id": "log-test-1" } });
  await new Promise((r) => setTimeout(r, 20));
  const entry = lines.map((l) => JSON.parse(l)).find((e) => e.requestId === "log-test-1");
  assert.ok(entry, lines.join("\n"));
  assert.equal(entry.route, "/orders/:id");
  assert.equal(entry.status, 404);
  assert.ok(!JSON.stringify(entry).includes("0912345678"), "the phone number is not logged");
});

test("outbox: a failing listener is retried alone; the one that succeeded is not called twice", async () => {
  calls.flaky = 0;
  calls.steady = 0;
  await api(t.base, "POST", "/products", { owner: true, body: { name: "Event", slug: "event-retry", price: 1 } });
  await t.app.drainBackgroundWork();
  assert.deepEqual(calls, { flaky: 1, steady: 1 });
  const { rows } = await t.app.pool.query(
    "SELECT attempts, processed_at, completed_listeners, last_error FROM outbox_events WHERE event = 'product.created' AND payload->'product'->>'slug' = 'event-retry'"
  );
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].processed_at, null);
  assert.deepEqual(rows[0].completed_listeners, [1]);
  assert.equal(rows[0].last_error, "temporary outage");
  // ننقل موعد الإعادة إلى الآن بدل انتظار ثانيتين.
  await t.app.pool.query("UPDATE outbox_events SET available_at = now() WHERE processed_at IS NULL");
  await t.app.drainBackgroundWork();
  assert.deepEqual(calls, { flaky: 2, steady: 1 });
  const done = await t.app.pool.query("SELECT processed_at FROM outbox_events WHERE payload->'product'->>'slug' = 'event-retry'");
  assert.notEqual(done.rows[0].processed_at, null);
});

test("jobs: retried with backoff, then dead after max attempts; recurring jobs are not duplicated", async () => {
  let runs = 0;
  t.app.jobs.define("test.alwaysFails", () => {
    runs++;
    throw new Error("nope");
  }, { maxAttempts: 2 });
  await t.app.jobs.enqueue("test.alwaysFails", { x: 1 });
  await t.app.drainBackgroundWork();
  await t.app.pool.query("UPDATE jobs SET run_at = now() WHERE name = 'test.alwaysFails'");
  await t.app.drainBackgroundWork();
  assert.equal(runs, 2);
  const { rows } = await t.app.pool.query("SELECT attempts, dead_at, last_error FROM jobs WHERE name = 'test.alwaysFails'");
  assert.equal(rows[0].attempts, 2);
  assert.notEqual(rows[0].dead_at, null);
  assert.equal(rows[0].last_error, "nope");

  // جدولة نفس المهمة الدورية من "نسختين" في نفس الخانة الزمنية تضيف صفاً واحداً.
  t.app.jobs.define("test.recurring", () => undefined);
  t.app.jobs.schedule("test.recurring", 60 * 60 * 1000);
  await t.app.jobs.enqueueDueSchedules();
  await t.app.jobs.enqueue("test.recurring", {}, { dedupeKey: `test.recurring@${Math.floor(Date.now() / 3_600_000)}` });
  const count = await t.app.pool.query("SELECT COUNT(*)::int AS n FROM jobs WHERE name = 'test.recurring'");
  assert.equal(count.rows[0].n, 1);
});

test("graceful shutdown waits for in-flight requests and then refuses new ones", async () => {
  const app = await startTestApp({ resetDatabase: false });
  app.app.router.get("/test/slow", async (_req, res) => {
    await new Promise((r) => setTimeout(r, 300));
    res.json({ done: true });
  });
  const inFlight = api(app.base, "GET", "/test/slow");
  await new Promise((r) => setTimeout(r, 50));
  const closing = app.close({ timeoutMs: 5000 });
  const res = await inFlight;
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { done: true });
  await closing;
  await assert.rejects(fetch(`${app.base}/livez`));
});

test("checkout events reach listeners shortly after commit, without waiting for the next poll", async () => {
  const seen: string[] = [];
  const productId = await createProduct(t.base);
  t.app.extensions.on("order.created", ({ order }) => void seen.push(order.id));
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT } });
  for (let i = 0; i < 50 && !seen.includes(order.body.id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(seen.includes(order.body.id), "delivered within a second by the nudged worker");
});
