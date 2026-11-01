const {
  ORDERS_REPOSITORY,
  ORDERS_SERVICE,
  NotFoundError,
  UnauthorizedError,
  validate,
  verifyWebhookSignature,
  signWebhookPayload,
  withInput,
} = require("maa");

/**
 * بوابة دفع بالبطاقة "تجريبية" للمتجر: إضافة خارجية بـ JavaScript عادي، مبنية فقط على الواجهة
 * العامة require("maa")، كما يكتبها أي مطوّر لبوابة حقيقية.
 *
 * الرحلة كما في بوابة حقيقية:
 *   1. الشراء: initiate يرجع رابط صفحة الدفع (pay.html في الموقع، تقوم مقام صفحة البنك)،
 *      والطلب "pending"، والبضاعة محجوزة holdSeconds (15 دقيقة). بعدها يُلغى ويعود المخزون.
 *   2. صفحة الدفع ترسل نتيجة البطاقة إلى /payments/card/simulate (يقوم مقام خوادم البنك).
 *   3. "البنك" يستدعي الـ webhook عندنا عبر HTTP حقيقي، بتوقيع HMAC على الجسم الخام.
 *   4. الـ webhook يتحقق من التوقيع ثم يسجّل الدفع عبر ORDERS_SERVICE (المكرر لا يغيّر شيئاً).
 *   5. الاسترجاع من لوحة الإدارة يمر عبر refund هنا.
 *
 * في بوابة حقيقية تحذف simulate، وتضع رابط البوابة في payPageUrl وسرها في webhookSecret.
 */
const webhookSchema = {
  orderId: { type: "string", maxLength: 100 },
  status: { type: "string", oneOf: ["paid", "failed"] },
  reference: { type: "string", maxLength: 200, optional: true },
};

const simulateSchema = {
  orderId: { type: "string", maxLength: 100 },
  phone: { type: "string", maxLength: 30 },
  outcome: { type: "string", oneOf: ["paid", "failed"] },
};

const digits = (s) => String(s).replace(/\D/g, "");

function demoCardGateway({ payPageUrl, webhookSecret, holdSeconds = 15 * 60 }) {
  return {
    name: "demo-card-gateway",
    version: "1.0.0",
    dependsOn: ["orders"],
    setup({ extensions, router, container, logger }) {
      extensions.addPaymentProvider({
        id: "card",
        name: "بطاقة مصرفية (تجريبي)",
        holdSeconds,
        initiate: (order) => ({
          status: "pending",
          reference: `DEMO-${order.id.slice(0, 8)}`,
          redirectUrl: `${payPageUrl}?order=${encodeURIComponent(order.id)}&phone=${encodeURIComponent(order.contactPhone)}`,
          instructions: `أكمل الدفع خلال ${Math.round(holdSeconds / 60)} دقيقة، وإلا يُلغى الطلب تلقائياً.`,
        }),
        refund: async (order, amount) => {
          logger.info("Demo gateway refund", { orderId: order.id, amount });
          return { reference: `DEMO-RF-${Date.now().toString(36).toUpperCase()}` };
        },
      });

      // الـ webhook: ما تستدعيه البوابة. التوقيع أولاً، قبل قراءة الجسم.
      router.post("/payments/card/webhook", async (req, res) => {
        const ok = verifyWebhookSignature({ payload: req.rawBody, header: req.headers["x-demo-signature"], secret: webhookSecret });
        if (!ok) throw new UnauthorizedError("Invalid webhook signature");
        const body = validate(webhookSchema, req.body);
        const order = await container.resolve(ORDERS_SERVICE).setPaymentStatus(body.orderId, body.status, body.reference);
        res.json({ ok: true, paymentStatus: order.paymentStatus });
      });

      // "خوادم البنك" التجريبية: صفحة الدفع ترسل النتيجة، وهنا نرسل webhook موقّعاً عبر HTTP حقيقي.
      // لا يستطيع أحد استخدامها لطلب غيره: يجب أن يعرف رقم الطلب وهاتفه معاً.
      router.post(
        "/payments/card/simulate",
        withInput({ body: simulateSchema, summary: "Demo only: the bank page reports a card result" }, async (req, res, { body }) => {
          const order = await container.resolve(ORDERS_REPOSITORY).findById(body.orderId);
          if (!order || digits(order.contactPhone) !== digits(body.phone) || order.paymentMethod !== "card") {
            throw new NotFoundError("Order not found");
          }
          const payload = JSON.stringify({ orderId: order.id, status: body.outcome, reference: `DEMO-PAY-${Date.now().toString(36).toUpperCase()}` });
          const base = `http://127.0.0.1:${req.socket.localPort}${(req.route ?? "").replace(/\/payments\/card\/simulate$/, "")}`;
          const response = await fetch(`${base}/payments/card/webhook`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-demo-signature": signWebhookPayload(payload, webhookSecret) },
            body: payload,
          });
          res.status(response.status).json(await response.json());
        })
      );
    },
  };
}

module.exports = { demoCardGateway };
