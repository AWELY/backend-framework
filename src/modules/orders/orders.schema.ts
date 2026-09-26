import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { PHONE } from "../customers/customers.schema";

export const ordersMigrations: Migration[] = [
  {
    // Depends on customers (0400), carts (0500), products (0200).
    // cart_id is UNIQUE: even two simultaneous checkouts of one cart cannot both
    // create an order. order_items COPY name and price, so an order keeps showing
    // what was actually paid even if the product is later renamed, repriced or deleted.
    id: "0600_create_orders",
    up: `
      CREATE TABLE orders (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
        cart_id          UUID UNIQUE REFERENCES carts(id) ON DELETE SET NULL,
        status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
        contact_name     TEXT NOT NULL,
        contact_phone    TEXT NOT NULL,
        shipping_address TEXT NOT NULL,
        total            INTEGER NOT NULL CHECK (total >= 0),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX orders_customer_id_idx ON orders (customer_id);
      CREATE INDEX orders_status_idx ON orders (status);

      CREATE TABLE order_items (
        order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        unit_price   INTEGER NOT NULL CHECK (unit_price >= 0),
        quantity     INTEGER NOT NULL CHECK (quantity > 0),
        line_total   INTEGER NOT NULL CHECK (line_total >= 0)
      );
      CREATE INDEX order_items_order_id_idx ON order_items (order_id);
    `,
  },
  {
    // Shipping and payment, filled in by plugins. A NEW migration rather than an
    // edited 0600: databases that already ran 0600 get just this change.
    // Existing orders had no shipping, so their subtotal equals their total.
    id: "0700_orders_shipping_payment",
    up: `
      ALTER TABLE orders
        ADD COLUMN subtotal          INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
        ADD COLUMN shipping_method   TEXT,
        ADD COLUMN shipping_cost     INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
        ADD COLUMN payment_method    TEXT,
        ADD COLUMN payment_status    TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
        ADD COLUMN payment_reference TEXT;
      UPDATE orders SET subtotal = total;
    `,
  },
  {
    // The destination city on its own, for city-based delivery pricing.
    id: "0810_orders_shipping_city",
    up: `ALTER TABLE orders ADD COLUMN shipping_city TEXT;`,
  },
];

export const PAYMENT_STATUSES = ["unpaid", "pending", "paid", "failed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed status changes. Anything not listed (e.g. delivered -> pending) is refused with 409. */
export const STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export const checkoutSchema = {
  cartId: { type: "string", pattern: UUID_REGEX },
  contactName: { type: "string", minLength: 1, maxLength: 120 },
  contactPhone: { type: "string", maxLength: 30, pattern: PHONE },
  shippingAddress: { type: "string", minLength: 5, maxLength: 500 },
  // Required by shipping methods that price by city (they list their cities).
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  // Required only when the store has shipping / payment plugins installed.
  shippingMethod: { type: "string", maxLength: 50, optional: true },
  paymentMethod: { type: "string", maxLength: 50, optional: true },
} as const satisfies Schema;

export const quoteSchema = {
  cartId: { type: "string", pattern: UUID_REGEX },
  shippingAddress: { type: "string", minLength: 5, maxLength: 500 },
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  shippingMethod: { type: "string", maxLength: 50, optional: true },
} as const satisfies Schema;

export const statusSchema = {
  status: { type: "string", oneOf: ORDER_STATUSES },
} as const satisfies Schema;

export const paymentStatusSchema = {
  status: { type: "string", oneOf: PAYMENT_STATUSES },
  reference: { type: "string", maxLength: 200, optional: true },
} as const satisfies Schema;

export type CheckoutInput = Infer<typeof checkoutSchema>;
export type QuoteInput = Infer<typeof quoteSchema>;

export interface OrderItem {
  productId: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  customerId: string | null;
  status: OrderStatus;
  contactName: string;
  contactPhone: string;
  shippingAddress: string;
  shippingCity: string | null;
  /** Items only. */
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  /** subtotal + shippingCost. */
  total: number;
  paymentMethod: string | null;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}
