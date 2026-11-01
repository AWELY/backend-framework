import { Pool, type PoolConfig } from "pg";

/**
 * ينشئ مجموعة اتصالات (Connection pool) بقاعدة PostgreSQL الوحيدة المعرّفة في الإعدادات.
 *
 * لماذا مجموعة اتصالات وليس اتصالاً واحداً؟
 *   - الطلبات تصل بالتوازي، واتصال واحد يجعلها تنتظر بعضها.
 *   - فتح اتصال جديد مع كل طلب بطيء: مصافحة شبكية، ثم تسجيل دخول إلى القاعدة.
 *   - المجموعة تحتفظ باتصالات مفتوحة (حتى 10 افتراضياً في مكتبة pg)، تعير واحداً لكل
 *     استعلام ثم تستعيده.
 * المجموعة لا تتصل عند إنشائها، بل عند أول استعلام.
 *
 * قاعدة "نظام تخزين واحد" مطبقة هنا: لا يوجد أي جزء آخر في الإطار يفتح اتصالاً خاصاً به.
 * كل المستودعات (Repositories) تستلم نفس هذه المجموعة.
 *
 * options: إعدادات إضافية اختيارية لمكتبة pg، مثل max (أقصى عدد اتصالات).
 */
export function createPool(connectionString: string, options: Partial<PoolConfig> = {}): Pool {
  return new Pool({ connectionString, ...options });
}

/**
 * فحص سريع للاتصال: أبسط استعلام ممكن. إن نجح فالقاعدة تعمل.
 * يستخدمه المسار GET /health في src/app.ts.
 */
export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
