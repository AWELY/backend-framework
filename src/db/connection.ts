import { Pool, types as pgTypes, type PoolConfig } from "pg";

/**
 * إعدادات مجموعة الاتصالات التي تهم الإنتاج، بأسماء واضحة (تحوّلها createPool إلى أسماء مكتبة pg).
 */
export interface DatabaseOptions {
  /** أقصى عدد اتصالات مفتوحة. الافتراضي 10. مجموعها على كل نسخ الخادم يجب أن يبقى أقل من max_connections في PostgreSQL. */
  poolMax?: number;
  /**
   * أقصى مدة لأي استعلام واحد، بالملي ثانية. بعدها يلغيه PostgreSQL بنفسه.
   * بدونه يستطيع استعلام عالق واحد أن يحجز اتصالاً للأبد، وبعد عشرة منها يتوقف المتجر كله.
   */
  statementTimeoutMs?: number;
  /**
   * أقصى مدة تبقى فيها معاملة مفتوحة دون أن تفعل شيئاً. معاملة منسية (خطأ برمجي لم يستدعِ COMMIT)
   * تحمل أقفالاً تمنع الآخرين؛ PostgreSQL ينهيها بعد هذه المدة ويحرر أقفالها.
   */
  idleInTransactionTimeoutMs?: number;
  /** كم ننتظر للحصول على اتصال قبل أن نستسلم. بدونه ينتظر الطلب بلا حد إن كانت القاعدة متوقفة. */
  connectionTimeoutMs?: number;
  /** الاسم الذي يظهر في pg_stat_activity، فيعرف مدير القاعدة من أين يأتي كل اتصال. */
  applicationName?: string;
}

/**
 * محوّلات الأنواع: كيف تتحول قيم PostgreSQL النصية إلى قيم JavaScript.
 *
 * المبالغ في الإطار من نوع BIGINT (int8) منذ migration 0910: INTEGER يتوقف عند 2,147,483,647،
 * أي نحو 2.1 مليون دينار بالدرهم، وهذا يكفي لمنتج لكنه قد لا يكفي لمجموع مبيعات سنة.
 * مكتبة pg ترجع BIGINT نصاً افتراضياً (لأن الرقم قد يتجاوز ما يحفظه JavaScript بدقة)، فيصبح
 * السعر في الـ API "70000" بدل 70000. هنا نحوّله رقماً، ونرمي خطأ إن تجاوز 2^53 (9 كوادريليون):
 * خطأ صريح أفضل من رقم خاطئ بصمت. COUNT(*) أيضاً BIGINT، فيصل رقماً كذلك.
 *
 * نمرر المحوّل للمجموعة نفسها (types)، لا نغيّر الإعداد العام لمكتبة pg، حتى لا نؤثر على
 * أي كود آخر في نفس البرنامج يستخدم pg بطريقته.
 */
const INT8_OID = 20;
const typeOverrides = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8_OID && format !== "binary") {
      return (value: string) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER`);
        return n;
      };
    }
    return pgTypes.getTypeParser(oid, format as "text");
  }) as typeof pgTypes.getTypeParser,
};

/**
 * ينشئ مجموعة اتصالات (Connection pool) بقاعدة PostgreSQL الوحيدة المعرّفة في الإعدادات.
 *
 * لماذا مجموعة اتصالات وليس اتصالاً واحداً؟
 *   - الطلبات تصل بالتوازي، واتصال واحد يجعلها تنتظر بعضها.
 *   - فتح اتصال جديد مع كل طلب بطيء: مصافحة شبكية، ثم تسجيل دخول إلى القاعدة.
 *   - المجموعة تحتفظ باتصالات مفتوحة، تعير واحداً لكل استعلام ثم تستعيده.
 * المجموعة لا تتصل عند إنشائها، بل عند أول استعلام.
 *
 * قاعدة "نظام تخزين واحد" مطبقة هنا: لا يوجد أي جزء آخر في الإطار يفتح اتصالاً خاصاً به.
 * كل المستودعات (Repositories) والعمال في الخلفية تستلم نفس هذه المجموعة.
 *
 * options: إما DatabaseOptions، أو إعدادات pg الخام (PoolConfig) لمن يحتاج شيئاً خاصاً مثل ssl.
 */
export function createPool(connectionString: string, options: DatabaseOptions & Partial<PoolConfig> = {}): Pool {
  const { poolMax, statementTimeoutMs, idleInTransactionTimeoutMs, connectionTimeoutMs, applicationName, ...raw } =
    options;
  const config: PoolConfig = { connectionString, types: typeOverrides, ...raw };
  if (poolMax !== undefined) config.max = poolMax;
  if (statementTimeoutMs !== undefined) config.statement_timeout = statementTimeoutMs;
  if (idleInTransactionTimeoutMs !== undefined) config.idle_in_transaction_session_timeout = idleInTransactionTimeoutMs;
  if (connectionTimeoutMs !== undefined) config.connectionTimeoutMillis = connectionTimeoutMs;
  if (applicationName !== undefined) config.application_name = applicationName;
  return new Pool(config);
}

/**
 * فحص سريع للاتصال: أبسط استعلام ممكن. إن نجح فالقاعدة تعمل.
 * يستخدمه المسار GET /health و GET /readyz في src/app.ts.
 */
export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
