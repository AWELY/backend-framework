import type { CommercePlugin } from "../modules/types";

export interface PercentageTaxOptions {
  /** النسبة المئوية، مثل 15 لضريبة 15%. يمكن أن تكون عشرية (2.5). */
  ratePercent: number;
  /** النص الذي يظهر للمشتري. الافتراضي "Tax". */
  label?: string;
  /** الرمز في بند الطلب. الافتراضي "TAX". */
  code?: string;
  /** هل تُحسب الضريبة على الشحن أيضاً؟ الافتراضي لا. */
  includeShipping?: boolean;
}

/**
 * ضريبة بنسبة ثابتة، تُحسب بعد الخصومات (على المبلغ الذي يدفعه المشتري فعلاً).
 * ثبّتها بعد إضافة الكوبونات في قائمة plugins، لأن المعدّلات تعمل بترتيب التثبيت.
 * المبلغ يُقرَّب لأقرب وحدة صغرى (Math.round).
 */
export function percentageTax(options: PercentageTaxOptions): CommercePlugin {
  if (!(options.ratePercent > 0 && options.ratePercent <= 100)) {
    throw new Error("percentageTax: ratePercent must be greater than 0 and at most 100");
  }
  const code = options.code ?? "TAX";
  return {
    name: `percentage-tax:${code}`,
    version: "1.0.0",
    setup({ extensions }) {
      extensions.addPriceAdjuster({
        id: `tax:${code}`,
        adjust({ subtotal, shippingCost, adjustments }) {
          const discounts = adjustments.filter((a) => a.type === "discount").reduce((sum, a) => sum + a.amount, 0);
          const base = Math.max(0, subtotal - discounts + (options.includeShipping ? shippingCost : 0));
          const amount = Math.round((base * options.ratePercent) / 100);
          return amount > 0 ? [{ code, label: options.label ?? "Tax", type: "tax", amount }] : [];
        },
      });
    },
  };
}
