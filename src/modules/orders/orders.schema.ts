import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { PHONE } from "../customers/customers.schema";
import type { PriceAdjustment } from "../extensions";

/**
 * جداول الطلبات.
 *
 * الطلب "صورة ثابتة" وقت الشراء: order_items تنسخ اسم المنتج وسعره، فتغيير سعر المنتج لاحقاً
 * (أو حذفه) لا يغيّر طلباً قديماً. لهذا product_id فيها ON DELETE SET NULL، لا CASCADE.
 *
 * قواعد تفرضها القاعدة نفسها (CHECK)، فلا يستطيع خطأ برمجي أن يحفظ طلباً حسابه خاطئ:
 *   total       = subtotal + shipping_cost + adjustments_total
 *   line_total  = unit_price * quantity
 *   refunded_total بين 0 و total
 *   restocked_quantity بين 0 و quantity
 * القيدان الأولان يُضافان NOT VALID ثم يُتحقق منهما على الصفوف القديمة: إن وُجد صف قديم يخالفهما
 * (بيانات من قبل القيد)، يبقى القيد مفروضاً على كل جديد، ويظهر تحذير بدل أن يفشل الترحيل.
 */
export const ordersMigrations: Migration[] = [
  {
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
    id: "0810_orders_shipping_city",
    up: `ALTER TABLE orders ADD COLUMN shipping_city TEXT;`,
  },
  {
    id: "0911_orders_money_bigint",
    up: `
      ALTER TABLE orders
        ALTER COLUMN subtotal TYPE BIGINT,
        ALTER COLUMN shipping_cost TYPE BIGINT,
        ALTER COLUMN total TYPE BIGINT;
      ALTER TABLE order_items
        ALTER COLUMN unit_price TYPE BIGINT,
        ALTER COLUMN line_total TYPE BIGINT;
    `,
  },
  {
    id: "0920_orders_pricing_currency",
    up: `
      ALTER TABLE orders
        ADD COLUMN currency          CHAR(3) NOT NULL DEFAULT 'LYD',
        ADD COLUMN adjustments       JSONB NOT NULL DEFAULT '[]',
        ADD COLUMN adjustments_total BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD CONSTRAINT orders_total_matches
        CHECK (total = subtotal + shipping_cost + adjustments_total) NOT VALID;
      ALTER TABLE order_items ADD CONSTRAINT order_items_line_total_matches
        CHECK (line_total = unit_price * quantity) NOT VALID;
      DO $$ BEGIN
        ALTER TABLE orders VALIDATE CONSTRAINT orders_total_matches;
      EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'orders_total_matches: some old orders do not satisfy the rule; it is enforced for new rows only';
      END $$;
      DO $$ BEGIN
        ALTER TABLE order_items VALIDATE CONSTRAINT order_items_line_total_matches;
      EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'order_items_line_total_matches: some old rows do not satisfy the rule; it is enforced for new rows only';
      END $$;
    `,
  },
  {
    id: "0955_order_items_variants",
    up: `
      ALTER TABLE order_items
        ADD COLUMN variant_id    UUID REFERENCES product_variants(id) ON DELETE SET NULL,
        ADD COLUMN sku           TEXT,
        ADD COLUMN variant_title TEXT;
    `,
  },
  {
    id: "0960_orders_payments_refunds",
    up: `
      ALTER TABLE orders
        ADD COLUMN payment_expires_at TIMESTAMPTZ,
        ADD COLUMN refunded_total     BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD CONSTRAINT orders_refunded_total_range CHECK (refunded_total >= 0 AND refunded_total <= total);
      ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
      ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
        CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'partially_refunded', 'refunded'));
      CREATE INDEX orders_payment_expires_idx ON orders (payment_expires_at) WHERE payment_expires_at IS NOT NULL;

      ALTER TABLE order_items
        ADD COLUMN restocked_quantity INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE order_items ADD CONSTRAINT order_items_restocked_range
        CHECK (restocked_quantity >= 0 AND restocked_quantity <= quantity);

      CREATE TABLE refunds (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        amount       BIGINT NOT NULL CHECK (amount > 0),
        reason       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
        reference    TEXT,
        restock      JSONB NOT NULL DEFAULT '[]',
        actor_type   TEXT NOT NULL,
        actor_id     TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX refunds_order_id_idx ON refunds (order_id);
    `,
  },
  {
    id: "0970_order_events",
    up: `
      CREATE TABLE order_events (
        id         BIGSERIAL PRIMARY KEY,
        order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        type       TEXT NOT NULL,
        from_value TEXT,
        to_value   TEXT,
        actor_type TEXT NOT NULL,
        actor_id   TEXT,
        note       TEXT
      );
      CREATE INDEX order_events_order_idx ON order_events (order_id, at);
    `,
  },
];

/**
 * حالات الدفع:
 *   unpaid             لم يبدأ (المتجر بلا إضافة دفع، أو قبل بدء الدفع)
 *   pending            بدأ وينتظر (الدفع عند الاستلام، أو بوابة لم تؤكد بعد)
 *   paid               دُفع
 *   failed             فشل بدء الدفع أو رُفض
 *   partially_refunded استُرجع جزء من المبلغ
 *   refunded           استُرجع المبلغ كاملاً
 */
export const PAYMENT_STATUSES = ["unpaid", "pending", "paid", "failed", "partially_refunded", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * انتقالات الدفع المسموحة. نفس الحالة مرة ثانية ليست خطأ: تُقبل دون أي تغيير ودون حدث
 * (بوابة الدفع قد ترسل نفس الـ webhook مرتين). الاسترجاع (partially_refunded و refunded)
 * لا يُضبط يدوياً، بل عبر POST /orders/:id/refunds الذي يسجّل المبلغ.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  unpaid: ["pending", "paid", "failed"],
  pending: ["paid", "failed"],
  failed: ["pending", "paid"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
  refunded: [],
};

/** الحالات التي يستطيع المالك أو بوابة الدفع ضبطها مباشرة (PATCH /orders/:id/payment). */
export const MANUAL_PAYMENT_STATUSES = ["pending", "paid", "failed"] as const;

/** حالات الطلب: قيد الانتظار، ثم مؤكد، ثم مشحون، ثم مُسلَّم. أو ملغى. */
export const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * آلة الحالات (State machine): من كل حالة، إلى أين يُسمح بالانتقال.
 * delivered و cancelled نهائيتان. الإلغاء مسموح قبل الشحن فقط، ويعيد المخزون.
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

/** جسم إتمام الشراء (POST /orders). */
export const checkoutSchema = {
  cartId: { type: "string", pattern: UUID_REGEX },
  contactName: { type: "string", minLength: 1, maxLength: 120 },
  contactPhone: { type: "string", maxLength: 30, pattern: PHONE },
  shippingAddress: { type: "string", minLength: 5, maxLength: 500 },
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  shippingMethod: { type: "string", maxLength: 50, optional: true },
  paymentMethod: { type: "string", maxLength: 50, optional: true },
  couponCode: { type: "string", minLength: 1, maxLength: 50, optional: true },
} as const satisfies Schema;

/** جسم التسعير (POST /checkout/quote): مثل الشراء، لكن دون بيانات التواصل والدفع. */
export const quoteSchema = {
  cartId: { type: "string", pattern: UUID_REGEX },
  shippingAddress: { type: "string", minLength: 5, maxLength: 500 },
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  shippingMethod: { type: "string", maxLength: 50, optional: true },
  couponCode: { type: "string", minLength: 1, maxLength: 50, optional: true },
} as const satisfies Schema;

/** جسم تغيير حالة الطلب: واحدة من الحالات الخمس فقط (oneOf). */
export const statusSchema = {
  status: { type: "string", oneOf: ORDER_STATUSES },
  note: { type: "string", maxLength: 500, optional: true },
} as const satisfies Schema;

/** جسم تسجيل الدفع: الحالة، ورقم العملية اختيارياً. */
export const paymentStatusSchema = {
  status: { type: "string", oneOf: MANUAL_PAYMENT_STATUSES },
  reference: { type: "string", maxLength: 200, optional: true },
} as const satisfies Schema;

/** جسم الاسترجاع: المبلغ، والسبب، والكميات التي تعود للمخزون (اختياري). */
export const refundSchema = {
  amount: { type: "number", integer: true, min: 1, max: Number.MAX_SAFE_INTEGER },
  reason: { type: "string", maxLength: 500, optional: true },
  restock: {
    type: "array",
    optional: true,
    maxItems: 200,
    items: {
      type: "object",
      properties: {
        productId: { type: "string", pattern: UUID_REGEX },
        variantId: { type: "string", pattern: UUID_REGEX, optional: true, nullable: true },
        quantity: { type: "number", integer: true, min: 1, max: 1000 },
      },
    },
  },
} as const satisfies Schema;

/** استعلام قائمة الطلبات. */
export const orderListQuery = {
  status: { type: "string", oneOf: ORDER_STATUSES, optional: true },
  paymentStatus: { type: "string", oneOf: PAYMENT_STATUSES, optional: true },
  q: { type: "string", minLength: 1, maxLength: 100, optional: true, description: "Search order id prefix, contact name or phone" },
} as const satisfies Schema;

export type CheckoutInput = Infer<typeof checkoutSchema>;
export type QuoteInput = Infer<typeof quoteSchema>;
export type RefundInput = Infer<typeof refundSchema>;

/** سطر في الطلب: نسخة ثابتة وقت الشراء. */
export interface OrderItem {
  /** null إن حُذف المنتج بعد الطلب. */
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  productName: string;
  variantTitle: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** كم قطعة من هذا السطر أُعيدت للمخزون (بالإلغاء أو الاسترجاع). */
  restockedQuantity: number;
}

/** الطلب كما يرد في الـ API. كل المبالغ بأصغر وحدة للعملة (currency). */
export interface Order {
  id: string;
  customerId: string | null;
  status: OrderStatus;
  contactName: string;
  contactPhone: string;
  shippingAddress: string;
  shippingCity: string | null;
  currency: string;
  /** مجموع المنتجات فقط. */
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  /** الخصومات والضرائب والرسوم من معدّلات السعر. */
  adjustments: PriceAdjustment[];
  /** مجموعها: الضرائب والرسوم موجبة، والخصومات سالبة. */
  adjustmentsTotal: number;
  /** subtotal + shippingCost + adjustmentsTotal. */
  total: number;
  paymentMethod: string | null;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  /** إن لم يُدفع قبل هذا الوقت، يُلغى الطلب ويعود مخزونه تلقائياً. null = لا مهلة. */
  paymentExpiresAt: Date | null;
  refundedTotal: number;
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

/** سطر يعود إلى المخزون مع استرجاع. */
export interface RestockLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

/** استرجاع مبلغ. */
export interface Refund {
  id: string;
  orderId: string;
  amount: number;
  reason: string | null;
  status: "pending" | "succeeded" | "failed";
  reference: string | null;
  restock: RestockLine[];
  createdAt: Date;
  completedAt: Date | null;
}

/** نوع الحدث في سجل الطلب الزمني. */
export type OrderEventType = "created" | "status" | "payment" | "refund" | "delivery";

/** سطر في سجل الطلب الزمني (ما يراه الزبون في صفحة التتبع). */
export interface OrderEvent {
  id: number;
  at: Date;
  type: OrderEventType;
  from: string | null;
  to: string | null;
  actorType: string;
  note: string | null;
}
