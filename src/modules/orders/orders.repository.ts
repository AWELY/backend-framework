import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Order, OrderItem, OrderStatus, PaymentStatus } from "./orders.schema";

/** صف من جدول orders. */
interface OrderRow {
  id: string;
  customer_id: string | null;
  status: OrderStatus;
  contact_name: string;
  contact_phone: string;
  shipping_address: string;
  shipping_city: string | null;
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

/** صف من جدول order_items. */
interface ItemRow {
  order_id: string;
  product_id: string | null;
  product_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

/** خيارات قائمة الطلبات. */
export interface OrderFilter {
  /** طلبات زبون واحد (الزبون يرى طلباته فقط). */
  customerId?: string;
  /** حالة واحدة، مثل "pending". */
  status?: string;
  limit: number;
  offset: number;
}

/**
 * قراءة الطلبات وكتابتها. يعمل على المجموعة (Pool)، أو على اتصال معاملة (انظر orders.service.ts).
 * لا يرث من Repository لأن الطلب يُقرأ مع سطوره من جدولين.
 */
export class OrdersRepository {
  constructor(private readonly db: Queryable) {}

  /** ينفّذ استعلاماً ويترجم أخطاء القاعدة إلى أخطاء HTTP. */
  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** صف الطلب وسطوره إلى كائن الـ API. */
  private toOrder(row: OrderRow, items: OrderItem[]): Order {
    return {
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
      shippingAddress: row.shipping_address,
      shippingCity: row.shipping_city,
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

  /** صف سطر إلى كائن الـ API. */
  private toItem(row: ItemRow): OrderItem {
    return {
      productId: row.product_id,
      productName: row.product_name,
      unitPrice: row.unit_price,
      quantity: row.quantity,
      lineTotal: row.line_total,
    };
  }

  /**
   * طلب واحد بسطوره، أو null.
   * forUpdate: يضيف "FOR UPDATE" فيقفل صف الطلب حتى تنتهي المعاملة المحيطة به، فلا تستطيع
   * معاملة أخرى تغيير الطلب نفسه في الأثناء. يستخدمه تغيير الحالة وتسجيل الدفع.
   * (" FOR UPDATE" نص ثابت من كتابتنا، لا من الطلب، فإضافته إلى SQL آمنة.)
   */
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

  /** قائمة الطلبات، الأحدث أولاً، مع تصفية اختيارية بالزبون أو الحالة. نفس أسلوب ProductsRepository.list. */
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

    // استعلام واحد لسطور كل الطلبات في القائمة، بدل استعلام لكل طلب. الطريقة البديلة
    // (استعلام لكل طلب) اسمها مشكلة N+1: 50 طلباً تعني 51 استعلاماً بدل 2.
    // ANY($1::uuid[]) تعني: order_id واحد من قائمة الأرقام المرسلة كمصفوفة.
    const items = await this.run<ItemRow>("SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])", [
      rows.map((r) => r.id),
    ]);
    // نوزع السطور على طلباتها: رقم الطلب وقائمة سطوره.
    const byOrder = new Map<string, OrderItem[]>();
    for (const item of items.rows) {
      const list = byOrder.get(item.order_id) ?? [];
      list.push(this.toItem(item));
      byOrder.set(item.order_id, list);
    }
    return rows.map((r) => this.toOrder(r, byOrder.get(r.id) ?? []));
  }

  /**
   * ينشئ الطلب وسطوره، ويرجع رقمه. يستدعيه checkout داخل المعاملة فقط.
   * الإجمالي (total) يُحسب هنا: subtotal + shippingCost، فلا يمكن أن يختلف عن مكوّناته.
   */
  async insert(order: {
    customerId: string | null;
    cartId: string;
    contactName: string;
    contactPhone: string;
    shippingAddress: string;
    shippingCity: string | null;
    subtotal: number;
    shippingMethod: string | null;
    shippingCost: number;
    paymentMethod: string | null;
    items: OrderItem[];
  }): Promise<string> {
    const { rows } = await this.run<{ id: string }>(
      `INSERT INTO orders (customer_id, cart_id, contact_name, contact_phone, shipping_address, shipping_city,
                           subtotal, shipping_method, shipping_cost, total, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        order.customerId,
        order.cartId,
        order.contactName,
        order.contactPhone,
        order.shippingAddress,
        order.shippingCity,
        order.subtotal,
        order.shippingMethod,
        order.shippingCost,
        order.subtotal + order.shippingCost,
        order.paymentMethod,
      ]
    );
    const id = (rows[0] as { id: string }).id;
    // سطر لكل منتج، بالاسم والسعر المنسوخين وقت الشراء.
    for (const item of order.items) {
      await this.run(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, item.productId, item.productName, item.unitPrice, item.quantity, item.lineTotal]
      );
    }
    return id;
  }

  /**
   * يحدّث حالة الدفع. COALESCE($3, payment_reference): إن لم يُرسل رقم عملية جديد،
   * يبقى الرقم القديم كما هو بدل أن يُمسح.
   */
  async setPayment(id: string, status: PaymentStatus, reference: string | null | undefined): Promise<void> {
    await this.run(
      "UPDATE orders SET payment_status = $2, payment_reference = COALESCE($3, payment_reference), updated_at = now() WHERE id = $1",
      [id, status, reference ?? null]
    );
  }

  /** يحدّث حالة الطلب. صحة الانتقال يفحصها OrdersService.changeStatus قبل استدعائها. */
  async setStatus(id: string, status: OrderStatus): Promise<void> {
    await this.run("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
  }
}

/** رمز المستودع في الحاوية. */
export const ORDERS_REPOSITORY = createToken<OrdersRepository>("OrdersRepository");
