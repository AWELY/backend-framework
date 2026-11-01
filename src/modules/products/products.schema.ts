import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { SLUG_PATTERN } from "../shared";

/**
 * جدول المنتجات وأشكالها (Variants).
 *
 * السعر رقم صحيح بأصغر وحدة للعملة (الدرهم: 1 دينار = 1000 درهم)، لا رقم عشري: الأرقام العشرية
 * في الحاسوب تقريبية (0.1 + 0.2 = 0.30000000000000004)، والمال لا يقبل التقريب.
 * القرار في docs/adr/0005-money-as-integer-minor-units.md.
 *
 * الشكل (Variant): نسخة من منتج تختلف في خاصية، مثل "أسود / 128GB". لكل شكل رمز SKU فريد، وسعر
 * خاص اختياري (null = سعر المنتج نفسه)، ومخزون خاص (في وحدة المخزون، جدول variant_inventory).
 * المنتج الذي له أشكال نشطة لا يُشترى إلا بشكل محدد (VARIANT_REQUIRED)؛ والمنتج بلا أشكال يعمل كما كان.
 *
 * on delete set null في category_id: حذف القسم لا يحذف منتجاته، بل يجعلها بلا قسم.
 */
export const productsMigrations: Migration[] = [
  {
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
    id: "0800_products_image_url",
    up: `ALTER TABLE products ADD COLUMN image_url TEXT;`,
  },
  {
    // INTEGER يتوقف عند نحو 2.1 مليون دينار بالدرهم. BIGINT يكفي لأي سعر حقيقي.
    id: "0910_products_price_bigint",
    up: `ALTER TABLE products ALTER COLUMN price TYPE BIGINT;`,
  },
  {
    id: "0931_products_version",
    up: `ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    id: "0940_product_variants",
    up: `
      CREATE TABLE product_variants (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku        TEXT NOT NULL UNIQUE,
        title      TEXT NOT NULL,
        price      BIGINT CHECK (price >= 0),
        is_active  BOOLEAN NOT NULL DEFAULT true,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX product_variants_product_idx ON product_variants (product_id, position);
    `,
  },
];

/** رابط صورة: مطلق (https://...) أو نسبي من جذر الموقع (/images/...). */
export const IMAGE_URL_PATTERN = /^(https?:\/\/|\/)\S+$/;
/** رمز SKU: حروف وأرقام ونقاط وشرطات، حتى 64 حرفاً. */
export const SKU_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** جسم إنشاء منتج. في PATCH يصبح كل حقل اختيارياً، و null يمسح الحقول nullable. */
export const productInputSchema = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  slug: { type: "string", minLength: 1, maxLength: 200, pattern: SLUG_PATTERN },
  description: { type: "string", maxLength: 5000, optional: true, nullable: true },
  price: { type: "number", integer: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  categoryId: { type: "string", pattern: UUID_REGEX, optional: true, nullable: true },
  isActive: { type: "boolean", optional: true },
  imageUrl: { type: "string", maxLength: 2000, pattern: IMAGE_URL_PATTERN, optional: true, nullable: true },
} as const satisfies Schema;

export type ProductInput = Infer<typeof productInputSchema>;

/** استعلام قائمة المنتجات. */
export const productListQuery = {
  categoryId: { type: "string", maxLength: 100, optional: true, description: "Only products in this category" },
  q: { type: "string", minLength: 1, maxLength: 100, optional: true, description: "Search in the product name" },
  sort: {
    type: "string",
    oneOf: ["newest", "price_asc", "price_desc", "name"],
    optional: true,
    description: "Sort order (default newest)",
  },
} as const satisfies Schema;

/** جسم إنشاء شكل لمنتج. */
export const variantInputSchema = {
  sku: { type: "string", pattern: SKU_PATTERN },
  title: { type: "string", minLength: 1, maxLength: 120 },
  price: { type: "number", integer: true, min: 0, max: Number.MAX_SAFE_INTEGER, optional: true, nullable: true },
  isActive: { type: "boolean", optional: true },
  position: { type: "number", integer: true, min: 0, max: 10_000, optional: true },
} as const satisfies Schema;

export type VariantInput = Infer<typeof variantInputSchema>;

/** شكل منتج كما يرد في الـ API. */
export interface Variant {
  id: string;
  productId: string;
  sku: string;
  title: string;
  /** سعر الشكل، أو null ليُستخدم سعر المنتج. */
  price: number | null;
  isActive: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** المنتج كما يرد في الـ API. */
export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  categoryId: string | null;
  isActive: boolean;
  imageUrl: string | null;
  /** رقم النسخة، يزيد مع كل تعديل (يعود أيضاً في ترويسة ETag). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** الأشكال، في GET /products/:id فقط. */
  variants?: Variant[];
}
