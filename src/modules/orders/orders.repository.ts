import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Order, OrderItem, OrderStatus, PaymentStatus } from "./orders.schema";

interface OrderRow {
  id: string;
  customer_id: string | null;
  status: OrderStatus;
  contact_name: string;
  contact_phone: string;
  shipping_address: string;
  subtotal: number;
  shipping_method: string | null;
  shipping_cost: number;
  total: number;
  payment_method: string | null;
  payment_status: PaymentStatus;
  payment_reference: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  order_id: string;
  product_id: string | null;
  product_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface OrderFilter {
  customerId?: string;
  status?: string;
  limit: number;
  offset: number;
}

/** Reads and writes orders. Works on the pool or on a transaction client (see orders.service.ts). */
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
      subtotal: row.subtotal,
      shippingMethod: row.shipping_method,
      shippingCost: row.shipping_cost,
      total: row.total,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      paymentReference: row.payment_reference,
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toItem(row: ItemRow): OrderItem {
    return {
      productId: row.product_id,
      productName: row.product_name,
      unitPrice: row.unit_price,
      quantity: row.quantity,
      lineTotal: row.line_total,
    };
  }

  /** `forUpdate` locks the order row until the surrounding transaction ends. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<Order | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<OrderRow>(
      `SELECT * FROM orders WHERE id = $1${options.forUpdate ? " FOR UPDATE" : ""}`,
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    const items = await this.run<ItemRow>("SELECT * FROM order_items WHERE order_id = $1", [id]);
    return this.toOrder(row, items.rows.map((r) => this.toItem(r)));
  }

  async list(filter: OrderFilter): Promise<Order[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.customerId !== undefined) {
      values.push(filter.customerId);
      where.push(`customer_id = $${values.length}`);
    }
    if (filter.status !== undefined) {
      values.push(filter.status);
      where.push(`status = $${values.length}`);
    }
    values.push(filter.limit, filter.offset);
    const { rows } = await this.run<OrderRow>(
      `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    if (rows.length === 0) return [];

    // One query for every listed order's items, instead of one query per order.
    const items = await this.run<ItemRow>("SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])", [
      rows.map((r) => r.id),
    ]);
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of items.rows) {
      const list = byOrder.get(item.order_id) ?? [];
      list.push(this.toItem(item));
      byOrder.set(item.order_id, list);
    }
    return rows.map((r) => this.toOrder(r, byOrder.get(r.id) ?? []));
  }

  async insert(order: {
    customerId: string | null;
    cartId: string;
    contactName: string;
    contactPhone: string;
    shippingAddress: string;
    subtotal: number;
    shippingMethod: string | null;
    shippingCost: number;
    paymentMethod: string | null;
    items: OrderItem[];
  }): Promise<string> {
    const { rows } = await this.run<{ id: string }>(
      `INSERT INTO orders (customer_id, cart_id, contact_name, contact_phone, shipping_address,
                           subtotal, shipping_method, shipping_cost, total, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        order.customerId,
        order.cartId,
        order.contactName,
        order.contactPhone,
        order.shippingAddress,
        order.subtotal,
        order.shippingMethod,
        order.shippingCost,
        order.subtotal + order.shippingCost,
        order.paymentMethod,
      ]
    );
    const id = (rows[0] as { id: string }).id;
    for (const item of order.items) {
      await this.run(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, item.productId, item.productName, item.unitPrice, item.quantity, item.lineTotal]
      );
    }
    return id;
  }

  async setPayment(id: string, status: PaymentStatus, reference: string | null | undefined): Promise<void> {
    await this.run(
      "UPDATE orders SET payment_status = $2, payment_reference = COALESCE($3, payment_reference), updated_at = now() WHERE id = $1",
      [id, status, reference ?? null]
    );
  }

  async setStatus(id: string, status: OrderStatus): Promise<void> {
    await this.run("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
  }
}

export const ORDERS_REPOSITORY = createToken<OrdersRepository>("OrdersRepository");
