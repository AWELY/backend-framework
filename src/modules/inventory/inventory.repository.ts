import type { QueryResultRow } from "pg";
import type { Queryable } from "../../db/repository";
import { translateDbError } from "../../db/errors";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import { ConflictError, NotFoundError } from "../../engine/errors";
import type { StockLevel } from "./inventory.schema";

/**
 * مستودع المخزون: كمية لكل منتج.
 *
 * لا يرث من Repository، لأن جدوله مختلف: مفتاحه product_id (وليس id خاصاً به)،
 * وعملياته "اقرأ، واضبط، وعدّل بمقدار"، وليست إنشاء وقراءة وتعديل وحذف (CRUD).
 *
 * يمكن إنشاؤه باتصال معاملة (من withTransaction) عندما يجب أن يتغير المخزون مع كتابات
 * أخرى معاً. أهم مثال: وحدة الطلبات تنقص المخزون في نفس المعاملة التي تنشئ الطلب،
 * فإن فشل إنشاء الطلب، يرجع المخزون تلقائياً.
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
   * كمية منتج موجود: 0 إن لم يُضبط مخزونه أبداً، و 404 إن لم يوجد المنتج نفسه.
   *
   * لماذا LEFT JOIN؟ نبدأ من جدول المنتجات: إن لم يوجد المنتج، لا صف أصلاً، فنعرف أنه 404.
   * وإن وُجد بلا صف في inventory، يكون i.quantity قيمة NULL، و COALESCE تحوّلها إلى 0.
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

  /**
   * يضبط الكمية إلى رقم محدد.
   * "INSERT ... ON CONFLICT DO UPDATE" (اسمه Upsert): إن لم يوجد صف للمنتج يُنشأ، وإن وُجد
   * تُحدَّث كميته. و EXCLUDED.quantity هي القيمة التي حاولنا إدخالها.
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
   * يضيف delta إلى الكمية (رقم سالب للإنقاص). أهم دالة لمنع البيع أكثر من المخزون.
   *
   * الفحص والتعديل يحدثان في استعلام UPDATE واحد (عملية ذرية، Atomic):
   *   UPDATE ... SET quantity = quantity + $2 WHERE product_id = $1 AND quantity + $2 >= 0
   * إن كانت النتيجة ستصبح سالبة، لا يطابق الشرط أي صف، فلا يتغير شيء، ونرمي 409.
   *
   * لماذا لا نقرأ الكمية أولاً ثم نكتبها؟ لأن مشتريين لآخر قطعة في نفس اللحظة سيقرآن
   * كلاهما "1"، ثم يكتب كلاهما "0"، فتُباع القطعة مرتين. أما هنا فالقاعدة تقفل الصف أثناء
   * UPDATE، فينجح الأول، ويجد الثاني الكمية 0 فلا يطابق الشرط، ويحصل على 409.
   * يثبته اختبار التزامن في tests/integration/inventory.test.ts: 10 مشترين في نفس اللحظة
   * و 5 قطع في المخزون، فينجح 5 بالضبط، وينتهي المخزون عند 0.
   */
  async adjust(productId: string, delta: number): Promise<StockLevel> {
    await this.get(productId);
    // نتأكد أن للمنتج صفاً في المخزون (بكمية 0 افتراضياً)، حتى يجد UPDATE ما يعدّله.
    // DO NOTHING: إن كان الصف موجوداً، لا نغير شيئاً.
    await this.run("INSERT INTO inventory (product_id) VALUES ($1) ON CONFLICT (product_id) DO NOTHING", [productId]);
    const { rows } = await this.run<{ quantity: number }>(
      `UPDATE inventory SET quantity = quantity + $2, updated_at = now()
        WHERE product_id = $1 AND quantity + $2 >= 0
        RETURNING quantity`,
      [productId, delta]
    );
    const row = rows[0];
    // لا صف رجع: الكمية لا تكفي. requested هي الكمية المطلوب سحبها (موجبة).
    if (!row) throw new ConflictError("Insufficient stock", { productId, requested: -delta });
    return this.toLevel(productId, row.quantity);
  }
}

/**
 * رمز المستودع في الحاوية. تطلبه السلة لفحص المخزون عند الإضافة. أما خدمة الطلبات فتنشئ
 * نسخة خاصة بها باتصال المعاملة: new InventoryRepository(client)، لتكون جزءاً من معاملة الشراء.
 */
export const INVENTORY_REPOSITORY = createToken<InventoryRepository>("InventoryRepository");
