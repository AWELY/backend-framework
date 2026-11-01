import type { CommercePlugin } from "../modules/types";

/** خيارات إضافة الشحن بسعر ثابت. */
export interface FlatRateShippingOptions {
  /** السعر لكل طلب بأصغر وحدة للعملة (مثلاً 10000 تعني 10 دنانير). */
  rate: number;
  /** الطلبات التي يبلغ مجموع منتجاتها هذا المبلغ أو أكثر شحنها مجاني. */
  freeOver?: number;
  /** المعرّف، والافتراضي "flat-rate". */
  id?: string;
  /** الاسم الظاهر للمشتري، والافتراضي "Standard delivery". */
  name?: string;
}

/**
 * أبسط تسعير للتوصيل المحلي: سعر واحد ثابت لكل طلب، ومجاني اختيارياً فوق حد معين.
 *
 * يمكن تثبيتها أكثر من مرة بمعرّفات مختلفة لتقديم عدة خيارات. مثلاً المتجر التجريبي:
 *   flatRateShipping({ name: "Standard delivery (2-4 days)", rate: 10000, freeOver: 200000 }),
 *   flatRateShipping({ id: "express", name: "Express delivery (next day)", rate: 25000 }),
 * ومتجر ماء يستخدمها للاستلام من المحل بسعر 0:
 *   flatRateShipping({ id: "pickup", name: "استلام من المحل - تاجوراء", rate: 0 })
 */
export function flatRateShipping(options: FlatRateShippingOptions): CommercePlugin {
  // سعر غير صحيح يوقف الإقلاع فوراً.
  if (!Number.isInteger(options.rate) || options.rate < 0) {
    throw new Error("flatRateShipping: rate must be a non-negative integer (smallest currency unit)");
  }
  const id = options.id ?? "flat-rate";
  return {
    // المعرّف جزء من الاسم، فتختلف أسماء النسخ المتعددة من نفس الإضافة.
    name: `flat-rate-shipping:${id}`,
    setup({ extensions }) {
      extensions.addShippingProvider({
        id,
        name: options.name ?? "Standard delivery",
        // السعر لا يعتمد على العنوان ولا المدينة، فقط على مجموع المنتجات.
        quote: ({ subtotal }) =>
          options.freeOver !== undefined && subtotal >= options.freeOver ? 0 : options.rate,
      });
    },
  };
}
