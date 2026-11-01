import {
  ORDERS_SERVICE,
  UnauthorizedError,
  validate,
  verifyWebhookSignature,
  type CommercePlugin,
  type Schema,
} from "./maa";

/**
 * مثال إضافة خارجية: بوابة دفع "مستضافة" (Hosted checkout)، مثل أغلب بوابات الدفع الحقيقية:
 *
 *   1. عند الشراء: initiate يرجع رابط صفحة الدفع عند البوابة (redirectUrl)، والطلب "pending".
 *      البضاعة محجوزة holdSeconds ثانية؛ إن لم يُدفع، يُلغى الطلب ويعود المخزون تلقائياً.
 *   2. المشتري يدفع عند البوابة، فتستدعي البوابة الـ webhook عندنا بتوقيع HMAC.
 *   3. نتحقق من التوقيع على البايتات الخام (req.rawBody) قبل أي شيء، ثم نسجل الدفع عبر ORDERS_SERVICE.
 *      الـ webhook المكرر آمن: نفس الحالة مرة ثانية لا تغيّر شيئاً.
 *   4. الاسترجاع: refund يطلب من البوابة إعادة المال، ويرجع رقم العملية.
 *
 * مبنية فقط على الواجهة العامة (./maa)، دون أي ملف داخلي من الإطار.
 */
export interface HostedGatewayOptions {
  id?: string;
  name?: string;
  /** رابط صفحة الدفع عند البوابة. */
  checkoutUrl: string;
  /** سر توقيع الـ webhook (أو عدة أسرار أثناء التغيير). */
  webhookSecret: string | string[];
  /** مهلة الدفع بالثواني. الافتراضي 30 دقيقة. */
  holdSeconds?: number;
  /** يستدعي واجهة البوابة للاسترجاع ويرجع رقم العملية. في الاختبار: دالة وهمية. */
  refund?: (orderId: string, amount: number) => Promise<string>;
}

const webhookBody = {
  orderId: { type: "string", maxLength: 100 },
  status: { type: "string", oneOf: ["paid", "failed"] },
  reference: { type: "string", maxLength: 200, optional: true },
} as const satisfies Schema;

export function hostedGateway(options: HostedGatewayOptions): CommercePlugin {
  const id = options.id ?? "hosted";
  return {
    name: `hosted-gateway:${id}`,
    version: "1.0.0",
    dependsOn: ["orders"],
    configSchema: {
      checkoutUrl: { type: "string", pattern: /^https:\/\/\S+$/ },
      holdSeconds: { type: "number", integer: true, min: 60, max: 86_400, optional: true },
    },
    config: { checkoutUrl: options.checkoutUrl, ...(options.holdSeconds ? { holdSeconds: options.holdSeconds } : {}) },

    setup({ extensions, router, container, logger }) {
      extensions.addPaymentProvider({
        id,
        name: options.name ?? "Card payment",
        holdSeconds: options.holdSeconds ?? 30 * 60,
        initiate: (order) => ({
          status: "pending",
          redirectUrl: `${options.checkoutUrl}?order=${order.id}&amount=${order.total}&currency=${order.currency}`,
          reference: `HG-${order.id.slice(0, 8)}`,
        }),
        refund: async (order, amount) => ({
          reference: options.refund ? await options.refund(order.id, amount) : `RF-${order.id.slice(0, 8)}-${amount}`,
        }),
      });

      router.post(`/payments/${id}/webhook`, async (req, res) => {
        // التوقيع أولاً: طلب غير موقّع لا يعرف حتى هل جسمه صالح.
        const signed = verifyWebhookSignature({
          payload: req.rawBody,
          header: req.headers["x-signature"],
          secret: options.webhookSecret,
        });
        if (!signed) throw new UnauthorizedError("Invalid webhook signature");
        const body = validate(webhookBody, req.body);
        const order = await container.resolve(ORDERS_SERVICE).setPaymentStatus(body.orderId, body.status, body.reference);
        logger.info(`Gateway '${id}' reported ${body.status}`, { orderId: order.id });
        res.json({ ok: true, paymentStatus: order.paymentStatus });
      });
    },
  };
}
