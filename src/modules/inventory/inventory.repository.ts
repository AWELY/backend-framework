import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import { ConflictError, ErrorCodes, NotFoundError } from "../../engine/errors";
import type { StockLevel, VariantStockLevel } from "./inventory.schema";

/**
 * مستودع المخزون. لا يرث Repository لأن جدوله مفتاحه product_id (أو variant_id) لا id،
 * وعملياته (ضبط، وزيادة/إنقاص ذري) مختلفة عن CRUD العادي.
 */
export class InventoryRepository {
  constructor(private readonly db: Queryable) {}

  /** ينفّذ استعلاماً ويترجم أخطاء القاعدة إلى أخطاء HTTP (نفس فكرة Repository.query). */
  private async run<R extends QueryResultRow>(text: string, values: unknown[]) {
    try {
      return await this.db.query<R>(text, values);
    } catch (err) {
      throw translateDbError(err);
    }
  }

  /** شكل الرد: الكمية، و inStock = true إن كانت أكبر من صفر. */
  private toLevel(productId: string, quantity: number): StockLevel {
    return { productId, quantity, inStock: quantity > 0 };
  }

  /**
   * مخزون منتج. المنتج الذي لا صف له في جدول المخزون كميته صفر (COALESCE).
   * منتج غير موجود أصلاً يعطي 404 (وليس "صفر"، حتى لا يظن أحد أن المنتج موجود).
   */
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

  /** مخزون المنتج مع مخزون كل أشكاله (لصفحة المنتج: "هذا اللون نفد"). */
  async levels(productId: string): Promise<StockLevel> {
    const level = await this.get(productId);
    const { rows } = await this.run<{ id: string; sku: string; quantity: number }>(
      `SELECT v.id, v.sku, COALESCE(vi.quantity, 0) AS quantity
         FROM product_variants v LEFT JOIN variant_inventory vi ON vi.variant_id = v.id
        WHERE v.product_id = $1 ORDER BY v.position, v.created_at`,
      [productId]
    );
    if (rows.length > 0) {
      level.variants = rows.map((r) => ({ variantId: r.id, productId, sku: r.sku, quantity: r.quantity, inStock: r.quantity > 0 }));
    }
    return level;
  }

  /**
   * يضبط الكمية مباشرة. INSERT ... ON CONFLICT DO UPDATE: ينشئ صف المخزون إن لم يوجد،
   * أو يحدّثه إن وُجد، في استعلام واحد (Upsert).
   */
  async set(productId: string, quantity: number): Promise<StockLevel> {
    await this.get(productId); // 404 للمنتج غير الموجود، قبل لمس جدول المخزون
    const { rows } = await this.run<{ quantity: number }>(
      `INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()
       RETURNING quantity`,
      [productId, quantity]
    );
    return this.toLevel(productId, (rows[0] as { quantity: number }).quantity);
  }

  /**
   * يزيد أو ينقص الكمية بمقدار delta، بتحديث ذري واحد:
   *   UPDATE ... SET quantity = quantity + delta WHERE ... AND quantity + delta >= 0
   *
   * لماذا ليس "اقرأ الكمية، ثم احسب، ثم اكتب"؟ لأن طلبين متزامنين قد يقرآن نفس الكمية (1)،
   * فيبيع كل منهما القطعة الأخيرة. التحديث الذري يحدث داخل القاعدة في خطوة واحدة مع قفل الصف:
   * الطلب الثاني ينتظر الأول، ثم يجد الكمية 0 فلا يطابق الشرط، فلا يُحدَّث أي صف.
   * لا صف محدّث يعني أن المخزون لا يكفي: 409 INSUFFICIENT_STOCK.
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
    if (!row) throw new ConflictError("Insufficient stock", { productId, requested: -delta }, ErrorCodes.INSUFFICIENT_STOCK);
    return this.toLevel(productId, row.quantity);
  }

  /** مخزون شكل واحد. شكل غير موجود يعطي 404. */
  async getVariant(variantId: string): Promise<VariantStockLevel> {
    if (!isUuid(variantId)) throw new NotFoundError("Variant not found");
    const { rows } = await this.run<{ product_id: string; sku: string; quantity: number }>(
      `SELECT v.product_id, v.sku, COALESCE(vi.quantity, 0) AS quantity
         FROM product_variants v LEFT JOIN variant_inventory vi ON vi.variant_id = v.id
        WHERE v.id = $1`,
      [variantId]
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("Variant not found");
    return { variantId, productId: row.product_id, sku: row.sku, quantity: row.quantity, inStock: row.quantity > 0 };
  }

  /** يضبط مخزون شكل مباشرة. */
  async setVariant(variantId: string, quantity: number): Promise<VariantStockLevel> {
    const level = await this.getVariant(variantId);
    await this.run(
      `INSERT INTO variant_inventory (variant_id, quantity) VALUES ($1, $2)
       ON CONFLICT (variant_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [variantId, quantity]
    );
    return { ...level, quantity, inStock: quantity > 0 };
  }

  /** نفس adjust، لمخزون شكل. */
  async adjustVariant(variantId: string, delta: number): Promise<VariantStockLevel> {
    const level = await this.getVariant(variantId);
    await this.run("INSERT INTO variant_inventory (variant_id) VALUES ($1) ON CONFLICT (variant_id) DO NOTHING", [variantId]);
    const { rows } = await this.run<{ quantity: number }>(
      `UPDATE variant_inventory SET quantity = quantity + $2, updated_at = now()
        WHERE variant_id = $1 AND quantity + $2 >= 0
        RETURNING quantity`,
      [variantId, delta]
    );
    const row = rows[0];
    if (!row) {
      throw new ConflictError("Insufficient stock", { productId: level.productId, variantId, requested: -delta }, ErrorCodes.INSUFFICIENT_STOCK);
    }
    return { ...level, quantity: row.quantity, inStock: row.quantity > 0 };
  }

  /** يغيّر مخزون سطر (منتج أو شكل) بمقدار delta. تستخدمه الطلبات عند الشراء والإلغاء والإرجاع. */
  adjustLine(line: { productId: string; variantId: string | null }, delta: number): Promise<unknown> {
    return line.variantId ? this.adjustVariant(line.variantId, delta) : this.adjust(line.productId, delta);
  }
}

/**
 * ترتيب أقفال المخزون: كل معاملة تلمس عدة صفوف مخزون (الشراء، والإلغاء، والإرجاع) يجب أن تقفلها
 * بنفس الترتيب. لو قفلت معاملة المنتج A ثم B، وأخرى B ثم A في نفس اللحظة، لانتظرت كل منهما الأخرى
 * للأبد (Deadlock)، فيلغي PostgreSQL إحداهما. قسنا هذا قبل الإصلاح: 60 شراء متزامن بترتيب معاكس،
 * فشل منها 51 بخطأ 500. الترتيب الثابت (برقم المنتج ثم رقم الشكل) يجعل الانتظار في صف واحد لا دائرة.
 */
export function byStockLockOrder<T extends { productId: string; variantId: string | null }>(a: T, b: T): number {
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : (a.variantId ?? "") < (b.variantId ?? "") ? -1 : (a.variantId ?? "") > (b.variantId ?? "") ? 1 : 0;
}

/** رمز المستودع في الحاوية. */
export const INVENTORY_REPOSITORY = createToken<InventoryRepository>("InventoryRepository");
