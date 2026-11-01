import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";

/**
 * السلة: رأس (carts) وسطور (cart_items).
 *
 * سلة الضيف بلا customer_id، ورقمها UUID لا يُخمَّن، فمن يملك الرقم يملك السلة.
 * سلة الزبون المسجل لها customer_id، ولا يراها غيره (ولا المالك يحتاج دخولاً خاصاً لها).
 * عند دخول الزبون، تُدمج سلة الضيف في سلته (mergeGuestCart).
 *
 * السطر يحدده المنتج والشكل معاً: نفس المنتج بلونين = سطران. القيد UNIQUE NULLS NOT DISTINCT
 * يعامل الشكل null (منتج بلا أشكال) كقيمة واحدة، فلا يتكرر سطر المنتج البسيط (يتطلب PostgreSQL 15+).
 * الكمية بين 1 و 1000: الكمية 0 تعني حذف السطر، لا سطراً فارغاً.
 */
export const cartMigrations: Migration[] = [
  {
    id: "0500_create_carts",
    up: `
      CREATE TABLE carts (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX carts_customer_id_idx ON carts (customer_id);

      CREATE TABLE cart_items (
        cart_id    UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity   INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
        added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (cart_id, product_id)
      );
    `,
  },
  {
    id: "0950_cart_items_variants",
    up: `
      ALTER TABLE cart_items ADD COLUMN variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE;
      ALTER TABLE cart_items DROP CONSTRAINT cart_items_pkey;
      ALTER TABLE cart_items ADD CONSTRAINT cart_items_line_key UNIQUE NULLS NOT DISTINCT (cart_id, product_id, variant_id);
      CREATE INDEX carts_abandoned_idx ON carts (updated_at) WHERE status = 'open' AND customer_id IS NULL;
    `,
  },
];

/** جسم إضافة منتج إلى السلة. variantId إلزامي للمنتج الذي له أشكال نشطة. */
export const addItemSchema = {
  productId: { type: "string", pattern: UUID_REGEX },
  variantId: { type: "string", pattern: UUID_REGEX, optional: true },
  quantity: { type: "number", integer: true, min: 1, max: 1000 },
} as const satisfies Schema;

/** جسم ضبط كمية سطر (0 تحذف السطر). */
export const setItemSchema = {
  quantity: { type: "number", integer: true, min: 0, max: 1000 },
} as const satisfies Schema;

/** استعلام تحديد الشكل في PUT و DELETE على سطر. */
export const lineQuery = {
  variantId: { type: "string", pattern: UUID_REGEX, optional: true },
} as const satisfies Schema;

/** سطر في السلة، بالسعر الحالي للمنتج (أو الشكل). */
export interface CartLine {
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantTitle: string | null;
  imageUrl: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** false إن أُخفي المنتج أو الشكل بعد إضافته. لا يُحسب في المجموع، ويمنع الشراء حتى يُحذف. */
  available: boolean;
}

/** السلة كما ترد في الـ API. */
export interface Cart {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
  items: CartLine[];
  /** مجموع السطور المتاحة فقط. */
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

/** رأس السلة فقط: ما يحتاجه فحص الصلاحية (cart.access.ts). */
export interface CartHeader {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
}
