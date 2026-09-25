import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import { ConflictError, NotFoundError } from "../../engine/errors";
import type { StockLevel } from "./inventory.schema";

/**
 * Stock per product. Not a subclass of Repository: it is keyed by product_id
 * (not its own id) and its operations are "get / set / adjust", not CRUD.
 *
 * Construct it with a transaction client (withTransaction) when stock must
 * change together with other writes - e.g. the Orders module decrementing
 * stock in the same transaction that creates the order.
 */
export class InventoryRepository {
  constructor(private readonly db: Queryable) {}

  private async run<R extends QueryResultRow>(text: string, values: unknown[]) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  private toLevel(productId: string, quantity: number): StockLevel {
    return { productId, quantity, inStock: quantity > 0 };
  }

  /** Stock for an existing product (0 if it was never stocked); 404 if the product does not exist. */
  async get(productId: string): Promise<StockLevel> {
    if (!isUuid(productId)) throw new NotFoundError("Product not found");
    const { rows } = await this.run<{ quantity: number }>(
      `SELECT COALESCE(i.quantity, 0) AS quantity
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id
        WHERE p.id = $1`,
      [productId]
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Product not found");
    return this.toLevel(productId, row.quantity);
  }

  async set(productId: string, quantity: number): Promise<StockLevel> {
    await this.get(productId); // 404 for unknown products, before touching inventory
    const { rows } = await this.run<{ quantity: number }>(
      `INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()
       RETURNING quantity`,
      [productId, quantity]
    );
    return this.toLevel(productId, (rows[0] as { quantity: number }).quantity);
  }

  /**
   * Adds `delta` (negative to remove). The check and the change happen in ONE
   * UPDATE, so two buyers taking the last item at the same moment cannot both
   * succeed: the second one matches no row and gets 409.
   */
  async adjust(productId: string, delta: number): Promise<StockLevel> {
    await this.get(productId);
    await this.run("INSERT INTO inventory (product_id) VALUES ($1) ON CONFLICT (product_id) DO NOTHING", [productId]);
    const { rows } = await this.run<{ quantity: number }>(
      `UPDATE inventory SET quantity = quantity + $2, updated_at = now()
        WHERE product_id = $1 AND quantity + $2 >= 0
        RETURNING quantity`,
      [productId, delta]
    );
    const row = rows[0];
    if (!row) throw new ConflictError("Insufficient stock", { productId, requested: -delta });
    return this.toLevel(productId, row.quantity);
  }
}

export const INVENTORY_REPOSITORY = createToken<InventoryRepository>("InventoryRepository");
