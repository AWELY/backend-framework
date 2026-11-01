import type { CommercePlugin } from "../modules/types";
import { ValidationError } from "../engine/errors";

/** خيارات إضافة الشحن حسب المدينة. */
export interface CityRateShippingOptions {
  /**
   * سعر التوصيل لكل مدينة، بأصغر وحدة للعملة، مثل:
   *   { "طرابلس": 10000, "بنغازي": 20000 }
   * المدينة غير المذكورة لا يصلها التوصيل.
   * المفاتيح، بنفس هذا الترتيب، هي ما يعرضه الموقع في القائمة المنسدلة.
   */
  rates: Record<string, number>;
  /** الطلبات التي يبلغ مجموع منتجاتها هذا المبلغ أو أكثر توصيلها مجاني (في المدن المخدومة). */
  freeOver?: number;
  /** المعرّف، والافتراضي "city-rate". */
  id?: string;
  /** الاسم الظاهر للمشتري، والافتراضي "Home delivery". */
  name?: string;
}

/**
 * توصيل يُسعَّر حسب مدينة الوجهة، وهكذا تحسب أغلب المتاجر الليبية على الإنترنت.
 *
 * تنشر الإضافة قائمة مدنها (في GET /checkout/options)، فيبني الموقع القائمة المنسدلة من
 * الإضافة نفسها بدل كتابتها في كود الموقع. وترفض المدينة التي لا تخدمها برد 400 يذكر
 * المدن المتاحة.
 *
 * متجر AMA يستخدمها بـ 16 مدينة (DELIVERY_RATES في storefront/api/app.js)،
 * والتوصيل مجاني فوق 500 دينار.
 */
export function cityRateShipping(options: CityRateShippingOptions): CommercePlugin {
  // الفحص يحدث هنا، عند الإقلاع: إعداد خاطئ يوقف التشغيل فوراً، لا عند أول عملية شراء.
  const cities = Object.keys(options.rates);
  if (cities.length === 0) throw new Error("cityRateShipping: at least one city is required");
  for (const [city, rate] of Object.entries(options.rates)) {
    if (!Number.isInteger(rate) || rate < 0) {
      throw new Error(`cityRateShipping: rate for "${city}" must be a non-negative integer (smallest currency unit)`);
    }
  }
  const id = options.id ?? "city-rate";

  return {
    name: `city-rate-shipping:${id}`,
    setup({ extensions }) {
      extensions.addShippingProvider({
        id,
        name: options.name ?? "Home delivery",
        cities,
        // يستلم فقط ما يحتاجه للتسعير (انظر ShippingQuoteInput في modules/extensions.ts).
        quote: ({ subtotal, shippingCity }) => {
          // trim: يحذف المسافات حول اسم المدينة إن أُرسلت بالخطأ.
          const city = shippingCity?.trim();
          const rate = city === undefined ? undefined : options.rates[city];
          // مدينة غير مخدومة أو غير مرسلة: 400 بقائمة المدن الصحيحة.
          if (rate === undefined) {
            throw new ValidationError("Validation failed", [
              { field: "shippingCity", message: `must be one of: ${cities.join(", ")}` },
            ]);
          }
          // مجاني فوق الحد، وإلا سعر المدينة.
          return options.freeOver !== undefined && subtotal >= options.freeOver ? 0 : rate;
        },
      });
    },
  };
}
