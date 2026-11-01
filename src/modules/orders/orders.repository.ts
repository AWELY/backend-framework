import type { QueryResultRow } from "pg";
import type { ListPage, Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { PriceAdjustment } from "../extensions";
import type { Actor } from "../shared";
import type { Order, OrderItem, OrderStatus, PaymentStatus, Refund, RestockLine } from "./orders.schema";

interface OrderRow {
  id: string;
  customer_id: string | null;
  status: OrderStatus;
  contact_name: string;
  contact_phone: string;
  shipping_address: string;
  shipping_city: string | null;
  currency: string;
  subtotal: number;
  shipping_method: string | null;
  shipping_cost: number;
  adjustments: PriceAdjustment[];
  adjustments_total: number;
  total: number;
  payment_method: string | null;
  payment_status: PaymentStatus;
  payment_reference: string | null;
  payment_expires_at: Date | null;
  refunded_total: number;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  sku: string | null;
  product_name: string;
  variant_title: string | null;
  unit_price: number;
  quantity: number;
  line_total: number;
  restocked_quantity: number;
}

interface RefundRow {
  id: string;
  order_id: string;
  amount: number;
  reason: string | null;
  status: Refund["status"];
  reference: string | null;
  restock: RestockLine[];
  created_at: Date;
  completed_at: Date | null;
}

/** خيارات قائمة الطلبات. */
export interface OrderFilter {
  customerId?: string;
  status?: string;
  paymentStatus?: string;
  /** بحث: بداية رقم الطلب، أو جزء من اسم المستلم أو هاتفه. */
  q?: string;
  limit: number;
  offset: number;
}

/** ما يُحفظ عند إنشاء طلب. */
export interface NewOrder {
  customerId: string | null;
  cartId: string;
  contactName: string;
  contactPhone: string;
  shippingAddress: string;
  shippingCity: string | null;
  currency: string;
  subtotal: number;
  shippingMethod: string | null;
  shippingCost: number;
  adjustments: PriceAdjustment[];
  adjustmentsTotal: number;
  paymentMethod: string | null;
  items: Array<Omit<OrderItem, "restockedQuantity">>;
}

/**
 * مستودع الطلبات. لا يرث Repository لأن الطلب مركّب من جدولين (orders و order_items)،
 * فالقراءة تجمعهما، والإنشاء يكتبهما معاً.
 */
export class OrdersRepository {
  constructor(private readonly db: Queryable) {}

  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  private toOrder(row: OrderRow, items: OrderItem[]): Order {
    return {
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
      shippingAddress: row.shipping_address,
      shippingCity: row.shipping_city,
      currency: row.currency,
      subtotal: row.subtotal,
      shippingMethod: row.shipping_method,
      shippingCost: row.shipping_cost,
      adjustments: row.adjustments,
      adjustmentsTotal: row.adjustments_total,
      total: row.total,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      paymentReference: row.payment_reference,
      paymentExpiresAt: row.payment_expires_at,
      refundedTotal: row.refunded_total,
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toItem(row: ItemRow): OrderItem {
    return {
      productId: row.product_id,
      variantId: row.variant_id,
      sku: row.sku,
      productName: row.product_name,
      variantTitle: row.variant_title,
      unitPrice: row.unit_price,
      quantity: row.quantity,
      lineTotal: row.line_total,
      restockedQuantity: row.restocked_quantity,
    };
  }

  private toRefund(row: RefundRow): Refund {
    return {
      id: row.id,
      orderId: row.order_id,
      amount: row.amount,
      reason: row.reason,
      status: row.status,
      reference: row.reference,
      restock: row.restock,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * طلب واحد مع سطوره، أو null.
   * forUpdate: يقفل صف الطلب حتى نهاية المعاملة، فلا يغيّر غيرنا حالته في نفس اللحظة.
   */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<Order | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<OrderRow>(
      `SELECT * FROM orders WHERE id = $1${options.forUpdate ? " FOR UPDATE" : ""}`,
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    const items = await this.run<ItemRow>("SELECT * FROM order_items WHERE order_id = $1 ORDER BY ctid", [id]);
    return this.toOrder(row, items.rows.map((r) => this.toItem(r)));
  }

  /**
   * صفحة من الطلبات، الأحدث أولاً، مع العدد الكلي. السطور تُقرأ لكل الصفحة باستعلام واحد
   * (ANY)، لا استعلام لكل طلب (مشكلة N+1).
   */
  async listPage(filter: OrderFilter): Promise<ListPage<Order>> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.customerId !== undefined) add("customer_id = ?", filter.customerId);
    if (filter.status !== undefined) add("status = ?", filter.status);
    if (filter.paymentStatus !== undefined) add("payment_status = ?", filter.paymentStatus);
    if (filter.q) {
      // ثلاثة طرق للبحث بنفس النص: جزء من الاسم، أو بداية رقم الطلب، أو أرقام الهاتف (دون مسافات ورموز).
      const parts: string[] = [];
      values.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      parts.push(`contact_name ILIKE $${values.length}`);
      const idPrefix = filter.q.toLowerCase().replace(/[^0-9a-f-]/g, "");
      if (idPrefix.length >= 4) {
        values.push(`${idPrefix}%`);
        parts.push(`id::text LIKE $${values.length}`);
      }
      const digits = filter.q.replace(/\D/g, "");
      if (digits.length >= 3) {
        values.push(`%${digits}%`);
        parts.push(`regexp_replace(contact_phone, '\\D', '', 'g') LIKE $${values.length}`);
      }
      where.push(`(${parts.join(" OR ")})`);
    }
    values.push(filter.limit, filter.offset);
    const { rows } = await this.run<OrderRow & { __total: number }>(
      `SELECT *, COUNT(*) OVER() AS __total FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    let total = rows[0]?.__total ?? 0;
    if (rows.length === 0 && filter.offset > 0) {
      const count = await this.run<{ total: number }>(
        `SELECT COUNT(*) AS total FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
        values.slice(0, -2)
      );
      total = count.rows[0]?.total ?? 0;
    }
    if (rows.length === 0) return { items: [], total };

    const items = await this.run<ItemRow>("SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY ctid", [
      rows.map((r) => r.id),
    ]);
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of items.rows) {
      const list = byOrder.get(item.order_id) ?? [];
      list.push(this.toItem(item));
      byOrder.set(item.order_id, list);
    }
    return { items: rows.map((r) => this.toOrder(r, byOrder.get(r.id) ?? [])), total };
  }

  /** العناصر فقط (للتوافق). */
  async list(filter: OrderFilter): Promise<Order[]> {
    return (await this.listPage(filter)).items;
  }

  /**
   * يحفظ طلباً جديداً بسطوره، ويرجع رقمه. يُستدعى داخل معاملة الشراء.
   * total يُحسب هنا من أجزائه، والقاعدة تتأكد منه بالقيد orders_total_matches.
   * السطور كلها في INSERT واحد متعدد الصفوف، لا استعلام لكل سطر.
   */
  async insert(order: NewOrder): Promise<string> {
    const { rows } = await this.run<{ id: string }>(
      `INSERT INTO orders (customer_id, cart_id, contact_name, contact_phone, shipping_address, shipping_city,
                           currency, subtotal, shipping_method, shipping_cost, adjustments, adjustments_total,
                           total, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        order.customerId,
        order.cartId,
        order.contactName,
        order.contactPhone,
        order.shippingAddress,
        order.shippingCity,
        order.currency,
        order.subtotal,
        order.shippingMethod,
        order.shippingCost,
        JSON.stringify(order.adjustments),
        order.adjustmentsTotal,
        order.subtotal + order.shippingCost + order.adjustmentsTotal,
        order.paymentMethod,
      ]
    );
    const id = (rows[0] as { id: string }).id;
    if (order.items.length > 0) {
      const values: unknown[] = [];
      const tuples = order.items.map((item) => {
        values.push(id, item.productId, item.variantId, item.sku, item.productName, item.variantTitle, item.unitPrice, item.quantity, item.lineTotal);
        const b = values.length - 9;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
      });
      await this.run(
        `INSERT INTO order_items (order_id, product_id, variant_id, sku, product_name, variant_title, unit_price, quantity, line_total)
         VALUES ${tuples.join(", ")}`,
        values
      );
    }
    return id;
  }

  /**
   * يسجّل حالة الدفع. reference يُحفظ إن أُرسل (ولا يُمسح القديم إن لم يُرسل).
   * holdSeconds: مهلة الدفع؛ null تمسح المهلة (مثلاً بعد الدفع)، و undefined لا تغيّرها.
   */
  async setPayment(
    id: string,
    status: PaymentStatus,
    reference: string | null | undefined,
    holdSeconds?: number | null
  ): Promise<void> {
    await this.run(
      `UPDATE orders SET payment_status = $2, payment_reference = COALESCE($3, payment_reference),
              payment_expires_at = CASE WHEN $4::text = 'keep' THEN payment_expires_at
                                        WHEN $5::int IS NULL THEN NULL
                                        ELSE now() + make_interval(secs => $5::int) END,
              updated_at = now()
        WHERE id = $1`,
      [id, status, reference ?? null, holdSeconds === undefined ? "keep" : "set", holdSeconds ?? null]
    );
  }

  /** يغيّر حالة الطلب. الإلغاء والتسليم يمسحان مهلة الدفع (لم يعد هناك ما ينتظر). */
  async setStatus(id: string, status: OrderStatus): Promise<void> {
    await this.run(
      `UPDATE orders SET status = $2, updated_at = now(),
              payment_expires_at = CASE WHEN $2 IN ('cancelled', 'delivered') THEN NULL ELSE payment_expires_at END
        WHERE id = $1`,
      [id, status]
    );
  }

  /** يزيد الكمية المعادة للمخزون لسطر. القيد يمنع تجاوز كمية السطر. */
  async addRestocked(orderId: string, line: RestockLine): Promise<void> {
    await this.run(
      `UPDATE order_items SET restocked_quantity = restocked_quantity + $4
        WHERE order_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3`,
      [orderId, line.productId, line.variantId, line.quantity]
    );
  }

  /** أرقام طلبات انتهت مهلة دفعها ولم تُدفع بعد (للمهمة الدورية). */
  async expiredHolds(limit: number): Promise<string[]> {
    const { rows } = await this.run<{ id: string }>(
      `SELECT id FROM orders
        WHERE status = 'pending' AND payment_status IN ('unpaid', 'pending', 'failed')
          AND payment_expires_at IS NOT NULL AND payment_expires_at < now()
        ORDER BY payment_expires_at LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.id);
  }

  /** يحجز مبلغ استرجاع (حالة pending) ويزيد refunded_total في نفس الخطوة. */
  async insertRefund(orderId: string, amount: number, reason: string | null, restock: RestockLine[], actor: Actor): Promise<Refund> {
    const { rows } = await this.run<RefundRow>(
      `INSERT INTO refunds (order_id, amount, reason, restock, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [orderId, amount, reason, JSON.stringify(restock), actor.type, actor.id]
    );
    await this.run("UPDATE orders SET refunded_total = refunded_total + $2, updated_at = now() WHERE id = $1", [orderId, amount]);
    return this.toRefund(rows[0] as RefundRow);
  }

  /** ينهي استرجاعاً: نجح (مع رقم العملية) أو فشل (فيُرجع المبلغ المحجوز من refunded_total). */
  async completeRefund(refundId: string, outcome: { status: "succeeded" | "failed"; reference?: string }): Promise<Refund> {
    const { rows } = await this.run<RefundRow>(
      `UPDATE refunds SET status = $2, reference = COALESCE($3, reference), completed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [refundId, outcome.status, outcome.reference ?? null]
    );
    const refund = rows[0] as RefundRow;
    if (outcome.status === "failed") {
      await this.run("UPDATE orders SET refunded_total = refunded_total - $2, updated_at = now() WHERE id = $1", [
        refund.order_id,
        refund.amount,
      ]);
    }
    return this.toRefund(refund);
  }

  /** استرجاعات طلب، الأقدم أولاً. */
  async refunds(orderId: string): Promise<Refund[]> {
    if (!isUuid(orderId)) return [];
    const { rows } = await this.run<RefundRow>("SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at", [orderId]);
    return rows.map((r) => this.toRefund(r));
  }
}

/** رمز المستودع في الحاوية. */
export const ORDERS_REPOSITORY = createToken<OrdersRepository>("OrdersRepository");
