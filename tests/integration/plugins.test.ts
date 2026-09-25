import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, type TestApp } from "../helpers/test-app";
import {
  cashOnDelivery,
  flatRateShipping,
  ORDERS_SERVICE,
  ValidationError,
  type CommercePlugin,
  type Order,
} from "../../src/index";

/**
 * A stand-in for a real online payment gateway, written ONLY against the
 * public plugin API: it offers a payment method that returns a redirect URL,
 * and adds its own webhook route that the "gateway" calls when payment
 * succeeds. A real local gateway plugin has exactly this shape.
 */
function mockGateway(): CommercePlugin {
  return {
    name: "mock-gateway",
    setup({ extensions, router, container }) {
      extensions.addPaymentProvider({
        id: "mockpay",
        name: "Mock card payment",
        initiate: (order) => ({
          status: "pending",
          redirectUrl: `https://pay.example/checkout/${order.id}`,
          reference: `MP-${order.id.slice(0, 8)}`,
        }),
      });
      router.post("/payments/mockpay/webhook", async (req, res) => {
        const { orderId, signature } = (req.body ?? {}) as { orderId?: string; signature?: string };
        if (signature !== "valid-signature" || !orderId) throw new ValidationError("Bad webhook");
        const order = await container.resolve(ORDERS_SERVICE).setPaymentStatus(orderId, "paid");
        res.json({ ok: true, paymentStatus: order.paymentStatus });
      });
    },
  };
}

function brokenGateway(): CommercePlugin {
  return {
    name: "broken-gateway",
    setup({ extensions }) {
      extensions.addPaymentProvider({
        id: "broken",
        name: "Always fails",
        initiate: () => {
          throw new Error("gateway timeout");
        },
      });
    },
  };
}

const events: Array<{ name: string; order: Order }> = [];

function eventRecorder(): CommercePlugin {
  return {
    name: "event-recorder",
    setup({ extensions }) {
      extensions.on("order.created", ({ order }) => void events.push({ name: "created", order }));
      extensions.on("order.paymentChanged", ({ order }) => void events.push({ name: "paymentChanged", order }));
      extensions.on("order.created", () => {
        throw new Error("a buggy notification plugin");
      });
    },
  };
}

let t: TestApp;
before(async () => {
  t = await startTestApp({
    plugins: [
      flatRateShipping({ rate: 10000, freeOver: 100000 }),
      flatRateShipping({ id: "express", name: "Express", rate: 25000 }),
      cashOnDelivery(),
      mockGateway(),
      brokenGateway(),
      eventRecorder(),
    ],
  });
});
after(async () => {
  await t.close();
});

const contact = { contactName: "Huda", contactPhone: "0925556677", shippingAddress: "Misrata, Tripoli Street" };

async function cartWith(price: number, quantity: number): Promise<string> {
  const slug = `p-${Math.random().toString(36).slice(2, 10)}`;
  const p = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price } });
  await api(t.base, "PUT", `/inventory/${p.body.id}`, { owner: true, body: { quantity: 100 } });
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p.body.id, quantity } });
  return cartId;
}

test("checkout options list what the installed plugins offer", async () => {
  const res = await api(t.base, "GET", "/checkout/options");
  assert.deepEqual(res.body.shippingMethods.map((m: { id: string }) => m.id), ["flat-rate", "express"]);
  assert.deepEqual(res.body.paymentMethods.map((m: { id: string }) => m.id), ["cod", "mockpay", "broken"]);
});

test("quote applies the shipping plugin's rule (free over the threshold)", async () => {
  const small = await cartWith(20000, 1);
  const q1 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: small, shippingAddress: "Tripoli", shippingMethod: "flat-rate" } });
  assert.deepEqual(q1.body, { subtotal: 20000, shippingMethod: "flat-rate", shippingCost: 10000, total: 30000 });

  const big = await cartWith(60000, 2);
  const q2 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: big, shippingAddress: "Tripoli", shippingMethod: "flat-rate" } });
  assert.equal(q2.body.shippingCost, 0);
  const q3 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: big, shippingAddress: "Tripoli", shippingMethod: "express" } });
  assert.equal(q3.body.shippingCost, 25000);
});

test("with plugins installed, shipping and payment methods are required and validated", async () => {
  const cartId = await cartWith(1000, 1);
  const missing = await api(t.base, "POST", "/orders", { body: { cartId, ...contact } });
  assert.equal(missing.status, 400);
  const unknown = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "teleport", paymentMethod: "cod" },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.details[0].message, /flat-rate, express/);
});

test("cash on delivery: shipping added to total, payment pending with instructions, owner marks paid", async () => {
  const cartId = await cartWith(20000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "flat-rate", paymentMethod: "cod" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.subtotal, 20000);
  assert.equal(res.body.shippingCost, 10000);
  assert.equal(res.body.total, 30000);
  assert.equal(res.body.paymentMethod, "cod");
  assert.equal(res.body.paymentStatus, "pending");
  assert.match(res.body.payment.instructions, /cash/i);

  const paid = await api(t.base, "PATCH", `/orders/${res.body.id}/payment`, { owner: true, body: { status: "paid" } });
  assert.equal(paid.body.paymentStatus, "paid");
});

test("online gateway plugin: redirect URL on checkout, webhook route marks the order paid", async () => {
  const cartId = await cartWith(5000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "express", paymentMethod: "mockpay" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.payment.redirectUrl, `https://pay.example/checkout/${res.body.id}`);
  assert.ok(res.body.paymentReference.startsWith("MP-"));

  assert.equal((await api(t.base, "POST", "/payments/mockpay/webhook", { body: { orderId: res.body.id, signature: "forged" } })).status, 400);
  const hook = await api(t.base, "POST", "/payments/mockpay/webhook", { body: { orderId: res.body.id, signature: "valid-signature" } });
  assert.deepEqual(hook.body, { ok: true, paymentStatus: "paid" });
  assert.ok(events.some((e) => e.name === "paymentChanged" && e.order.id === res.body.id));
});

test("a failing payment plugin does not lose the order: it is saved with paymentStatus 'failed'", async () => {
  const cartId = await cartWith(3000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "flat-rate", paymentMethod: "broken" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.paymentStatus, "failed");
  assert.equal((await api(t.base, "GET", `/orders/${res.body.id}`, { owner: true })).status, 200);
});

test("event listeners run after checkout, and a throwing listener does not break it", async () => {
  const cartId = await cartWith(1000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "flat-rate", paymentMethod: "cod" },
  });
  assert.equal(res.status, 201);
  assert.ok(events.some((e) => e.name === "created" && e.order.id === res.body.id));
});

test("duplicate provider ids are rejected at startup", () => {
  assert.throws(() => t.app.extensions.addPaymentProvider({ id: "cod", name: "dup", initiate: () => ({ status: "pending" }) }));
});
