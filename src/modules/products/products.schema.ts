import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { SLUG_PATTERN } from "../shared";

export const productsMigrations: Migration[] = [
  {
    // Depends on 0100_create_categories (category_id foreign key).
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
];

/**
 * `price` is an integer in the currency's SMALLEST unit (dirhams for LYD,
 * 1 LYD = 1000 dirhams). Integers avoid floating-point rounding errors in money
 * (0.1 + 0.2 !== 0.3); the storefront formats it for display.
 */
export const productInputSchema = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  slug: { type: "string", minLength: 1, maxLength: 200, pattern: SLUG_PATTERN },
  description: { type: "string", maxLength: 5000, optional: true },
  price: { type: "number", integer: true, min: 0 },
  categoryId: { type: "string", pattern: UUID_REGEX, optional: true },
  isActive: { type: "boolean", optional: true },
} as const satisfies Schema;

export type ProductInput = Infer<typeof productInputSchema>;

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  categoryId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
