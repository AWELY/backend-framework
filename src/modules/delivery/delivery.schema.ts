import type { Migration } from "../../db/migrations";
import type { Schema } from "../../engine/validation";
import { UUID_REGEX } from "../../db/ids";

/**
 * التوصيل: من يوصل الطلب، وأين وصل.
 *
 *   assigned   أُسند لمندوب (المدير أو المشرف)
 *   picked_up  المندوب استلمه من المحل، والطلب يصبح "shipped"
 *   delivered  وصل للزبون، والطلب يصبح "delivered"، والنقود تُسجَّل إن كان الدفع عند الاستلام
 *   failed     محاولة لم تنجح (الزبون لا يرد، عنوان خاطئ...)، مع ملاحظة. يمكن إسناده من جديد.
 *
 * لكل طلب صف توصيل واحد على الأكثر (order_id مفتاح أساسي). إعادة الإسناد تحدّث نفس الصف،
 * وكل تغيير يُكتب في سجل الطلب الزمني، فيبقى التاريخ كاملاً.
 */
export const deliveryMigrations: Migration[] = [
  {
    id: "0990_order_deliveries",
    up: `
      CREATE TABLE order_deliveries (
        order_id       UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        courier_id     UUID REFERENCES staff(id) ON DELETE SET NULL,
        status         TEXT NOT NULL CHECK (status IN ('assigned', 'picked_up', 'delivered', 'failed')),
        cash_collected BIGINT CHECK (cash_collected >= 0),
        note           TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        picked_up_at   TIMESTAMPTZ,
        delivered_at   TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX order_deliveries_courier_idx ON order_deliveries (courier_id, status);
    `,
  },
];

export const DELIVERY_STATUSES = ["assigned", "picked_up", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const assignSchema = {
  courierId: { type: "string", pattern: UUID_REGEX },
  note: { type: "string", maxLength: 500, optional: true },
} as const satisfies Schema;

export const pickupSchema = {
  note: { type: "string", maxLength: 500, optional: true },
} as const satisfies Schema;

/** التسليم. cashCollected: النقود التي استلمها المندوب (للطلب غير المدفوع، يجب أن تساوي الإجمالي). */
export const deliverSchema = {
  cashCollected: { type: "number", integer: true, min: 0, max: Number.MAX_SAFE_INTEGER, optional: true },
  note: { type: "string", maxLength: 500, optional: true },
} as const satisfies Schema;

export const failSchema = {
  note: { type: "string", minLength: 1, maxLength: 500 },
} as const satisfies Schema;

export const deliveryListQuery = {
  status: { type: "string", oneOf: DELIVERY_STATUSES, optional: true },
  courierId: { type: "string", pattern: UUID_REGEX, optional: true, description: "Only this courier (staff with deliveries:read-all)" },
} as const satisfies Schema;

/** التوصيل كما يرد في الـ API. */
export interface Delivery {
  orderId: string;
  courierId: string | null;
  courierName: string | null;
  courierPhone: string | null;
  status: DeliveryStatus;
  cashCollected: number | null;
  note: string | null;
  attempts: number;
  assignedAt: Date;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  updatedAt: Date;
}

/** ما يحتاجه المندوب عن الطلب ليوصله: لمن، وأين، وكم يحصّل. */
export interface DeliveryOrderSummary {
  id: string;
  status: string;
  contactName: string;
  contactPhone: string;
  shippingAddress: string;
  shippingCity: string | null;
  total: number;
  currency: string;
  paymentMethod: string | null;
  paymentStatus: string;
  itemCount: number;
  createdAt: Date;
}

/** سطر في قائمة التوصيلات: التوصيل وملخص طلبه. */
export interface DeliveryWithOrder extends Delivery {
  order: DeliveryOrderSummary;
}
