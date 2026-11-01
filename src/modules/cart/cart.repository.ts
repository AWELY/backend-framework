import type { Pool, QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { withTransaction } from "../../db/transaction";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Cart, CartHeader, CartLine } from "./cart.schema";

interface CartRow {
  id: string;
  customer_id: string | null;
  status: "open" | "checked_out";
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  product_id: string;
  variant_id: string | null;
  sku: string | null;
  name: string;
  variant_title: string | null;
  image_url: string | null;
  price: number;
  quantity: number;
  is_active: boolean;
}

/** مستودع السلال. */
export class CartRepository {
  constructor(private readonly db: Queryable) {}

  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** ينشئ سلة جديدة فارغة (للضيف customerId = null). */
  async create(customerId: string | null): Promise<Cart> {
    const { rows } = await this.run<{ id: string }>("INSERT INTO carts (customer_id) VALUES ($1) RETURNING id", [
      customerId,
    ]);
    return (await this.findById((rows[0] as { id: string }).id)) as Cart;
  }

  /** رأس السلة فقط (للتحقق من الصلاحية قبل أي عمل). */
  async findHeader(id: string): Promise<CartHeader | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const row = rows[0];
    return row ? { id: row.id, customerId: row.customer_id, status: row.status } : null;
  }

  /** أحدث سلة مفتوحة لزبون، أو null. */
  async findOpenForCustomer(customerId: string): Promise<Cart | null> {
    const { rows } = await this.run<{ id: string }>(
      "SELECT id FROM carts WHERE customer_id = $1 AND status = 'open' ORDER BY updated_at DESC LIMIT 1",
      [customerId]
    );
    return rows[0] ? this.findById(rows[0].id) : null;
  }

  /**
   * السلة كاملة مع سطورها، بالأسعار الحالية: سعر الشكل إن كان له سعر، وإلا سعر المنتج.
   * السطور بترتيب إضافتها.
   */
  async findById(id: string): Promise<Cart | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const cart = rows[0];
    if (!cart) return null;

    const lines = await this.run<LineRow>(
      `SELECT ci.product_id, ci.variant_id, v.sku, p.name, v.title AS variant_title, p.image_url,
              COALESCE(v.price, p.price) AS price, ci.quantity,
              (p.is_active AND (v.id IS NULL OR v.is_active)) AS is_active
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         LEFT JOIN product_variants v ON v.id = ci.variant_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [id]
    );
    const items: CartLine[] = lines.rows.map((l) => ({
      productId: l.product_id,
      variantId: l.variant_id,
      sku: l.sku,
      name: l.name,
      variantTitle: l.variant_title,
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
      total: items.filter((i) => i.available).reduce((sum, i) => sum + i.lineTotal, 0),
      createdAt: cart.created_at,
      updatedAt: cart.updated_at,
    };
  }

  /** الكمية الحالية لسطر (0 إن لم يوجد). */
  async quantityOf(cartId: string, productId: string, variantId: string | null = null): Promise<number> {
    const { rows } = await this.run<{ quantity: number }>(
      "SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3",
      [cartId, productId, variantId]
    );
    return rows[0]?.quantity ?? 0;
  }

  /** يضبط كمية سطر: 0 تحذفه، وغيرها تضيفه أو تحدّثه (Upsert). */
  async setLine(cartId: string, productId: string, quantity: number, variantId: string | null = null): Promise<void> {
    if (quantity === 0) {
      await this.run(
        "DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3",
        [cartId, productId, variantId]
      );
    } else {
      await this.run(
        `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT cart_items_line_key DO UPDATE SET quantity = EXCLUDED.quantity`,
        [cartId, productId, variantId, quantity]
      );
    }
    await this.run("UPDATE carts SET updated_at = now() WHERE id = $1", [cartId]);
  }

  /**
   * يدمج سلة ضيف في سلة الزبون عند دخوله، ويرجع رقم سلة الزبون الناتجة (أو null إن لم تصلح
   * سلة الضيف: غير موجودة، أو ليست مفتوحة، أو تخص زبوناً آخر).
   *
   *   - الزبون بلا سلة مفتوحة: سلة الضيف نفسها تصبح سلته.
   *   - له سلة مفتوحة: تُنقل سطور الضيف إليها (والسطر الموجود في الاثنتين تُجمع كميته بحد 1000)،
   *     ثم تُحذف سلة الضيف.
   * كله في معاملة، مع قفل السلتين، فلا يضيع سطر إن أضاف الضيف شيئاً في نفس اللحظة.
   */
  static async mergeGuestCart(pool: Pool, guestCartId: string, customerId: string): Promise<string | null> {
    if (!isUuid(guestCartId)) return null;
    return withTransaction(pool, async (client) => {
      const guest = await client.query<CartRow>("SELECT * FROM carts WHERE id = $1 FOR UPDATE", [guestCartId]);
      const g = guest.rows[0];
      if (!g || g.status !== "open") return null;
      if (g.customer_id !== null) return g.customer_id === customerId ? g.id : null;

      const own = await client.query<{ id: string }>(
        `SELECT id FROM carts WHERE customer_id = $1 AND status = 'open' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [customerId]
      );
      const target = own.rows[0]?.id;
      if (!target) {
        await client.query("UPDATE carts SET customer_id = $2, updated_at = now() WHERE id = $1", [g.id, customerId]);
        return g.id;
      }
      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, added_at)
         SELECT $2, product_id, variant_id, quantity, added_at FROM cart_items WHERE cart_id = $1
         ON CONFLICT ON CONSTRAINT cart_items_line_key
         DO UPDATE SET quantity = LEAST(1000, cart_items.quantity + EXCLUDED.quantity)`,
        [g.id, target]
      );
      await client.query("DELETE FROM carts WHERE id = $1", [g.id]);
      await client.query("UPDATE carts SET updated_at = now() WHERE id = $1", [target]);
      return target;
    });
  }

  /** يحذف سلال الضيوف المفتوحة التي لم تتغير منذ olderThanDays يوماً. يرجع عددها. */
  async deleteAbandoned(olderThanDays: number): Promise<number> {
    const result = await this.run(
      `DELETE FROM carts WHERE status = 'open' AND customer_id IS NULL AND updated_at < now() - make_interval(days => $1)`,
      [olderThanDays]
    );
    return result.rowCount ?? 0;
  }
}

/** رمز المستودع في الحاوية. */
export const CART_REPOSITORY = createToken<CartRepository>("CartRepository");
