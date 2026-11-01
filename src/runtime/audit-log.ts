import type { Pool } from "pg";
import type { AuditEntry, AuditSink } from "../middleware/audit";
import type { ListPage } from "../db/repository";

/** سطر في سجل التدقيق كما يرد في الـ API. */
export interface AuditRecord {
  id: number;
  at: Date;
  actorType: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  route: string | null;
  path: string;
  params: Record<string, string>;
  statusCode: number;
  requestId: string | null;
  ip: string | null;
  body: unknown;
}

interface AuditRow {
  id: number;
  at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  route: string | null;
  path: string;
  params: Record<string, string>;
  status_code: number;
  request_id: string | null;
  ip: string | null;
  body: unknown;
}

/**
 * سجل التدقيق في جدول audit_log: من فعل ماذا، ومتى، ومن أين، وبأي نتيجة.
 * الكتابة تأتي من middleware/audit.ts (تلقائياً لكل كتابة من المالك أو موظف)، أو من الوحدات
 * مباشرة لأحداث أمنية لا تمر بمسار كتابة عادي (مثل دخول موظف ناجح أو فاشل).
 */
export class AuditLog implements AuditSink {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, actor_role, action, route, path, params, status_code, request_id, ip, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.actorRole,
        entry.action,
        entry.route ?? null,
        entry.path,
        JSON.stringify(entry.params ?? {}),
        entry.statusCode,
        entry.requestId ?? null,
        entry.ip ?? null,
        entry.body === undefined ? null : JSON.stringify(entry.body),
      ]
    );
  }

  /** صفحة من السجل، الأحدث أولاً، مع تصفية اختيارية بالفاعل أو بالعملية. */
  async list(filter: { actorId?: string; action?: string; limit: number; offset: number }): Promise<ListPage<AuditRecord>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.actorId) {
      values.push(filter.actorId);
      where.push(`actor_id = $${values.length}`);
    }
    if (filter.action) {
      values.push(`${filter.action}%`);
      where.push(`action LIKE $${values.length}`);
    }
    values.push(filter.limit, filter.offset);
    const { rows } = await this.pool.query<AuditRow & { total: number }>(
      `SELECT *, COUNT(*) OVER() AS total FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        action: r.action,
        route: r.route,
        path: r.path,
        params: r.params,
        statusCode: r.status_code,
        requestId: r.request_id,
        ip: r.ip,
        body: r.body,
      })),
    };
  }
}
