import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";

export const inventoryMigrations: Migration[] = [
  {
    // Depends on 0200_create_products. One row per product; a product with no
    // row simply has 0 in stock. The CHECK makes negative stock impossible
    // even if application code had a bug.
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

export const setStockSchema = {
  quantity: { type: "number", integer: true, min: 0, max: 1_000_000 },
} as const satisfies Schema;

export const adjustStockSchema = {
  delta: { type: "number", integer: true, min: -1_000_000, max: 1_000_000 },
} as const satisfies Schema;

export interface StockLevel {
  productId: string;
  quantity: number;
  inStock: boolean;
}
