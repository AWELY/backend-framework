import type { Pool } from "pg";

/**
 * منفّذ Migrations صغير، دون أداة خارجية.
 *
 * الـ Migration: سكربت SQL ينشئ جدولاً أو يعدّله، وله رقم ترتيب. كل وحدة تحمل سكربتات
 * جداولها كقائمة Migration (نص SQL داخل ملفات TypeScript، فيُترجم إلى dist/ مع الكود،
 * دون ملفات إضافية تحتاج نسخاً).
 *
 * كل migration يُطبَّق يُسجَّل رقمه في جدول schema_migrations. لذلك تشغيله مرة ثانية
 * يطبّق الجديد فقط، والباقي يتجاوزه ("Database is already up to date").
 *
 * يُشغَّل بأمر منفصل (npm run migrate)، لا تلقائياً مع كل إقلاع للخادم: تغيير مخطط قاعدة
 * البيانات قرار يجب أن يحدث عن قصد.
 */

export interface Migration {
  /**
   * رقم ترتيب عام لكل المشروع، مثل "0100_categories". تُرتَّب الأرقام كنصوص.
   * لهذا الأرقام بمسافات (0100، 0200...): يمكن إدراج migration لاحق بينها، مثل 0810.
   */
  id: string;
  /** نص SQL الذي ينشئ أو يعدّل الجداول. */
  up: string;
}

// رقم ثابت اخترناه عشوائياً: مفتاح قفل استشاري (Advisory lock) في PostgreSQL.
// يمنع عمليتين بدأتا في نفس اللحظة (مثلاً نسختين من الخادم) من تطبيق نفس الـ migration مرتين.
const MIGRATION_LOCK_KEY = 727_274;

/**
 * يطبّق كل migration لم يُطبَّق بعد، بالترتيب، ويرجع أرقام ما طُبّق الآن.
 * log: دالة اختيارية لطباعة كل خطوة.
 */
export async function runMigrations(
  pool: Pool,
  migrations: Migration[],
  log: (message: string) => void = () => undefined
): Promise<string[]> {
  // نرتب نسخة من القائمة (لا نعدّل الأصل) حسب الرقم.
  const sorted = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  // رقمان متكرران خطأ برمجي (وحدتان اختارتا نفس الرقم): نوقف كل شيء قبل لمس القاعدة.
  const ids = new Set<string>();
  for (const m of sorted) {
    if (ids.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
    ids.add(m.id);
  }

  // اتصال واحد مخصص طوال العملية، لأن القفل الاستشاري مرتبط بالاتصال الذي أخذه.
  const client = await pool.connect();
  try {
    // ننتظر القفل: إن كانت عملية أخرى تطبّق الـ migrations الآن، ننتظرها حتى تنتهي.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    // جدول السجل نفسه، يُنشأ في أول مرة فقط.
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    // ما طُبّق من قبل. نقرؤه بعد أخذ القفل، فلا نرى حالة قديمة.
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const done = new Set(rows.map((r) => r.id));

    const applied: string[] = [];
    for (const migration of sorted) {
      if (done.has(migration.id)) continue;
      // كل migration في معاملته الخاصة: إما أن يُطبَّق كاملاً ويُسجَّل، وإما لا شيء.
      // فلا يبقى جدول نصف منشأ إن فشل سطر في منتصفه.
      await client.query("BEGIN");
      try {
        await client.query(migration.up);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`);
      }
      applied.push(migration.id);
      log(`Applied migration ${migration.id}`);
    }
    return applied;
  } finally {
    // يعمل دائماً، نجحنا أو فشلنا: نفك القفل ونعيد الاتصال للمجموعة.
    // و catch تتجاهل خطأ فك القفل إن انقطع الاتصال أصلاً (القفل يُفك وحده عندها).
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
