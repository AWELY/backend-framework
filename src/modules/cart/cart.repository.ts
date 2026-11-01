import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Cart, CartHeader, CartLine } from "./cart.schema";

/** صف من جدول carts. */
interface CartRow {
  id: string;
  customer_id: string | null;
  status: "open" | "checked_out";
  created_at: Date;
  updated_at: Date;
}

/** سطر سلة بعد ربطه ببيانات المنتج (JOIN بين cart_items و products). */
interface LineRow {
  product_id: string;
  name: string;
  image_url: string | null;
  price: number;
  quantity: number;
  is_active: boolean;
}

/**
 * مستودع السلال. جدولان: carts (رأس السلة) و cart_items (سطورها).
 * لا يرث من Repository لأن السلة تُقرأ مع سطورها معاً، وعملياتها ليست CRUD عادياً.
 */
export class CartRepository {
  constructor(private readonly db: Queryable) {}

  /** ينفّذ استعلاماً ويترجم أخطاء القاعدة إلى أخطاء HTTP. */
  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** ينشئ سلة فارغة (مربوطة بزبون، أو null للضيف)، ثم يرجعها بالشكل الكامل. */
  async create(customerId: string | null): Promise<Cart> {
    const { rows } = await this.run<{ id: string }>("INSERT INTO carts (customer_id) VALUES ($1) RETURNING id", [
      customerId,
    ]);
    return (await this.findById((rows[0] as { id: string }).id)) as Cart;
  }

  /**
   * رأس السلة فقط (رقمها، وصاحبها، وحالتها)، دون السطور. يكفي لفحص الصلاحية والحالة،
   * وأخف من قراءة السلة كاملة.
   */
  async findHeader(id: string): Promise<CartHeader | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const row = rows[0];
    return row ? { id: row.id, customerId: row.customer_id, status: row.status } : null;
  }

  /**
   * السلة كاملة بسطورها، مسعّرة بالأسعار الحالية للمنتجات.
   * السلة لا تحفظ الأسعار: إن غيّر المالك سعراً، تُظهر السلة السعر الجديد. السعر يُثبَّت
   * وقت إتمام الشراء فقط، حين يُنسخ إلى order_items.
   */
  async findById(id: string): Promise<Cart | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const cart = rows[0];
    if (!cart) return null;

    // سطور السلة مع اسم المنتج وصورته وسعره الحالي وهل هو نشط، بترتيب الإضافة.
    const lines = await this.run<LineRow>(
      `SELECT ci.product_id, p.name, p.image_url, p.price, ci.quantity, p.is_active
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [id]
    );
    const items: CartLine[] = lines.rows.map((l) => ({
      productId: l.product_id,
      name: l.name,
      imageUrl: l.image_url,
      unitPrice: l.price,
      quantity: l.quantity,
      lineTotal: l.price * l.quantity,
      available: l.is_active,
    }));
    return {
      id: cart.id,
      customerId: cart.customer_id,
      status: cart.status,
      items,
      // المجموع يشمل السطور المتاحة فقط: منتج أُخفي بعد إضافته لا يُحسب.
      // reduce تجمع القيم: تبدأ من 0 وتضيف lineTotal لكل سطر.
      total: items.filter((i) => i.available).reduce((sum, i) => sum + i.lineTotal, 0),
      createdAt: cart.created_at,
      updatedAt: cart.updated_at,
    };
  }

  /** الكمية الحالية لمنتج في السلة (0 إن لم يكن فيها). */
  async quantityOf(cartId: string, productId: string): Promise<number> {
    const { rows } = await this.run<{ quantity: number }>(
      "SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId]
    );
    return rows[0]?.quantity ?? 0;
  }

  /**
   * يضبط السطر إلى quantity بالضبط، و 0 تحذفه.
   * ON CONFLICT (cart_id, product_id): إن كان السطر موجوداً تُحدَّث كميته، وإلا يُنشأ.
   * المفتاح الأساسي (cart_id, product_id) يضمن سطراً واحداً لكل منتج في السلة.
   * بعدها نحدّث updated_at للسلة، فنعرف آخر نشاط فيها.
   */
  async setLine(cartId: string, productId: string, quantity: number): Promise<void> {
    if (quantity === 0) {
      await this.run("DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2", [cartId, productId]);
    } else {
      await this.run(
        `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [cartId, productId, quantity]
      );
    }
    await this.run("UPDATE carts SET updated_at = now() WHERE id = $1", [cartId]);
  }
}

/** رمز المستودع في الحاوية. */
export const CART_REPOSITORY = createToken<CartRepository>("CartRepository");
