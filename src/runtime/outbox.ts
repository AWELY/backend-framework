import type { Pool } from "pg";
import type { Queryable } from "../db/repository";
import type { Logger } from "../engine/logger";
import type { MetricsRegistry } from "../engine/metrics";

/** معلومات تصل مع كل حدث إلى المستمع، بجانب بيانات الحدث نفسه. */
export interface EventMeta {
  /** رقم الحدث الفريد. المستمع يستخدمه ليتجاهل حدثاً عالجه من قبل (التسليم "مرة واحدة على الأقل"). */
  id: string;
  /** اسم الحدث، مثل "order.created". */
  event: string;
  /** نسخة شكل البيانات. تزيد فقط إن تغيّر شكل payload بطريقة تكسر المستمعين القدامى. */
  version: number;
  /** متى وقع الحدث (وقت المعاملة التي كتبته، لا وقت التسليم). */
  occurredAt: Date;
  /** رقم محاولة التسليم: 1 أول مرة، وأكبر عند الإعادة بعد فشل. */
  attempt: number;
}

/** مستمع: دالة تستلم بيانات الحدث ومعلوماته. */
export type EventListener = (payload: never, meta: EventMeta) => void | Promise<void>;

/** من يعرف المستمعين المسجلين لكل حدث (ExtensionRegistry في src/modules/extensions.ts). */
export interface ListenerSource {
  listeners(event: string): readonly EventListener[];
}

/** نسخة شكل البيانات الحالية لكل الأحداث. */
export const EVENT_VERSION = 1;

/**
 * يعيد التواريخ إلى كائنات Date بعد قراءة JSON من القاعدة: JSON لا يعرف التاريخ، فيحفظه نصاً.
 * أي حقل اسمه ينتهي بـ "At" (createdAt، updatedAt، expiresAt...) وقيمته تاريخ ISO يعود Date،
 * فيستلم المستمع نفس الأنواع التي تعدها الواجهة (Order.createdAt من نوع Date).
 */
export function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] =
      key.endsWith("At") && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : reviveDates(v);
  }
  return out;
}

interface ClaimedRow {
  id: string;
  event: string;
  payload: unknown;
  created_at: Date;
  attempts: number;
  completed_listeners: number[];
}

/**
 * صندوق الصادر (Transactional outbox): كيف نضمن أن الحدث يصل، دون أن نُبطئ الطلب.
 *
 * المشكلة القديمة: إتمام الشراء كان يطلق "order.created" بعد COMMIT مباشرة، داخل الطلب نفسه.
 *   - لو توقف الخادم بين COMMIT وإطلاق الحدث، ضاع الحدث للأبد (لا رسالة للزبون، ولا إشعار للمحل).
 *   - ومستمع بطيء (إرسال بريد يأخذ 3 ثوانٍ) كان يؤخر رد الشراء 3 ثوانٍ.
 *
 * الحل:
 *   1. publish يكتب الحدث صفاً في جدول outbox_events، بنفس اتصال المعاملة التي غيّرت البيانات.
 *      الاثنان يُحفظان معاً أو يُلغيان معاً: لا طلب بلا حدث، ولا حدث لطلب أُلغي.
 *   2. العامل في الخلفية (worker.ts) يأخذ الأحداث الجاهزة ويوصلها للمستمعين، خارج أي طلب.
 *
 * الضمانات:
 *   - مرة واحدة على الأقل (At-least-once): الحدث لا يضيع، لكنه قد يصل مستمعاً مرتين في حالة
 *     نادرة (توقف الخادم بعد نجاح المستمع وقبل تسجيل نجاحه). لذلك على المستمع أن يتحمل التكرار،
 *     مستخدماً meta.id. هذا الثمن المعروف لكل نظام رسائل موثوق.
 *   - كل مستمع مستقل: إن فشل الثاني من ثلاثة، تُعاد المحاولة له وحده لاحقاً (completed_listeners)،
 *     ولا يُعاد تشغيل الأول والثالث.
 *   - الإعادة بانتظار متزايد (2، 4، 8... ثوانٍ حتى ساعة)، وبعد maxAttempts يصبح الحدث "ميتاً"
 *     (dead_at) ويُسجَّل خطأً، ليراجعه أحد بدل أن يُعاد للأبد.
 *   - عدة نسخ خادم آمنة: كل نسخة "تستأجر" أحداثاً (locked_until) بـ FOR UPDATE SKIP LOCKED، فلا
 *     تأخذ نسختان نفس الحدث.
 *   - الأحداث الحساسة (sensitive، مثل رابط استعادة كلمة المرور) تُمسح بياناتها بعد التسليم.
 *
 * الترتيب ليس مضموناً بين الأحداث (نسختان قد تسلّمان حدثين متتاليين بالتوازي).
 * القرار والبدائل في docs/adr/0007-transactional-outbox.md.
 */
export class EventOutbox<Events extends object = Record<string, unknown>> {
  private readonly maxAttempts: number;
  private readonly leaseSeconds: number;
  private readonly delivered;

  constructor(
    private readonly pool: Pool,
    private readonly source: ListenerSource,
    private readonly logger: Logger,
    metrics?: MetricsRegistry,
    options: { maxAttempts?: number; leaseSeconds?: number } = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? 10;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.delivered = metrics?.counter("outbox_events_total", "Outbox events handled, by event and result");
  }

  /**
   * يكتب حدثاً. db يجب أن يكون اتصال المعاملة التي غيّرت البيانات، ليُحفظا معاً.
   * يرجع رقم الحدث.
   */
  async publish<E extends keyof Events & string>(
    db: Queryable,
    event: E,
    payload: Events[E],
    options: { sensitive?: boolean } = {}
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO outbox_events (event, payload, sensitive) VALUES ($1, $2, $3) RETURNING id::text AS id",
      [event, JSON.stringify(payload), options.sensitive ?? false]
    );
    return (rows[0] as { id: string }).id;
  }

  /** يأخذ حتى limit حدثاً جاهزاً ويوصلها. يرجع عدد الأحداث التي عالجها. */
  async processBatch(limit = 20): Promise<number> {
    const { rows } = await this.pool.query<ClaimedRow>(
      `UPDATE outbox_events SET locked_until = now() + make_interval(secs => $2), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE processed_at IS NULL AND dead_at IS NULL AND available_at <= now()
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY id LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, event, payload, created_at, attempts, completed_listeners`,
      [limit, this.leaseSeconds]
    );
    for (const row of rows) await this.deliver(row);
    return rows.length;
  }

  /** يوصل حدثاً واحداً لكل مستمع لم ينجح معه بعد، ثم يسجّل النتيجة. */
  private async deliver(row: ClaimedRow): Promise<void> {
    const listeners = this.source.listeners(row.event);
    const completed = new Set(row.completed_listeners);
    const meta: EventMeta = {
      id: row.id,
      event: row.event,
      version: EVENT_VERSION,
      occurredAt: row.created_at,
      attempt: row.attempts,
    };
    const payload = reviveDates(row.payload);
    let lastError: string | null = null;

    for (let i = 0; i < listeners.length; i++) {
      if (completed.has(i)) continue;
      try {
        await (listeners[i] as (p: unknown, m: EventMeta) => unknown)(payload, meta);
        completed.add(i);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Listener #${i} for '${row.event}' failed`, { eventId: row.id, attempt: row.attempts, message: lastError });
      }
    }

    const done = [...completed];
    if (lastError === null) {
      await this.pool.query(
        `UPDATE outbox_events SET processed_at = now(), locked_until = NULL, completed_listeners = $2,
                payload = CASE WHEN sensitive THEN NULL ELSE payload END
          WHERE id = $1`,
        [row.id, done]
      );
      this.delivered?.inc({ event: row.event, result: "delivered" });
    } else if (row.attempts >= this.maxAttempts) {
      await this.pool.query(
        `UPDATE outbox_events SET dead_at = now(), locked_until = NULL, completed_listeners = $2, last_error = $3,
                payload = CASE WHEN sensitive THEN NULL ELSE payload END
          WHERE id = $1`,
        [row.id, done, lastError]
      );
      this.delivered?.inc({ event: row.event, result: "dead" });
      this.logger.error(`Event '${row.event}' gave up after ${row.attempts} attempts`, { eventId: row.id, message: lastError });
    } else {
      // انتظار متزايد: 2^المحاولة ثانية، بحد أقصى ساعة.
      const delay = Math.min(3600, 2 ** row.attempts);
      await this.pool.query(
        `UPDATE outbox_events SET available_at = now() + make_interval(secs => $4), locked_until = NULL,
                completed_listeners = $2, last_error = $3
          WHERE id = $1`,
        [row.id, done, lastError, delay]
      );
      this.delivered?.inc({ event: row.event, result: "retry" });
    }
  }
}
