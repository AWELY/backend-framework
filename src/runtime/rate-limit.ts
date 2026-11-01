import type { Queryable } from "../db/repository";
import type { Limiter, LimiterOptions } from "../engine/rate-limiter";

/**
 * حد المحاولات محفوظاً في PostgreSQL (جدول rate_limits)، بنفس قواعد FailureLimiter:
 * نافذة زمنية ثابتة لكل مفتاح، تبدأ مع أول محاولة، ويُحظر المفتاح بعد maxFailures محاولة.
 *
 * لماذا في القاعدة وليس في الذاكرة؟ العدّاد في الذاكرة يعيش في نسخة خادم واحدة. خلف موازن أحمال
 * بنسختين، يحصل المهاجم على ضعف المحاولات، وإعادة التشغيل تصفّر كل شيء. في القاعدة، كل النسخ
 * ترى نفس العدّاد. الثمن استعلام صغير لكل محاولة دخول، أرخص بكثير من حساب hash كلمة المرور (35ms).
 *
 * الزيادة ذرية في استعلام واحد (INSERT ... ON CONFLICT DO UPDATE): طلبان متزامنان لا يقرآن نفس
 * العدد القديم. والوقت يُقرأ من ساعة القاعدة (now())، فلا يهم اختلاف ساعات الخوادم.
 * الصفوف المنتهية يحذفها عمل التنظيف الدوري (system.cleanup).
 */
export class PostgresLimiter implements Limiter {
  constructor(
    private readonly db: Queryable,
    private readonly options: Pick<LimiterOptions, "maxFailures" | "windowSeconds"> & {
      /** بادئة تفصل عدّادات كل حد عن غيره في نفس الجدول، مثل "login". */
      prefix: string;
    }
  ) {}

  private key(key: string): string {
    return `${this.options.prefix}:${key}`;
  }

  async retryAfter(key: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number; wait: number }>(
      `SELECT count, CEIL(EXTRACT(EPOCH FROM reset_at - now()))::int AS wait
         FROM rate_limits WHERE key = $1 AND reset_at > now()`,
      [this.key(key)]
    );
    const row = rows[0];
    if (!row || row.count < this.options.maxFailures) return 0;
    return Math.max(1, row.wait);
  }

  async recordFailure(key: string): Promise<void> {
    await this.db.query(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END`,
      [this.key(key), this.options.windowSeconds]
    );
  }

  /** نفس recordFailure، باسم يوضح النية لحدود تعدّ كل محاولة (مثل التسجيل). */
  recordAttempt(key: string): Promise<void> {
    return this.recordFailure(key);
  }

  /**
   * يزيد العدّاد ويقرر في استعلام واحد: المحاولة رقم maxFailures+1 وما بعدها مرفوضة.
   * المحاولة المرفوضة تُعدّ أيضاً، وهذا لا يطيل الحظر لأن النافذة ثابتة (reset_at لا يتغير).
   */
  async consume(key: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number; wait: number }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING count, CEIL(EXTRACT(EPOCH FROM reset_at - now()))::int AS wait`,
      [this.key(key), this.options.windowSeconds]
    );
    const row = rows[0] as { count: number; wait: number };
    return row.count > this.options.maxFailures ? Math.max(1, row.wait) : 0;
  }

  async reset(key: string): Promise<void> {
    await this.db.query("DELETE FROM rate_limits WHERE key = $1", [this.key(key)]);
  }
}
