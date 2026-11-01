// اختبارات تكامل لنظام الإضافات: يثبت أن الإطار يتوسع دون تعديل كوده. كل الإضافات هنا مكتوبة
// فقط بالواجهة العامة (src/index.ts)، كما يكتبها أي مطور من خارج الفريق.
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
 * بديل تجريبي لبوابة دفع إلكتروني حقيقية، مكتوب فقط بواجهة الإضافات العامة:
 *   1. يقدم طريقة دفع ترجع رابط تحويل (redirectUrl) إلى صفحة الدفع الخارجية.
 *   2. يضيف مسار webhook خاصاً به، تستدعيه "البوابة" عندما ينجح الدفع، فيسجل الدفع عبر
 *      ORDERS_SERVICE من الحاوية.
 * إضافة بوابة دفع ليبية حقيقية سيكون لها هذا الشكل بالضبط. والتحقق من التوقيع هنا مبسط
 * (نص ثابت)، أما البوابة الحقيقية فتوقّع رسائلها بسر مشترك.
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

/** بوابة معطوبة: ترمي خطأ دائماً، لنختبر أن فشل الدفع لا يضيّع الطلب. */
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

// الأحداث التي سجلها المستمع، لنتأكد منها في الاختبارات.
const events: Array<{ name: string; order: Order }> = [];

/**
 * إضافة تستمع للأحداث وتسجلها. ومعها مستمع ثالث معطوب عمداً (يرمي خطأ)، لنثبت أن المستمع
 * المعطوب لا يكسر عملية الشراء.
 */
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

// متجر بست إضافات: شحن عادي (10000، ومجاني فوق 100000)، وشحن سريع (25000)، والدفع عند
// الاستلام، والبوابتان، ومسجل الأحداث.
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

/** سلة فيها منتج جديد (باسم عشوائي) بالسعر والكمية المعطاة، ويرجع رقمها. */
async function cartWith(price: number, quantity: number): Promise<string> {
  const slug = `p-${Math.random().toString(36).slice(2, 10)}`;
  const p = await api(t.base, "POST", "/products", { owner: true, body: { name: slug, slug, price } });
  await api(t.base, "PUT", `/inventory/${p.body.id}`, { owner: true, body: { quantity: 100 } });
  const cartId = (await api(t.base, "POST", "/carts")).body.id as string;
  await api(t.base, "POST", `/carts/${cartId}/items`, { body: { productId: p.body.id, quantity } });
  return cartId;
}

// خيارات الشراء هي ما سجلته الإضافات، بترتيب تسجيلها.
test("checkout options list what the installed plugins offer", async () => {
  const res = await api(t.base, "GET", "/checkout/options");
  assert.deepEqual(res.body.shippingMethods.map((m: { id: string }) => m.id), ["flat-rate", "express"]);
  assert.deepEqual(res.body.paymentMethods.map((m: { id: string }) => m.id), ["cod", "mockpay", "broken"]);
});

// التسعير يطبق قاعدة الإضافة: 20000 + 10000 شحن. وفوق 100000 الشحن العادي مجاني، والسريع يبقى 25000.
test("quote applies the shipping plugin's rule (free over the threshold)", async () => {
  const small = await cartWith(20000, 1);
  const q1 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: small, shippingAddress: "Tripoli", shippingMethod: "flat-rate" } });
  assert.deepEqual(q1.body, {
    currency: "LYD",
    subtotal: 20000,
    shippingMethod: "flat-rate",
    shippingCost: 10000,
    adjustments: [],
    adjustmentsTotal: 0,
    total: 30000,
  });

  const big = await cartWith(60000, 2);
  const q2 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: big, shippingAddress: "Tripoli", shippingMethod: "flat-rate" } });
  assert.equal(q2.body.shippingCost, 0);
  const q3 = await api(t.base, "POST", "/checkout/quote", { body: { cartId: big, shippingAddress: "Tripoli", shippingMethod: "express" } });
  assert.equal(q3.body.shippingCost, 25000);
});

// بوجود إضافات، طريقتا الشحن والدفع إلزاميتان (بدونهما 400)، والطريقة غير المعروفة 400
// مع قائمة المتاح في الرسالة.
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

// الدفع عند الاستلام: الشحن يُضاف للإجمالي، والدفع pending مع تعليمات، ثم المالك يسجله paid.
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

// البوابة الإلكترونية: رابط تحويل عند الشراء، ورقم عملية. Webhook بتوقيع مزور يُرفض (400)،
// وبالتوقيع الصحيح يسجل الدفع paid ويُطلق الحدث paymentChanged.
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

// البوابة المعطوبة لا تضيّع الطلب: يُحفظ (201) بحالة دفع failed، ويمكن قراءته.
test("a failing payment plugin does not lose the order: it is saved with paymentStatus 'failed'", async () => {
  const cartId = await cartWith(3000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "flat-rate", paymentMethod: "broken" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.paymentStatus, "failed");
  assert.equal((await api(t.base, "GET", `/orders/${res.body.id}`, { owner: true })).status, 200);
});

// المستمعون يعملون بعد الشراء، والمستمع الذي يرمي خطأ لا يكسر الشراء (201).
test("event listeners run after checkout, and a throwing listener does not break it", async () => {
  const cartId = await cartWith(1000, 1);
  const res = await api(t.base, "POST", "/orders", {
    body: { cartId, ...contact, shippingMethod: "flat-rate", paymentMethod: "cod" },
  });
  assert.equal(res.status, 201);
  assert.ok(events.some((e) => e.name === "created" && e.order.id === res.body.id));
});

// تسجيل طريقة دفع بمعرّف موجود ("cod") يُرفض فوراً بخطأ.
test("duplicate provider ids are rejected at startup", () => {
  assert.throws(() => t.app.extensions.addPaymentProvider({ id: "cod", name: "dup", initiate: () => ({ status: "pending" }) }));
});
