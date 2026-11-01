import type { Pool, PoolClient } from "pg";

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
 * مثال مبسّط من checkout في orders.service.ts:
 *   const orderId = await withTransaction(pool, async (client) => {
 *     await new InventoryRepository(client).adjust(productId, -2);
 *     return new OrdersRepository(client).insert({ ... });
 *   });
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // نلغي كل شيء، ثم نعيد رمي الخطأ الأصلي ليصل إلى معالج الأخطاء.
    // و catch هنا تتجاهل فشل ROLLBACK نفسه (إن انقطع الاتصال)، حتى لا يختفي الخطأ الأصلي.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    // يعمل دائماً: نعيد الاتصال إلى المجموعة، وإلا نفدت الاتصالات مع الوقت.
    client.release();
  }
}
