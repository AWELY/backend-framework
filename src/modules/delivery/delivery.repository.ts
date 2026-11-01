import type { QueryResultRow } from "pg";
import type { ListPage, Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Delivery, DeliveryStatus, DeliveryWithOrder } from "./delivery.schema";

interface DeliveryRow {
  order_id: string;
  courier_id: string | null;
  courier_name: string | null;
  courier_phone: string | null;
  status: DeliveryStatus;
  cash_collected: number | null;
  note: string | null;
  attempts: number;
  assigned_at: Date;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  updated_at: Date;
}

interface ListRow extends DeliveryRow {
  o_status: string;
  contact_name: string;
  contact_phone: string;
  shipping_address: string;
  shipping_city: string | null;
  total: number;
  currency: string;
  payment_method: string | null;
  payment_status: string;
  item_count: number;
  o_created_at: Date;
  __total: number;
}

const SELECT = `
  SELECT d.*, s.name AS courier_name, s.phone AS courier_phone
    FROM order_deliveries d LEFT JOIN staff s ON s.id = d.courier_id`;

/** مستودع التوصيلات. */
export class DeliveryRepository {
  constructor(private readonly db: Queryable) {}

  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  private toDelivery(row: DeliveryRow): Delivery {
    return {
      orderId: row.order_id,
      courierId: row.courier_id,
      courierName: row.courier_name,
      courierPhone: row.courier_phone,
      status: row.status,
      cashCollected: row.cash_collected,
      note: row.note,
      attempts: row.attempts,
      assignedAt: row.assigned_at,
      pickedUpAt: row.picked_up_at,
      deliveredAt: row.delivered_at,
      updatedAt: row.updated_at,
    };
  }

  /** توصيل طلب، أو null. forUpdate يقفل الصف حتى نهاية المعاملة. */
  async get(orderId: string, options: { forUpdate?: boolean } = {}): Promise<Delivery | null> {
    if (!isUuid(orderId)) return null;
    const { rows } = await this.run<DeliveryRow>(
      `${SELECT} WHERE d.order_id = $1${options.forUpdate ? " FOR UPDATE OF d" : ""}`,
      [orderId]
    );
    return rows[0] ? this.toDelivery(rows[0]) : null;
  }

  /** يسند الطلب لمندوب (أو يعيد إسناده): الحالة assigned من جديد، وتُمسح أوقات الاستلام والتسليم. */
  async assign(orderId: string, courierId: string, note: string | null): Promise<void> {
    await this.run(
      `INSERT INTO order_deliveries (order_id, courier_id, status, note) VALUES ($1, $2, 'assigned', $3)
       ON CONFLICT (order_id) DO UPDATE SET courier_id = EXCLUDED.courier_id, status = 'assigned', note = EXCLUDED.note,
         assigned_at = now(), picked_up_at = NULL, delivered_at = NULL, updated_at = now()`,
      [orderId, courierId, note]
    );
  }

  /** يغيّر حالة التوصيل ويسجّل الوقت المناسب للحالة. */
  async setStatus(orderId: string, status: DeliveryStatus, extra: { note?: string | null; cashCollected?: number | null } = {}): Promise<void> {
    await this.run(
      `UPDATE order_deliveries SET status = $2, note = COALESCE($3, note), updated_at = now(),
              cash_collected = COALESCE($4, cash_collected),
              picked_up_at = CASE WHEN $2 = 'picked_up' THEN now() ELSE picked_up_at END,
              delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
              attempts = CASE WHEN $2 = 'failed' THEN attempts + 1 ELSE attempts END
        WHERE order_id = $1`,
      [orderId, status, extra.note ?? null, extra.cashCollected ?? null]
    );
  }

  /** صفحة من التوصيلات مع ملخص كل طلب، الأحدث تغييراً أولاً. */
  async list(filter: { courierId?: string; status?: string; limit: number; offset: number }): Promise<ListPage<DeliveryWithOrder>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.courierId) {
      values.push(filter.courierId);
      where.push(`d.courier_id = $${values.length}`);
    }
    if (filter.status) {
      values.push(filter.status);
      where.push(`d.status = $${values.length}`);
    }
    values.push(filter.limit, filter.offset);
    const { rows } = await this.run<ListRow>(
      `SELECT d.*, s.name AS courier_name, s.phone AS courier_phone,
              o.status AS o_status, o.contact_name, o.contact_phone, o.shipping_address, o.shipping_city,
              o.total, o.currency, o.payment_method, o.payment_status, o.created_at AS o_created_at,
              (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count,
              COUNT(*) OVER() AS __total
         FROM order_deliveries d
         JOIN orders o ON o.id = d.order_id
         LEFT JOIN staff s ON s.id = d.courier_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY d.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return {
      total: rows[0]?.__total ?? 0,
      items: rows.map((r) => ({
        ...this.toDelivery(r),
        order: {
          id: r.order_id,
          status: r.o_status,
          contactName: r.contact_name,
          contactPhone: r.contact_phone,
          shippingAddress: r.shipping_address,
          shippingCity: r.shipping_city,
          total: r.total,
          currency: r.currency,
          paymentMethod: r.payment_method,
          paymentStatus: r.payment_status,
          itemCount: r.item_count,
          createdAt: r.o_created_at,
        },
      })),
    };
  }
}

export const DELIVERY_REPOSITORY = createToken<DeliveryRepository>("DeliveryRepository");
