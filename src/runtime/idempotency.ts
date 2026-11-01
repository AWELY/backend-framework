import type { Queryable } from "../db/repository";
import type { IdempotencyStore, IdempotencyBegin } from "../middleware/idempotency";

/**
 * مخزن مفاتيح Idempotency-Key في جدول idempotency_keys. المنطق في middleware/idempotency.ts،
 * وهنا التخزين فقط.
 *
 * الحجز ذري: INSERT ... ON CONFLICT DO NOTHING. طلبان متزامنان بنفس المفتاح: واحد فقط ينجح في
 * الإدراج ويُنفَّذ، والثاني يرى الصف موجوداً فيرد "قيد التنفيذ" (409).
 * مفتاح علق "قيد التنفيذ" أكثر من دقيقة (الخادم توقف في منتصف الطلب) يُعتبر متروكاً، فيأخذه
 * الطلب الجديد. المفاتيح الأقدم من 24 ساعة يحذفها التنظيف الدوري.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Queryable) {}

  async begin(scope: string, key: string, requestHash: string): Promise<IdempotencyBegin> {
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
      [scope, key, requestHash]
    );
    if (inserted.rows.length > 0) return { state: "new" };

    const { rows } = await this.db.query<{
      request_hash: string;
      status_code: number | null;
      response_body: unknown;
      stale: boolean;
    }>(
      `SELECT request_hash, status_code, response_body, (completed_at IS NULL AND created_at < now() - interval '60 seconds') AS stale
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key]
    );
    const row = rows[0];
    // حُذف بين الاستعلامين (تنظيف أو release): نحاول مرة أخرى من البداية.
    if (!row) return this.begin(scope, key, requestHash);
    if (row.request_hash !== requestHash) return { state: "mismatch" };
    if (row.status_code !== null) return { state: "replay", status: row.status_code, body: row.response_body };
    if (row.stale) {
      const taken = await this.db.query(
        `UPDATE idempotency_keys SET created_at = now()
          WHERE scope = $1 AND key = $2 AND completed_at IS NULL AND created_at < now() - interval '60 seconds'
          RETURNING key`,
        [scope, key]
      );
      if (taken.rows.length > 0) return { state: "new" };
    }
    return { state: "in_progress" };
  }

  async complete(scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys SET status_code = $3, response_body = $4, completed_at = now()
        WHERE scope = $1 AND key = $2`,
      [scope, key, status, JSON.stringify(body ?? null)]
    );
  }

  async release(scope: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND completed_at IS NULL", [scope, key]);
  }
}
