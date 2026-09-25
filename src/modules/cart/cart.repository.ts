import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
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
  name: string;
  price: number;
  quantity: number;
  is_active: boolean;
}

export class CartRepository {
  constructor(private readonly db: Queryable) {}

  private async run<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  async create(customerId: string | null): Promise<Cart> {
    const { rows } = await this.run<{ id: string }>("INSERT INTO carts (customer_id) VALUES ($1) RETURNING id", [
      customerId,
    ]);
    return (await this.findById((rows[0] as { id: string }).id)) as Cart;
  }

  async findHeader(id: string): Promise<CartHeader | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const row = rows[0];
    return row ? { id: row.id, customerId: row.customer_id, status: row.status } : null;
  }

  /** The cart with its lines priced at the products' CURRENT prices. */
  async findById(id: string): Promise<Cart | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.run<CartRow>("SELECT * FROM carts WHERE id = $1", [id]);
    const cart = rows[0];
    if (!cart) return null;

    const lines = await this.run<LineRow>(
      `SELECT ci.product_id, p.name, p.price, ci.quantity, p.is_active
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.added_at`,
      [id]
    );
    const items: CartLine[] = lines.rows.map((l) => ({
      productId: l.product_id,
      name: l.name,
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

  /** Current quantity of one product in the cart (0 if absent). */
  async quantityOf(cartId: string, productId: string): Promise<number> {
    const { rows } = await this.run<{ quantity: number }>(
      "SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId]
    );
    return rows[0]?.quantity ?? 0;
  }

  /** Sets the line to exactly `quantity`; 0 removes it. */
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

export const CART_REPOSITORY = createToken<CartRepository>("CartRepository");
