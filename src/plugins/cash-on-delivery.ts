import type { CommercePlugin } from "../modules/types";

/**
 * إضافة الدفع عند الاستلام: أكثر طريقة دفع شيوعاً في المتاجر الليبية الصغيرة، ولا تحتاج
 * أي بوابة دفع خارجية.
 *
 * طريقة عملها:
 *   1. عند إتمام الشراء، تجعل حالة الدفع "pending" (لم يُدفع بعد)، وتعطي المشتري تعليمات.
 *   2. المندوب يستلم النقود عند التسليم.
 *   3. المالك يسجل الدفع: PATCH /orders/:id/payment بجسم { "status": "paid" }.
 *
 * الاستخدام في متجر (من storefront/api/app.js):
 *   plugins: [cashOnDelivery({ name: "الدفع نقداً عند الاستلام", instructions: "..." })]
 *
 * هذه الإضافة مثال على شكل أي إضافة: دالة تأخذ خيارات، وترجع كائناً فيه name و setup.
 * و setup تستلم صندوق الأدوات (ModuleContext)، فتسجّل ما تريد في سجل الإضافات.
 */
export function cashOnDelivery(options: { name?: string; instructions?: string } = {}): CommercePlugin {
  return {
    name: "cash-on-delivery",
    setup({ extensions }) {
      extensions.addPaymentProvider({
        // المعرّف الذي يرسله الموقع في paymentMethod.
        id: "cod",
        name: options.name ?? "Cash on delivery",
        // تُستدعى بعد حفظ الطلب. لا شيء خارجي لتنتظره، فترد فوراً.
        initiate: () => ({
          status: "pending",
          instructions: options.instructions ?? "Pay the courier in cash when your order arrives.",
        }),
      });
    },
  };
}
