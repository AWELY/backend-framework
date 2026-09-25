import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";

export const cartMigrations: Migration[] = [
  {
    // Depends on customers (0400) and products (0200).
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

export const addItemSchema = {
  productId: { type: "string", pattern: UUID_REGEX },
  quantity: { type: "number", integer: true, min: 1, max: 1000 },
} as const satisfies Schema;

export const setItemSchema = {
  // 0 removes the line.
  quantity: { type: "number", integer: true, min: 0, max: 1000 },
} as const satisfies Schema;

export interface CartLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** false if the product was hidden (isActive=false) after being added - checkout will refuse it. */
  available: boolean;
}

export interface Cart {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
  items: CartLine[];
  /** Sum of AVAILABLE lines, at CURRENT product prices, in the smallest currency unit. */
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartHeader {
  id: string;
  customerId: string | null;
  status: "open" | "checked_out";
}
