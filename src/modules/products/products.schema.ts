import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { SLUG_PATTERN } from "../shared";

/**
 * جدول المنتجات، في migrationين:
 *
 * 0200: إنشاء الجدول.
 *   price       : رقم صحيح، و CHECK (price >= 0) تجعل القاعدة نفسها ترفض السعر السالب.
 *   category_id : يشير إلى categories(id). ON DELETE SET NULL: حذف القسم لا يحذف منتجاته،
 *                 بل يتركها بلا قسم.
 *   is_active   : ظاهر للزبائن أم مخفي، والافتراضي ظاهر.
 *   الفهرس (INDEX) على category_id يسرّع "منتجات قسم معين".
 *
 * 0800: إضافة عمود الصورة لاحقاً.
 */
export const productsMigrations: Migration[] = [
  {
    // يعتمد على 0100_create_categories (المفتاح الأجنبي category_id).
    id: "0200_create_products",
    up: `
      CREATE TABLE products (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        description TEXT,
        price       INTEGER NOT NULL CHECK (price >= 0),
        category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX products_category_id_idx ON products (category_id);
    `,
  },
  {
    // migration جديد، وليس تعديلاً على 0200: القواعد التي فيها الجدول من قبل تكسب العمود
    // الجديد فقط. لو عدّلنا 0200 نفسه، لما طُبّق التعديل على أي قاعدة طبّقته سابقاً.
    id: "0800_products_image_url",
    up: `ALTER TABLE products ADD COLUMN image_url TEXT;`,
  },
];

/**
 * شكل رابط صورة المنتج المقبول:
 *   - رابط كامل يبدأ بـ http:// أو https://، مثل https://cdn.example/x.jpg
 *   - أو مسار على موقع المتجر نفسه يبدأ بـ "/"، مثل /images/products/charger.webp
 * وبلا مسافات (\S+). أي شيء آخر، مثل "javascript:..." أو "data:..."، مرفوض.
 *
 * نحفظ الرابط فقط: ملفات الصور نفسها مع موقع المتجر أو على CDN، فيبقى الإطار بنظام
 * تخزين واحد (PostgreSQL)، دون نظام ملفات.
 */
export const IMAGE_URL_PATTERN = /^(https?:\/\/|\/)\S+$/;

/**
 * قواعد التحقق لإنشاء منتج أو تعديله.
 *
 * price رقم صحيح بأصغر وحدة للعملة: الدرهم للدينار الليبي (1 دينار = 1000 درهم)،
 * فمنتج سعره 65 ديناراً يُحفظ 65000. السبب: الأرقام العشرية تخطئ في المال
 * (0.1 + 0.2 لا تساوي 0.3 في JavaScript)، أما الأرقام الصحيحة فدقيقة. الموقع هو من
 * يحوّل الرقم للعرض: 65000 تظهر "65 د.ل"، و 12500 تظهر "12.5 د.ل" (الدالة money في storefront/web/js/ui.js).
 */
export const productInputSchema = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  slug: { type: "string", minLength: 1, maxLength: 200, pattern: SLUG_PATTERN },
  description: { type: "string", maxLength: 5000, optional: true },
  price: { type: "number", integer: true, min: 0 },
  categoryId: { type: "string", pattern: UUID_REGEX, optional: true },
  isActive: { type: "boolean", optional: true },
  imageUrl: { type: "string", maxLength: 2000, pattern: IMAGE_URL_PATTERN, optional: true },
} as const satisfies Schema;

/** نوع بيانات المنتج بعد التحقق (يُستنتج من الـ schema). */
export type ProductInput = Infer<typeof productInputSchema>;

/** شكل المنتج في ردود الـ API. */
export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** بالدرهم. */
  price: number;
  categoryId: string | null;
  isActive: boolean;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
