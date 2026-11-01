import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";

/**
 * جدولا السلة (0500):
 *
 * carts: رأس السلة.
 *   customer_id : الزبون صاحبها، أو NULL لسلة الضيف. ON DELETE SET NULL: حذف الزبون لا يحذف سلته.
 *   status      : 'open' (مفتوحة) أو 'checked_out' (اشتُريت). CHECK يمنع أي قيمة أخرى.
 *
 * cart_items: سطور السلة، سطر لكل منتج.
 *   المفتاح الأساسي (cart_id, product_id): نفس المنتج لا يتكرر في نفس السلة.
 *   ON DELETE CASCADE: حذف السلة أو المنتج يحذف السطر معه.
 *   quantity    : من 1 إلى 1000 (CHECK). السطر بكمية 0 يُحذف بدل أن يُحفظ.
 *   added_at    : لترتيب السطور حسب وقت الإضافة.
 * لاحظ: لا يوجد سعر هنا. السعر يُقرأ من المنتج دائماً، ولا يُثبَّت إلا في الطلب.
 */
export const cartMigrations: Migration[] = [
  {
    // يعتمد على الزبائن (0400) والمنتجات (0200).
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
];

/** جسم الإضافة: المنتج (UUID) والكمية المضافة (من 1 إلى 1000). */
export const addItemSchema = {
  productId: { type: "string", pattern: UUID_REGEX },
  quantity: { type: "number", integer: true, min: 1, max: 1000 },
} as const satisfies Schema;

/** جسم ضبط الكمية. */
export const setItemSchema = {
  // القيمة 0 تحذف السطر.
  quantity: { type: "number", integer: true, min: 0, max: 1000 },
} as const satisfies Schema;

/** سطر في السلة كما يرد في الـ API. */
export interface CartLine {
  productId: string;
  name: string;
  imageUrl: string | null;
  /** السعر الحالي للقطعة، بالدرهم. */
  unitPrice: number;
  quantity: number;
  /** unitPrice × quantity. */
  lineTotal: number;
  /** false إن أُخفي المنتج (isActive = false) بعد إضافته، وإتمام الشراء سيرفضه. */
  available: boolean;
}

/** السلة كاملة كما ترد في الـ API. */
export interface Cart {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
  items: CartLine[];
  /** مجموع السطور المتاحة فقط، بالأسعار الحالية، بأصغر وحدة للعملة (الدرهم). */
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

/** رأس السلة فقط: ما يحتاجه فحص الصلاحية والحالة. */
export interface CartHeader {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
}
