import type { Queryable } from "../../db/repository";
import { isUuid } from "../../db/ids";
import { createToken } from "../../container/tokens";
import type { Actor } from "../shared";
import type { OrderEvent, OrderEventType } from "./orders.schema";

interface EventRow {
  id: number;
  at: Date;
  type: OrderEventType;
  from_value: string | null;
  to_value: string | null;
  actor_type: string;
  note: string | null;
}

/**
 * سجل الطلب الزمني (جدول order_events): كل ما حدث للطلب، بالترتيب، ومن فعله.
 * أُنشئ، أُكّد، أُسند لمندوب، استُلم، دُفع، سُلّم، استُرجع جزء منه...
 *
 * صفحة التتبع عند الزبون تعرضه كخط زمني. الكتابة تحدث داخل نفس معاملة التغيير (db)، فلا يظهر
 * في السجل شيء لم يحدث فعلاً. وحدة التوصيل تكتب فيه أيضاً (النوع "delivery").
 *
 * رقم الفاعل (actor_id) يُحفظ للتدقيق، لكنه لا يُرسل للزبون: يرى "المحل" أو "المندوب" لا رقم الموظف.
 */
export class OrderTimeline {
  constructor(private readonly db: Queryable) {}

  async record(
    orderId: string,
    entry: { type: OrderEventType; from?: string | null; to?: string | null; actor: Actor; note?: string | null },
    db: Queryable = this.db
  ): Promise<void> {
    await db.query(
      `INSERT INTO order_events (order_id, type, from_value, to_value, actor_type, actor_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, entry.type, entry.from ?? null, entry.to ?? null, entry.actor.type, entry.actor.id, entry.note ?? null]
    );
  }

  async list(orderId: string): Promise<OrderEvent[]> {
    if (!isUuid(orderId)) return [];
    const { rows } = await this.db.query<EventRow>(
      "SELECT id, at, type, from_value, to_value, actor_type, note FROM order_events WHERE order_id = $1 ORDER BY at, id",
      [orderId]
    );
    return rows.map((r) => ({ id: r.id, at: r.at, type: r.type, from: r.from_value, to: r.to_value, actorType: r.actor_type, note: r.note }));
  }
}

/** رمز السجل الزمني في الحاوية (تطلبه وحدة التوصيل). */
export const ORDER_TIMELINE = createToken<OrderTimeline>("OrderTimeline");
