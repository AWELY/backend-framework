import type { Pool } from "pg";
import type { Queryable } from "../db/repository";
import { isUuid } from "../db/ids";
import { signToken, type TokenPayload } from "../engine/auth-token";
import type { SessionVerifier } from "../middleware/auth";

/** نوع صاحب الجلسة. */
export type PrincipalType = "customer" | "staff";

/**
 * يعرف الدور الحالي لصاحب جلسة، أو null إن لم يعد مسموحاً له الدخول (حساب موقوف).
 * وحدة الموظفين تسجّل واحداً لنوع "staff" يقرأ الدور و is_active من جدولها.
 */
export type PrincipalResolver = (principalId: string, db: Queryable) => Promise<string | null>;

/** ما يرجع بعد إنشاء جلسة: التوكن الذي يرسله العميل، ورقم الجلسة، ووقت انتهائها. */
export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * جلسات الدخول (جدول auth_sessions)، وراء التوكنات الموقّعة.
 *
 * كل دخول ناجح يُنشئ صفاً هنا، والتوكن يحمل رقمه (sid). مع كل طلب، تتأكد المصادقة
 * (middleware/auth.ts عبر verify) أن الصف موجود ولم يُلغَ ولم ينتهِ. هكذا نحصل على الاثنين:
 *   - التوكن الموقّع يمنع التزوير دون أي استعلام.
 *   - الجلسة في القاعدة تسمح بالإلغاء الفوري: تسجيل الخروج، أو "اخرج من كل الأجهزة"، أو تغيير
 *     كلمة المرور، أو إيقاف موظف. التوكنات وحدها (Stateless) لا تستطيع هذا قبل انتهاء مدتها.
 * الثمن: استعلام بالمفتاح الأساسي لكل طلب مصادَق (أقل من ملي ثانية).
 */
export class SessionManager implements SessionVerifier {
  private readonly resolvers = new Map<PrincipalType, PrincipalResolver>([["customer", async () => "customer"]]);

  constructor(
    private readonly pool: Pool,
    private readonly options: { secret: string; ttlSeconds: number }
  ) {}

  /** يسجّل من يعرف دور نوع معين من الحسابات (تستدعيه وحدة الموظفين عند الإقلاع). */
  registerPrincipal(type: PrincipalType, resolver: PrincipalResolver): void {
    this.resolvers.set(type, resolver);
  }

  /** ينشئ جلسة ويصدر توكنها. db: اتصال معاملة إن كان الدخول جزءاً من معاملة أكبر. */
  async issue(
    principal: { type: PrincipalType; id: string; role: string },
    meta: { ip?: string; userAgent?: string } = {},
    db: Queryable = this.pool
  ): Promise<IssuedSession> {
    const { rows } = await db.query<{ id: string; expires_at: Date }>(
      `INSERT INTO auth_sessions (principal_type, principal_id, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5) RETURNING id, expires_at`,
      [principal.type, principal.id, this.options.ttlSeconds, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null]
    );
    const row = rows[0] as { id: string; expires_at: Date };
    const token = signToken(
      { sub: principal.id, role: principal.role, sid: row.id, pt: principal.type },
      this.options.secret,
      this.options.ttlSeconds
    );
    return { token, sessionId: row.id, expiresAt: row.expires_at };
  }

  /** للمصادقة: هل جلسة هذا التوكن سارية؟ ويرجع الدور الحالي. */
  async verify(payload: TokenPayload): Promise<{ role: string } | null> {
    if (!payload.sid || !isUuid(payload.sid) || !isUuid(payload.sub)) return null;
    const type: PrincipalType = payload.pt ?? "customer";
    const { rows } = await this.pool.query(
      `SELECT 1 FROM auth_sessions
        WHERE id = $1 AND principal_type = $2 AND principal_id = $3
          AND revoked_at IS NULL AND expires_at > now()`,
      [payload.sid, type, payload.sub]
    );
    if (rows.length === 0) return null;
    const resolver = this.resolvers.get(type);
    const role = resolver ? await resolver(payload.sub, this.pool) : null;
    return role ? { role } : null;
  }

  /** يلغي جلسة واحدة (تسجيل الخروج من هذا الجهاز). */
  async revoke(sessionId: string, db: Queryable = this.pool): Promise<void> {
    if (!isUuid(sessionId)) return;
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
  }

  /**
   * يلغي كل جلسات حساب، ما عدا exceptSessionId إن مُرّر (مثلاً: بعد تغيير كلمة المرور يبقى
   * الجهاز الحالي داخلاً، وتخرج كل الأجهزة الأخرى). يرجع عدد الجلسات الملغاة.
   */
  async revokeAll(
    type: PrincipalType,
    principalId: string,
    options: { exceptSessionId?: string; db?: Queryable } = {}
  ): Promise<number> {
    const result = await (options.db ?? this.pool).query(
      `UPDATE auth_sessions SET revoked_at = now()
        WHERE principal_type = $1 AND principal_id = $2 AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [type, principalId, options.exceptSessionId ?? null]
    );
    return result.rowCount ?? 0;
  }

  /** جلسات حساب السارية (لصفحة "أجهزتي"). */
  async list(type: PrincipalType, principalId: string) {
    const { rows } = await this.pool.query<{ id: string; created_at: Date; expires_at: Date; ip: string | null; user_agent: string | null }>(
      `SELECT id, created_at, expires_at, ip, user_agent FROM auth_sessions
        WHERE principal_type = $1 AND principal_id = $2 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [type, principalId]
    );
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent }));
  }
}
