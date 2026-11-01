import type { Pool, PoolClient } from "pg";
import { isRetryableTransactionError, translateDbError } from "./errors";

/** خيارات المعاملة. */
export interface TransactionOptions {
  /**
   * كم مرة نعيد المعاملة كاملة إن فشلت بتعارض مؤقت (deadlock أو serialization failure).
   * الافتراضي 3 إعادات (أي 4 محاولات). 0 تطفئ الإعادة.
   */
  retries?: number;
}

/** انتظار قصير عشوائي قبل الإعادة، يكبر مع كل محاولة، حتى لا تتصادم المعاملتان مرة أخرى في نفس اللحظة. */
function backoff(attempt: number): Promise<void> {
  const ms = 10 * 2 ** attempt + Math.random() * 20;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ينفّذ work داخل معاملة واحدة (Transaction) على اتصال واحد:
 *   - إن نجحت work كلها: COMMIT، أي تُحفظ كل التغييرات معاً.
 *   - إن رمت خطأ في أي نقطة: ROLLBACK، أي تُلغى كل التغييرات وكأن شيئاً لم يحدث.
 *
 * نستخدمها حين يجب أن تنجح عدة كتابات معاً أو تفشل معاً. أهم مثال: إتمام الشراء
 * (orders.service.ts) ينقص المخزون لكل منتج ثم ينشئ الطلب. لو انقطع شيء بعد إنقاص
 * المخزون وقبل حفظ الطلب، لضاع المخزون بلا طلب. داخل المعاملة يرجع المخزون تلقائياً.
 *
 * لماذا اتصال واحد؟ المعاملة في PostgreSQL مرتبطة بالاتصال. لو نفّذنا الاستعلامات عبر
 * المجموعة (Pool) مباشرة، لذهب كل استعلام إلى اتصال مختلف، ولما كانت معاملة واحدة.
 * لذلك work تستلم client، وكل استعلاماتها يجب أن تمر عبره.
 *
 * الإعادة التلقائية: إن ألغى PostgreSQL المعاملة بسبب deadlock (40P01) أو تعارض (40001)، فهذا
 * ليس خطأ في الطلب، بل توقيت سيئ بين معاملتين. ROLLBACK أعاد كل شيء كما كان، فإعادة work
 * كاملة آمنة. لذلك يجب ألا تفعل work شيئاً خارج القاعدة لا يمكن تكراره (مثل استدعاء بوابة دفع):
 * هذا مكانه بعد COMMIT. إن استمر التعارض بعد كل الإعادات يصل للعميل 503 مع Retry-After.
 *
 * مثال مبسّط من checkout في orders.service.ts:
 *   const orderId = await withTransaction(pool, async (client) => {
 *     await new InventoryRepository(client).adjust(productId, -2);
 *     return new OrdersRepository(client).insert({ ... });
 *   });
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let retry = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (attempt < retries && isRetryableTransactionError(err)) retry = true;
      else throw translateDbError(err);
    } finally {
      // يعيد الاتصال إلى المجموعة في كل الحالات: نجاح، أو خطأ، أو إعادة.
      client.release();
    }
    if (retry) await backoff(attempt);
  }
}
