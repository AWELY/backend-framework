import type { Pool } from "pg";
import type { Queryable } from "../db/repository";
import type { Logger } from "../engine/logger";
import type { MetricsRegistry } from "../engine/metrics";

/** ما يستلمه منفّذ المهمة بجانب بياناتها. */
export interface JobContext {
  jobId: string;
  /** رقم المحاولة: 1 أول مرة. */
  attempt: number;
  logger: Logger;
}

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void> | void;

interface Definition {
  handler: JobHandler;
  maxAttempts: number;
}

interface Schedule {
  name: string;
  everyMs: number;
  payload: Record<string, unknown>;
  /** آخر "خانة زمنية" أُضيفت فيها المهمة من هذه النسخة، حتى لا نحاول الإضافة مع كل دورة. */
  lastBucket: number;
}

interface ClaimedJob {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * طابور مهام في الخلفية فوق PostgreSQL (جدول jobs)، دون Redis ولا أداة خارجية.
 *
 * أمثلة ما يعمل هنا: تنظيف السلال المتروكة كل يوم، وإلغاء الطلبات التي لم تُدفع في مهلتها كل دقيقة،
 * وحذف المفاتيح والجلسات المنتهية كل ساعة. والإضافات تستطيع تعريف مهامها بنفس الطريقة.
 *
 *   define(name, handler)        : يعرّف ماذا تفعل المهمة (عند الإقلاع، في كل نسخة).
 *   enqueue(name, payload, ...)  : يضيف مهمة للتنفيذ الآن أو لاحقاً (runAt). db: اتصال معاملة
 *                                  ليُضاف مع التغيير نفسه أو لا يُضاف أبداً.
 *   schedule(name, everyMs)      : مهمة دورية.
 *
 * كيف لا تُنفَّذ المهمة الدورية مرتين على نسختي خادم؟ كل نسخة تحاول إضافتها بمفتاح يتكرر
 * (dedupe_key) = الاسم + رقم الخانة الزمنية (الوقت ÷ المدة). القيد UNIQUE يقبل الأولى ويرفض الثانية
 * بصمت (ON CONFLICT DO NOTHING). ثم التنفيذ نفسه بالاستئجار و SKIP LOCKED، مثل الأحداث.
 *
 * الفشل: إعادة بانتظار متزايد حتى maxAttempts، ثم "ميتة" (dead_at) مع آخر خطأ.
 * القرار في docs/adr/0008-postgres-job-queue.md.
 */
export class JobQueue {
  private readonly definitions = new Map<string, Definition>();
  private readonly schedules: Schedule[] = [];
  private readonly processed;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    metrics?: MetricsRegistry,
    private readonly leaseSeconds = 300
  ) {
    this.processed = metrics?.counter("jobs_total", "Background jobs handled, by name and result");
  }

  define(name: string, handler: JobHandler, options: { maxAttempts?: number } = {}): void {
    if (this.definitions.has(name)) throw new Error(`Job '${name}' is already defined`);
    this.definitions.set(name, { handler, maxAttempts: options.maxAttempts ?? 5 });
  }

  /** يضيف مهمة. يرجع رقمها، أو null إن كانت مهمة بنفس dedupeKey موجودة. */
  async enqueue(
    name: string,
    payload: Record<string, unknown> = {},
    options: { runAt?: Date; dedupeKey?: string; db?: Queryable } = {}
  ): Promise<string | null> {
    const maxAttempts = this.definitions.get(name)?.maxAttempts ?? 5;
    const { rows } = await (options.db ?? this.pool).query<{ id: string }>(
      `INSERT INTO jobs (name, payload, run_at, dedupe_key, max_attempts)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text AS id`,
      [name, JSON.stringify(payload), options.runAt ?? null, options.dedupeKey ?? null, maxAttempts]
    );
    return rows[0]?.id ?? null;
  }

  /** مهمة دورية كل everyMs ملي ثانية. يجب أن تكون معرّفة بـ define. */
  schedule(name: string, everyMs: number, payload: Record<string, unknown> = {}): void {
    if (everyMs < 1000) throw new Error(`Job '${name}': the schedule interval must be at least 1000 ms`);
    this.schedules.push({ name, everyMs, payload, lastBucket: -1 });
  }

  /** يضيف المهام الدورية التي حان وقتها (يستدعيه العامل في كل دورة). */
  async enqueueDueSchedules(now = Date.now()): Promise<void> {
    for (const s of this.schedules) {
      const bucket = Math.floor(now / s.everyMs);
      if (bucket === s.lastBucket) continue;
      await this.enqueue(s.name, s.payload, { dedupeKey: `${s.name}@${bucket}` });
      s.lastBucket = bucket;
    }
  }

  /** يأخذ حتى limit مهمة حان وقتها وينفّذها. يرجع عدد ما نفّذه. */
  async processBatch(limit = 10): Promise<number> {
    const { rows } = await this.pool.query<ClaimedJob>(
      `UPDATE jobs SET locked_until = now() + make_interval(secs => $2), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
           WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= now()
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY run_at, id LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, name, payload, attempts, max_attempts`,
      [limit, this.leaseSeconds]
    );
    for (const job of rows) await this.run(job);
    return rows.length;
  }

  private async run(job: ClaimedJob): Promise<void> {
    const definition = this.definitions.get(job.name);
    try {
      if (!definition) throw new Error(`No handler is defined for job '${job.name}' in this instance`);
      await definition.handler(job.payload, {
        jobId: job.id,
        attempt: job.attempts,
        logger: this.logger.child({ job: job.name, jobId: job.id }),
      });
      await this.pool.query("UPDATE jobs SET done_at = now(), locked_until = NULL WHERE id = $1", [job.id]);
      this.processed?.inc({ name: job.name, result: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= job.max_attempts) {
        await this.pool.query("UPDATE jobs SET dead_at = now(), locked_until = NULL, last_error = $2 WHERE id = $1", [
          job.id,
          message,
        ]);
        this.processed?.inc({ name: job.name, result: "dead" });
        this.logger.error(`Job '${job.name}' gave up after ${job.attempts} attempts`, { jobId: job.id, message });
      } else {
        const delay = Math.min(3600, 5 * 2 ** job.attempts);
        await this.pool.query(
          `UPDATE jobs SET run_at = now() + make_interval(secs => $3), locked_until = NULL, last_error = $2 WHERE id = $1`,
          [job.id, message, delay]
        );
        this.processed?.inc({ name: job.name, result: "retry" });
        this.logger.warn(`Job '${job.name}' failed, will retry`, { jobId: job.id, attempt: job.attempts, message });
      }
    }
  }
}
