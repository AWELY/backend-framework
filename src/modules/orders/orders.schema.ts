import type { Migration } from "../../db/migrations";
import type { Infer, Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";
import { PHONE } from "../customers/customers.schema";

/**
 * جداول الطلبات، في ثلاثة migrations:
 *
 * 0600: جدول orders وجدول order_items.
 *   orders.customer_id : الزبون، أو NULL لطلب الضيف.
 *   orders.cart_id     : السلة التي صارت هذا الطلب. UNIQUE: السلة الواحدة لا تصبح طلبين أبداً،
 *                        حتى لو نجح إتمامان متزامنان في تجاوز كل الفحوص (خط دفاع أخير في القاعدة).
 *   orders.status      : حالة الطلب، و CHECK يقبل الحالات الخمس فقط.
 *   contact_name و contact_phone و shipping_address : بيانات التواصل، محفوظة في الطلب نفسه
 *                        لأن الضيف ليس له صف في جدول الزبائن.
 *   order_items        : تنسخ اسم المنتج وسعره وقت الشراء. ليس تكراراً للبيانات، بل تاريخ:
 *                        الطلب يُظهر دائماً ما دُفع فعلاً، حتى لو تغيّر اسم المنتج أو سعره لاحقاً
 *                        أو حُذف (product_id يصبح NULL عندها، والاسم والسعر يبقيان).
 *
 * 0700: أعمدة الشحن والدفع، تملؤها الإضافات.
 * 0810: مدينة التوصيل في عمود مستقل، للتسعير حسب المدينة.
 */
export const ordersMigrations: Migration[] = [
  {
    // يعتمد على الزبائن (0400) والسلال (0500) والمنتجات (0200).
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
    // الشحن والدفع، تملؤهما الإضافات. migration جديد بدل تعديل 0600: القواعد التي طبّقت
    // 0600 من قبل تحصل على هذا التغيير فقط.
    // الطلبات القديمة لم يكن فيها شحن، فمجموع منتجاتها (subtotal) يساوي إجماليها (total).
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
    // مدينة التوصيل وحدها، للتسعير حسب المدينة (إضافة cityRateShipping).
    id: "0810_orders_shipping_city",
    up: `ALTER TABLE orders ADD COLUMN shipping_city TEXT;`,
  },
];

/**
 * حالات الدفع:
 *   unpaid   : لم يبدأ الدفع (متجر بلا إضافة دفع).
 *   pending  : بدأ ولم يكتمل، مثل الدفع عند الاستلام قبل التسليم.
 *   paid     : دُفع.
 *   failed   : فشل.
 *   refunded : أُعيد المبلغ.
 * "as const" تجعل القائمة ثابتة، فيستنتج TypeScript منها النوع PaymentStatus.
 */
export const PAYMENT_STATUSES = ["unpaid", "pending", "paid", "failed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** حالات الطلب: قيد الانتظار، ثم مؤكد، ثم مشحون، ثم مُسلَّم. أو ملغى. */
export const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * آلة الحالات (State machine): الانتقالات المسموحة من كل حالة.
 * أي انتقال غير مذكور هنا (مثل delivered إلى pending) يُرفض بـ 409.
 *
 *   pending   : يمكن أن يصبح confirmed أو cancelled
 *   confirmed : يمكن أن يصبح shipped أو cancelled
 *   shipped   : يمكن أن يصبح delivered فقط (لا إلغاء بعد الشحن)
 *   delivered و cancelled : حالتان نهائيتان، لا انتقال منهما.
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
  // مطلوب لطرق الشحن التي تسعّر حسب المدينة (لها قائمة مدن).
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  // مطلوبان فقط إن كانت في المتجر إضافات شحن أو دفع (يفحصهما OrdersService).
  shippingMethod: { type: "string", maxLength: 50, optional: true },
  paymentMethod: { type: "string", maxLength: 50, optional: true },
} as const satisfies Schema;

/** جسم التسعير (POST /checkout/quote): مثل الشراء، لكن دون بيانات التواصل والدفع. */
export const quoteSchema = {
  cartId: { type: "string", pattern: UUID_REGEX },
  shippingAddress: { type: "string", minLength: 5, maxLength: 500 },
  shippingCity: { type: "string", minLength: 1, maxLength: 100, optional: true },
  shippingMethod: { type: "string", maxLength: 50, optional: true },
} as const satisfies Schema;

/** جسم تغيير حالة الطلب: واحدة من الحالات الخمس فقط (oneOf). */
export const statusSchema = {
  status: { type: "string", oneOf: ORDER_STATUSES },
} as const satisfies Schema;

/** جسم تسجيل الدفع: الحالة، ورقم العملية اختيارياً. */
export const paymentStatusSchema = {
  status: { type: "string", oneOf: PAYMENT_STATUSES },
  reference: { type: "string", maxLength: 200, optional: true },
} as const satisfies Schema;

export type CheckoutInput = Infer<typeof checkoutSchema>;
export type QuoteInput = Infer<typeof quoteSchema>;

/** سطر في الطلب: نسخة ثابتة وقت الشراء. */
export interface OrderItem {
  /** null إن حُذف المنتج بعد الطلب. */
  productId: string | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/** الطلب كما يرد في الـ API. كل المبالغ بالدرهم. */
export interface Order {
  id: string;
  customerId: string | null;
  status: OrderStatus;
  contactName: string;
  contactPhone: string;
  shippingAddress: string;
  shippingCity: string | null;
  /** مجموع المنتجات فقط. */
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
