import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";

/**
 * جدول المخزون (0300).
 *   product_id : المفتاح الأساسي، ويشير إلى products(id). صف واحد لكل منتج.
 *                ON DELETE CASCADE: حذف المنتج يحذف صف مخزونه معه.
 *   quantity   : الكمية، و CHECK (quantity >= 0) تجعل المخزون السالب مستحيلاً حتى لو كان
 *                في الكود خطأ برمجي (خط دفاع ثانٍ بعد شرط UPDATE في adjust).
 * المنتج الذي ليس له صف هنا كميته ببساطة 0.
 */
export const inventoryMigrations: Migration[] = [
  {
    // يعتمد على 0200_create_products.
    id: "0300_create_inventory",
    up: `
      CREATE TABLE inventory (
        product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
];

/** جسم PUT: الكمية الجديدة، رقم صحيح من 0 إلى مليون (1_000_000 هي 1000000). */
export const setStockSchema = {
  quantity: { type: "number", integer: true, min: 0, max: 1_000_000 },
} as const satisfies Schema;

/** جسم adjust: مقدار التغيير، موجب للزيادة وسالب للإنقاص. */
export const adjustStockSchema = {
  delta: { type: "number", integer: true, min: -1_000_000, max: 1_000_000 },
} as const satisfies Schema;

/** شكل رد المخزون. inStock يسهّل على الموقع عرض "متوفر" أو "نفد". */
export interface StockLevel {
  productId: string;
  quantity: number;
  inStock: boolean;
}
