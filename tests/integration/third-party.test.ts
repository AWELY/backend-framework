import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, createProduct, createCart, CONTACT, OWNER_KEY, TOKEN_SECRET, type TestApp } from "../helpers/test-app";
import { createCommerceApp, Logger, signWebhookPayload, PRODUCTS_REPOSITORY, type CommercePlugin, type EventMeta } from "../../src/index";
import { hostedGateway } from "../../examples/plugins/hosted-gateway";
import { cachedProducts } from "../../examples/plugins/cached-products";

/**
 * اختبار الخروج من المرحلة الخامسة: إضافات مكتوبة من خارج الإطار (examples/plugins) تستخدم الواجهة
 * العامة فقط، وتعمل من البداية للنهاية.
 */
const metas: EventMeta[] = [];
const metaRecorder: CommercePlugin = {
  name: "meta-recorder",
  setup({ extensions }) {
    extensions.on("order.paymentChanged", (_p, meta) => void metas.push(meta));
  },
};

let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [hostedGateway({ checkoutUrl: "https://pay.example/checkout", webhookSecret: ["whsec_new", "whsec_old"] }), cachedProducts(), metaRecorder],
  });
});
after(async () => {
  await t.close();
});

test("hosted gateway: redirect on checkout, signed webhook marks paid, forged or replayed webhooks are harmless", async () => {
  const productId = await createProduct(t.base, { price: 25_000 });
  const cartId = await createCart(t.base, [{ productId, quantity: 1 }]);
  const order = await api(t.base, "POST", "/orders", { body: { cartId, ...CONTACT, paymentMethod: "hosted" } });
  assert.equal(order.status, 201);
  assert.equal(order.body.payment.redirectUrl, `https://pay.example/checkout?order=${order.body.id}&amount=25000&currency=LYD`);
  assert.ok(order.body.paymentExpiresAt);

  const body = JSON.stringify({ orderId: order.body.id, status: "paid", reference: "PAY-123" });
  const forged = await api(t.base, "POST", "/payments/hosted/webhook", { raw: body, headers: { "x-signature": signWebhookPayload(body, "attacker") } });
  assert.equal(forged.status, 401);
  const tampered = await api(t.base, "POST", "/payments/hosted/webhook", {
    raw: body.replace("paid", "failed"),
    headers: { "x-signature": signWebhookPayload(body, "whsec_old") },
  });
  assert.equal(tampered.status, 401);

  const signature = signWebhookPayload(body, "whsec_old"); // السر القديم ما زال مقبولاً أثناء التغيير
  const ok = await api(t.base, "POST", "/payments/hosted/webhook", { raw: body, headers: { "x-signature": signature } });
  assert.deepEqual(ok.body, { ok: true, paymentStatus: "paid" });
  const replay = await api(t.base, "POST", "/payments/hosted/webhook", { raw: body, headers: { "x-signature": signature } });
  assert.deepEqual(replay.body, { ok: true, paymentStatus: "paid" }, "the same webhook twice changes nothing");

  const paid = await api(t.base, "GET", `/orders/${order.body.id}`, { owner: true });
  assert.equal(paid.body.paymentReference, "PAY-123");
  assert.equal(paid.body.paymentExpiresAt, null, "paying clears the hold");

  await t.app.drainBackgroundWork();
  const changes = metas.length;
  assert.ok(changes >= 2, "pending then paid");
  assert.ok(metas.every((m) => m.version === 1 && m.attempt >= 1 && /^\d+$/.test(m.id) && m.occurredAt instanceof Date));
});

test("a service replaced through the DI container: cached product reads, invalidated by events", async () => {
  const productId = await createProduct(t.base, { name: "Cached speaker" });
  const repo = t.app.container.resolve(PRODUCTS_REPOSITORY) as unknown as { hits: number };
  const before = repo.hits;
  await api(t.base, "GET", `/products/${productId}`);
  await api(t.base, "GET", `/products/${productId}`);
  assert.equal(repo.hits - before, 1, "the second read came from the cache");

  await api(t.base, "PATCH", `/products/${productId}`, { owner: true, body: { name: "Renamed speaker" } });
  await t.app.drainBackgroundWork();
  assert.equal((await api(t.base, "GET", `/products/${productId}`)).body.name, "Renamed speaker");
});

test("plugin contract: dependencies, config validation and unique names are checked at startup", () => {
  const base = { databaseUrl: process.env.TEST_DATABASE_URL as string, ownerApiKey: OWNER_KEY, authTokenSecret: TOKEN_SECRET, logger: new Logger("error") };
  assert.throws(
    () => createCommerceApp({ ...base, plugins: [{ name: "needs-loyalty", dependsOn: ["loyalty"], setup() {} }] }),
    /depends on 'loyalty'/
  );
  assert.throws(
    () => createCommerceApp({ ...base, plugins: [hostedGateway({ checkoutUrl: "http://insecure.example", webhookSecret: "x" })] }),
    /invalid config: checkoutUrl has an invalid format/
  );
  assert.throws(() => createCommerceApp({ ...base, plugins: [{ name: "orders", setup() {} }] }), /already used/);
});

test("plugin lifecycle: onStart before listening, onStop in reverse order on close", async () => {
  const calls: string[] = [];
  const plugin = (name: string): CommercePlugin => ({
    name,
    setup: () => void calls.push(`setup:${name}`),
    onStart: async () => void calls.push(`start:${name}`),
    onStop: async () => void calls.push(`stop:${name}`),
  });
  const app = createCommerceApp({
    databaseUrl: process.env.TEST_DATABASE_URL as string,
    ownerApiKey: OWNER_KEY,
    authTokenSecret: TOKEN_SECRET,
    logger: new Logger("error"),
    plugins: [plugin("a"), plugin("b")],
    workers: false,
  });
  await app.listen(0);
  await app.close();
  assert.deepEqual(calls, ["setup:a", "setup:b", "start:a", "start:b", "stop:b", "stop:a"]);
});
