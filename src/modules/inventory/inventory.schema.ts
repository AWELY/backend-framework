import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";

/**
 * المخزون منفصل عن جدول المنتجات: المخزون يتغير مع كل عملية شراء، وبيانات المنتج نادراً ما تتغير.
 * الفصل يعني أن قفل صف المخزون أثناء الشراء لا يمنع أحداً من قراءة المنتج أو تعديل وصفه.
 *
 * مخزون المنتج البسيط في inventory، ومخزون كل شكل (Variant) في variant_inventory. القيد
 * CHECK (quantity >= 0) يجعل القاعدة نفسها ترفض أي بيع يجعل المخزون سالباً، حتى لو أخطأ الكود.
 */
export const inventoryMigrations: Migration[] = [
  {
    id: "0300_create_inventory",
    up: `
      CREATE TABLE inventory (
        product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0945_variant_inventory",
    up: `
      CREATE TABLE variant_inventory (
        variant_id UUID PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
];

/** PUT: ضبط الكمية مباشرة (مثلاً بعد جرد المحل). */
export const setStockSchema = {
  quantity: { type: "number", integer: true, min: 0, max: 1_000_000 },
} as const satisfies Schema;

/** POST adjust: زيادة أو إنقاص بمقدار (مثلاً وصلت شحنة +50، أو تلفت قطعة -1). */
export const adjustStockSchema = {
  delta: { type: "number", integer: true, min: -1_000_000, max: 1_000_000 },
} as const satisfies Schema;

/** مستوى مخزون شكل واحد. */
export interface VariantStockLevel {
  variantId: string;
  productId: string;
  sku: string;
  quantity: number;
  inStock: boolean;
}

/** شكل الرد: الكمية، و inStock = true إن كانت أكبر من صفر، ومخزون كل شكل إن وُجدت أشكال. */
export interface StockLevel {
  productId: string;
  quantity: number;
  inStock: boolean;
  variants?: VariantStockLevel[];
}
